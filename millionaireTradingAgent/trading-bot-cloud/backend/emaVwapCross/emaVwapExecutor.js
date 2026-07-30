import { placeOptionOrder } from '../brokerageConnector.js';
import { ladderPositionSize } from '../ladder/ladderSizing.js';
import {
  EMA_VWAP_MAX_POSITIONS,
  EMA_VWAP_SYMBOLS,
  EMA_VWAP_MIN_ENTRY_PREMIUM,
  EMA_VWAP_STOP_LOSS_PCT,
} from './emaVwapConfig.js';
import {
  getEmaVwapMode,
  getEmaVwapBudgetRemaining,
  getEmaVwapOpenPositionCount,
  insertEmaVwapPosition,
  updateEmaVwapPositionBrokerStop,
  getEmaVwapSymbolState,
  upsertEmaVwapSymbolState,
  hasEmaVwapCrossExecutedToday,
} from './emaVwapDb.js';
import { getTotalAllocated } from '../budget/budgetAllocations.js';
import { getStrategyEnvironment } from '../strategyEnvironment.js';
import { createLadderBrokerStopHandlers } from '../ladder/ladderStopOrders.js';
import { selectEmaVwapStrike } from './emaVwapStrikeSelector.js';
import {
  sendEmaVwapTradeOpenedTelegram,
  sendEmaVwapSignalNotExecutedTelegram,
  sendEmaVwapBudgetExhaustedTelegram,
  sendEmaVwapInsufficientBudgetTelegram,
} from './emaVwapTelegram.js';
import {
  getFiveMinuteBars,
  etDateKey,
  isWithinOrbSession,
  barEtMinutes,
} from '../orb/tradierTimesales.js';
import { computeSessionIndicators } from './emaVwapIndicators.js';
import { evaluateEmaVwapSignals, parseFsm } from './emaVwapSignalEngine.js';
import { isPremiumBelowFloor } from '../zeroDte/entryGuards.js';
import { checkLiveEntryGate } from '../budget/liveEntryGate.js';
import {
  getStopLossReentryCooldown,
  formatCooldownRemaining,
  STOP_LOSS_REENTRY_COOLDOWN_MS,
} from '../entryCooldown.js';

function isSessionBar(bar) {
  const mins = barEtMinutes(bar);
  if (mins == null) return false;
  return mins >= 9 * 60 + 30 && mins < 15 * 60 + 5;
}

function filterNewBars(bars, lastProcessedTime) {
  if (!lastProcessedTime) return bars;
  return bars.filter((b) => b.time > lastProcessedTime);
}

/** More than ~1 poll interval behind — replay FSM without executing historical entries. */
function isCatchUpReplay(lastProcessedTime, newBars) {
  if (newBars.length === 0) return false;
  if (!lastProcessedTime) return newBars.length > 1;
  return newBars.length > 2;
}

/** Uniquely identifies the 5-min bar where the EMA/VWAP cross fired. */
function crossIdempotencyKey(entry, tradeDate) {
  const crossBarTime = entry.cross_candle?.time;
  return `${entry.symbol}:${entry.direction}:${crossBarTime}:${tradeDate}`;
}

async function shouldSkipDuplicateCross(entry, tradeDate, seenThisCycle) {
  const crossBarTime = entry.cross_candle?.time;
  if (!crossBarTime) return false;

  const key = crossIdempotencyKey(entry, tradeDate);
  if (seenThisCycle.has(key)) {
    console.log(
      `[EMA/VWAP] Skipping duplicate entry (same poll cycle) for ${entry.symbol} ${entry.direction} cross_bar_time=${crossBarTime}`
    );
    return true;
  }

  const alreadyExecuted = await hasEmaVwapCrossExecutedToday({
    ticker: entry.symbol,
    direction: entry.direction,
    crossBarTime,
    tradeDate,
  });
  if (alreadyExecuted) {
    console.log(
      `[EMA/VWAP] Skipping duplicate entry (already executed today) for ${entry.symbol} ${entry.direction} cross_bar_time=${crossBarTime}`
    );
    return true;
  }

  return false;
}

function evaluateEmaVwapWithCatchUp(symbol, fsm, newBars) {
  const lastProcessed = fsm.last_processed_bar_time;
  const catchUp = isCatchUpReplay(lastProcessed, newBars);

  if (!catchUp) {
    const { fsm: updatedFsm, entries } = evaluateEmaVwapSignals(symbol, newBars, fsm);
    return {
      catchUp: false,
      suppressedEntryCount: 0,
      replayBarCount: newBars.length,
      fsm: updatedFsm,
      entries,
    };
  }

  const replayBars = newBars.length > 1 ? newBars.slice(0, -1) : [];
  const liveBars = newBars.slice(-1);
  let state = fsm;
  let suppressedEntryCount = 0;

  if (replayBars.length > 0) {
    const replay = evaluateEmaVwapSignals(symbol, replayBars, state);
    state = replay.fsm;
    suppressedEntryCount += replay.entries.length;
  }

  const live = evaluateEmaVwapSignals(symbol, liveBars, state);

  return {
    catchUp: true,
    suppressedEntryCount,
    replayBarCount: replayBars.length,
    fsm: live.fsm,
    entries: live.entries,
  };
}

function positionSize(budgetRemaining, openCount, premium) {
  const slots = EMA_VWAP_MAX_POSITIONS - openCount;
  if (slots <= 0 || budgetRemaining <= 0) {
    return {
      quantity: 0,
      totalCost: 0,
      requiredCost: premium * 100,
      affordable: false,
      perSlot: 0,
      slots: Math.max(0, slots),
    };
  }

  // Affordability is judged against perSlot, not total remaining.
  const perSlot = budgetRemaining / slots;
  return { ...ladderPositionSize(perSlot, premium), perSlot, slots };
}

async function loadSymbolFsm(symbol, tradeDate) {
  const row = await getEmaVwapSymbolState(symbol, tradeDate);
  return parseFsm(row?.fsm_json);
}

async function tryExecuteEntry(entry) {
  const mode = await getEmaVwapMode();
  if (mode === 'MANUAL') {
    await sendEmaVwapSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: 'Bot is in MANUAL mode — awaiting approval',
    });
    return { executed: false, reason: 'manual_mode' };
  }

  const liveGate = await checkLiveEntryGate('emavwap');
  if (!liveGate.allowed) {
    console.log(`[EMA/VWAP] ${liveGate.reason} — blocking entry for ${entry.symbol}`);
    await sendEmaVwapSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: 'Live daily loss limit reached (30%) — new entries blocked for today',
    });
    return { executed: false, reason: liveGate.reason };
  }

  const cooldown = await getStopLossReentryCooldown({
    strategy: 'emavwap',
    ticker: entry.symbol,
    direction: entry.direction,
  });
  if (cooldown.blocked) {
    const left = formatCooldownRemaining(cooldown.remainingMs);
    console.log(
      `[EMA/VWAP] Stop-loss cooldown (${STOP_LOSS_REENTRY_COOLDOWN_MS / 60000}m) — ` +
        `skipping ${entry.symbol} ${entry.direction} (${left} remaining)`
    );
    await sendEmaVwapSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: `Stop-loss cooldown — ${left} remaining before re-entry`,
    });
    return { executed: false, reason: 'stop_loss_cooldown' };
  }

  const openCount = await getEmaVwapOpenPositionCount();
  if (openCount >= EMA_VWAP_MAX_POSITIONS) {
    await sendEmaVwapSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: 'Max open EMA/VWAP positions (3) reached',
    });
    return { executed: false, reason: 'max_positions' };
  }

  const budgetRemaining = await getEmaVwapBudgetRemaining();
  if (budgetRemaining <= 0) {
    await sendEmaVwapBudgetExhaustedTelegram(await getTotalAllocated('emavwap'));
    return { executed: false, reason: 'budget_exhausted' };
  }

  let strikeSelection;
  try {
    strikeSelection = await selectEmaVwapStrike(entry);
  } catch (err) {
    console.error(`[EMA/VWAP] Strike selection failed for ${entry.symbol}:`, err.message);
    await sendEmaVwapSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: err.message,
    });
    return { executed: false, reason: 'strike_error' };
  }

  if (isPremiumBelowFloor(strikeSelection.premium, EMA_VWAP_MIN_ENTRY_PREMIUM)) {
    const floorLabel =
      EMA_VWAP_MIN_ENTRY_PREMIUM != null
        ? `$${EMA_VWAP_MIN_ENTRY_PREMIUM}`
        : 'EMA_VWAP_MIN_ENTRY_PREMIUM (not set)';
    await sendEmaVwapSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: `Entry premium $${strikeSelection.premium} below minimum floor (${floorLabel})`,
    });
    return { executed: false, reason: 'premium_below_floor' };
  }

  const sizing = positionSize(budgetRemaining, openCount, strikeSelection.premium);
  if (!sizing.affordable || sizing.quantity < 1 || sizing.totalCost > budgetRemaining) {
    await sendEmaVwapInsufficientBudgetTelegram({
      ticker: entry.symbol,
      requiredCost: sizing.requiredCost,
      budgetRemaining,
      perSlot: sizing.perSlot,
      slots: sizing.slots,
    });
    return { executed: false, reason: 'budget_exhausted' };
  }

  try {
    const environment = await getStrategyEnvironment('emavwap');
    const order = await placeOptionOrder({
      ticker: strikeSelection.symbol,
      direction: strikeSelection.direction,
      strike: strikeSelection.strike,
      expiration: strikeSelection.expiration,
      quantity: sizing.quantity,
      premium: strikeSelection.premium,
      environment,
      strategy: 'emavwap',
    });

    const positionId = await insertEmaVwapPosition({
      ticker: strikeSelection.symbol,
      direction: strikeSelection.direction,
      strike: strikeSelection.strike,
      expiration: strikeSelection.expiration,
      entry_premium: strikeSelection.premium,
      quantity: sizing.quantity,
      order_id: order.orderId,
      broker: order.broker || 'tastytrade',
      entry_contracts: sizing.entryContracts,
      pyramid_tier: 'ladder',
      vwap_at_entry: entry.vwap_at_entry,
      ema_at_entry: entry.ema_at_entry,
      cross_direction: entry.cross_direction,
      cross_candle_json: JSON.stringify(entry.cross_candle),
      strike_bucket: strikeSelection.strike_bucket,
      entry_iv: strikeSelection.entry_iv,
      entry_delta: strikeSelection.entry_delta,
      entry_metadata_json: JSON.stringify({
        ema_vwap_gap: entry.ema_vwap_gap,
        spot: strikeSelection.spot,
      }),
    });

    const brokerStop = createLadderBrokerStopHandlers({
      strategy: 'emavwap',
      environment,
      initialStopPct: EMA_VWAP_STOP_LOSS_PCT,
      updateBrokerStopState: updateEmaVwapPositionBrokerStop,
      fullClosePosition: async () => null,
    });
    await brokerStop.placeInitialStop({
      id: positionId,
      ticker: strikeSelection.symbol,
      direction: strikeSelection.direction,
      strike: strikeSelection.strike,
      expiration: strikeSelection.expiration,
      entry_premium: strikeSelection.premium,
      quantity: sizing.quantity,
      contracts_open: sizing.quantity,
      exit_phase: 'LADDER:0',
      trail_peak_pnl_frac: 0,
    });

    console.log(
      `[EMA/VWAP] Opened ${strikeSelection.symbol} qty=${sizing.quantity} ladder entry_contracts=${sizing.entryContracts}`
    );

    await sendEmaVwapTradeOpenedTelegram({
      ticker: strikeSelection.symbol,
      direction: strikeSelection.direction,
      premium: strikeSelection.premium,
      paper: order.paper,
      strike: strikeSelection.strike,
      strikeBucket: strikeSelection.strike_bucket,
    });

    return { executed: true, order, strikeSelection };
  } catch (err) {
    console.error(`[EMA/VWAP] Order failed for ${entry.symbol}:`, err.message);
    await sendEmaVwapSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: err.message,
    });
    return { executed: false, reason: 'execution_error', error: err.message };
  }
}

export async function runEmaVwapScanAndExecute() {
  if (!isWithinOrbSession()) {
    return { skipped: true, reason: 'outside_emavwap_session' };
  }

  const tradeDate = etDateKey();
  const results = [];

  for (const symbol of EMA_VWAP_SYMBOLS) {
    try {
      const bars = await getFiveMinuteBars(symbol, tradeDate);
      const sessionBars = bars.filter(isSessionBar);
      const enriched = computeSessionIndicators(sessionBars);

      let fsm = await loadSymbolFsm(symbol, tradeDate);
      const newBars = filterNewBars(enriched, fsm.last_processed_bar_time);

      let updatedFsm = fsm;
      let entries = [];

      if (newBars.length > 0) {
        const {
          catchUp,
          suppressedEntryCount,
          replayBarCount,
          fsm: nextFsm,
          entries: liveEntries,
        } = evaluateEmaVwapWithCatchUp(symbol, fsm, newBars);

        updatedFsm = nextFsm;
        entries = liveEntries;

        if (catchUp) {
          console.log(
            `[EMA/VWAP] Catch-up replay for ${symbol}: ${replayBarCount} historical bar(s) processed without execution, ${suppressedEntryCount} entry signal(s) suppressed`
          );
        }
      }

      await upsertEmaVwapSymbolState({
        symbol,
        tradeDate,
        fsmJson: updatedFsm,
      });

      const seenCrossKeys = new Set();

      for (const entry of entries) {
        if (await shouldSkipDuplicateCross(entry, tradeDate, seenCrossKeys)) {
          continue;
        }

        const result = await tryExecuteEntry(entry);
        if (result.executed) {
          seenCrossKeys.add(crossIdempotencyKey(entry, tradeDate));
        }
        results.push({ symbol, ...result });
      }
    } catch (err) {
      console.error(`[EMA/VWAP] Scan failed for ${symbol}:`, err.message);
      results.push({ symbol, executed: false, reason: 'scan_error', error: err.message });
    }
  }

  return { skipped: false, results };
}
