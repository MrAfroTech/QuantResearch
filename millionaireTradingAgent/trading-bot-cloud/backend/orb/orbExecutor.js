import { placeOptionOrder } from '../brokerageConnector.js';
import { ladderPositionSize } from '../ladder/ladderSizing.js';
import {
  getOrbMaxPositions,
  ORB_SYMBOLS,
  ORB_MIN_ENTRY_PREMIUM,
  ORB_STOP_LOSS_PCT,
} from './orbConfig.js';
import {
  getOrbMode,
  getOrbBudgetRemaining,
  getOrbOpenPositionCount,
  insertOrbPosition,
  updateOrbPositionBrokerStop,
  hasOrbBreakoutExecutedToday,
} from './orbDb.js';
import { getTotalAllocated } from '../budget/budgetAllocations.js';
import { getStrategyEnvironment } from '../strategyEnvironment.js';
import { createLadderBrokerStopHandlers } from '../ladder/ladderStopOrders.js';
import { selectOrbStrike } from './orbStrikeSelector.js';
import {
  sendOrbTradeOpenedTelegram,
  sendOrbSignalNotExecutedTelegram,
  sendOrbBudgetExhaustedTelegram,
  sendOrbInsufficientBudgetTelegram,
} from './orbTelegram.js';
import {
  getFiveMinuteBars,
  etDateKey,
  isWithinOrbSession,
  isAfterRangeEnd,
} from './tradierTimesales.js';
import {
  updateOpeningRange,
  loadSymbolRangeState,
  persistSymbolRangeState,
  getPostRangeBars,
} from './orbRangeState.js';
import { evaluateOrbSignals, persistInvalidationEvents } from './orbSignalEngine.js';
import { isPremiumBelowFloor } from '../zeroDte/entryGuards.js';
import { checkLiveEntryGate } from '../budget/liveEntryGate.js';
import {
  getStopLossReentryCooldown,
  formatCooldownRemaining,
  STOP_LOSS_REENTRY_COOLDOWN_MS,
} from '../entryCooldown.js';

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

function breakoutIdempotencyKey(entry, tradeDate) {
  return `${entry.symbol}:${entry.direction}:${Number(entry.breakout_level)}:${tradeDate}`;
}

async function shouldSkipDuplicateBreakout(entry, tradeDate, seenThisCycle) {
  const key = breakoutIdempotencyKey(entry, tradeDate);
  if (seenThisCycle.has(key)) {
    console.log(
      `[ORB] Skipping duplicate entry (same poll cycle) for ${entry.symbol} ${entry.direction} breakout_level=${entry.breakout_level}`
    );
    return true;
  }

  const alreadyExecuted = await hasOrbBreakoutExecutedToday({
    ticker: entry.symbol,
    direction: entry.direction,
    breakoutLevel: entry.breakout_level,
    tradeDate,
  });
  if (alreadyExecuted) {
    console.log(
      `[ORB] Skipping duplicate entry (already executed today) for ${entry.symbol} ${entry.direction} breakout_level=${entry.breakout_level}`
    );
    return true;
  }

  return false;
}

function evaluateWithCatchUp(rangeState, newBars) {
  const lastProcessed = rangeState.fsm.last_processed_bar_time;
  const catchUp = isCatchUpReplay(lastProcessed, newBars);

  if (!catchUp) {
    return {
      catchUp: false,
      suppressedEntryCount: 0,
      replayBarCount: newBars.length,
      ...evaluateOrbSignals(rangeState, newBars),
    };
  }

  const replayBars = newBars.length > 1 ? newBars.slice(0, -1) : [];
  const liveBars = newBars.slice(-1);
  let state = rangeState;
  const events = [];
  let suppressedEntryCount = 0;

  if (replayBars.length > 0) {
    const replay = evaluateOrbSignals(state, replayBars);
    state = replay.rangeState;
    events.push(...replay.events);
    suppressedEntryCount += replay.entries.length;
  }

  const live = evaluateOrbSignals(state, liveBars);
  events.push(...live.events);

  return {
    catchUp: true,
    suppressedEntryCount,
    replayBarCount: replayBars.length,
    rangeState: live.rangeState,
    events,
    entries: live.entries,
  };
}

function positionSize(budgetRemaining, openCount, premium, maxPositions) {
  const slots = maxPositions - openCount;
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

  // Cap and budget are independent: slots come from env-aware maxPositions;
  // budgetRemaining is already the strategy's live-split or paper remaining.
  // Affordability is judged against perSlot, not total remaining.
  const perSlot = budgetRemaining / slots;
  return { ...ladderPositionSize(perSlot, premium), perSlot, slots };
}

async function tryExecuteEntry(entry) {
  const orbMode = await getOrbMode();
  if (orbMode === 'MANUAL') {
    await sendOrbSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: 'Bot is in MANUAL mode — awaiting approval',
    });
    return { executed: false, reason: 'manual_mode' };
  }

  const liveGate = await checkLiveEntryGate('orb');
  if (!liveGate.allowed) {
    console.log(`[ORB] ${liveGate.reason} — blocking entry for ${entry.symbol}`);
    await sendOrbSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: 'Live daily loss limit reached (30%) — new entries blocked for today',
    });
    return { executed: false, reason: liveGate.reason };
  }

  const cooldown = await getStopLossReentryCooldown({
    strategy: 'orb',
    ticker: entry.symbol,
    direction: entry.direction,
  });
  if (cooldown.blocked) {
    const left = formatCooldownRemaining(cooldown.remainingMs);
    console.log(
      `[ORB] Stop-loss cooldown (${STOP_LOSS_REENTRY_COOLDOWN_MS / 60000}m) — ` +
        `skipping ${entry.symbol} ${entry.direction} (${left} remaining)`
    );
    await sendOrbSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: `Stop-loss cooldown — ${left} remaining before re-entry`,
    });
    return { executed: false, reason: 'stop_loss_cooldown' };
  }

  const environment = await getStrategyEnvironment('orb');
  const maxPositions = getOrbMaxPositions(environment);

  const openCount = await getOrbOpenPositionCount();
  if (openCount >= maxPositions) {
    await sendOrbSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: `Max open ORB positions (${maxPositions}) reached [${environment}]`,
    });
    return { executed: false, reason: 'max_positions' };
  }

  const budgetRemaining = await getOrbBudgetRemaining();
  if (budgetRemaining <= 0) {
    await sendOrbBudgetExhaustedTelegram(await getTotalAllocated('orb'));
    return { executed: false, reason: 'budget_exhausted' };
  }

  let strikeSelection;
  try {
    strikeSelection = await selectOrbStrike(entry);
  } catch (err) {
    console.error(`[ORB] Strike selection failed for ${entry.symbol}:`, err.message);
    await sendOrbSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: err.message,
    });
    return { executed: false, reason: 'strike_error' };
  }

  if (isPremiumBelowFloor(strikeSelection.premium, ORB_MIN_ENTRY_PREMIUM)) {
    const floorLabel =
      ORB_MIN_ENTRY_PREMIUM != null ? `$${ORB_MIN_ENTRY_PREMIUM}` : 'ORB_MIN_ENTRY_PREMIUM (not set)';
    await sendOrbSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: `Entry premium $${strikeSelection.premium} below minimum floor (${floorLabel})`,
    });
    return { executed: false, reason: 'premium_below_floor' };
  }

  const sizing = positionSize(budgetRemaining, openCount, strikeSelection.premium, maxPositions);
  if (!sizing.affordable || sizing.quantity < 1 || sizing.totalCost > budgetRemaining) {
    await sendOrbInsufficientBudgetTelegram({
      ticker: entry.symbol,
      requiredCost: sizing.requiredCost,
      budgetRemaining,
      perSlot: sizing.perSlot,
      slots: sizing.slots,
    });
    return { executed: false, reason: 'budget_exhausted' };
  }

  try {
    const order = await placeOptionOrder({
      ticker: strikeSelection.symbol,
      direction: strikeSelection.direction,
      strike: strikeSelection.strike,
      expiration: strikeSelection.expiration,
      quantity: sizing.quantity,
      premium: strikeSelection.premium,
      environment,
      strategy: 'orb',
    });

    const positionId = await insertOrbPosition({
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
      opening_range_high: entry.opening_range_high,
      opening_range_low: entry.opening_range_low,
      breakout_level: entry.breakout_level,
      breakout_direction: entry.breakout_direction,
      confirmation_candles_json: JSON.stringify(entry.confirmation_candles),
      strike_bucket: strikeSelection.strike_bucket,
      entry_iv: strikeSelection.entry_iv,
      entry_delta: strikeSelection.entry_delta,
      entry_metadata_json: JSON.stringify({
        breakout_candle: entry.breakout_candle,
        spot: strikeSelection.spot,
      }),
    });

    const brokerStop = createLadderBrokerStopHandlers({
      strategy: 'orb',
      environment,
      initialStopPct: ORB_STOP_LOSS_PCT,
      updateBrokerStopState: updateOrbPositionBrokerStop,
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
      `[ORB] Opened ${strikeSelection.symbol} qty=${sizing.quantity} ladder entry_contracts=${sizing.entryContracts}`
    );

    await sendOrbTradeOpenedTelegram({
      ticker: strikeSelection.symbol,
      direction: strikeSelection.direction,
      premium: strikeSelection.premium,
      paper: order.paper,
      strike: strikeSelection.strike,
      strikeBucket: strikeSelection.strike_bucket,
    });

    return { executed: true, order, strikeSelection };
  } catch (err) {
    console.error(`[ORB] Order failed for ${entry.symbol}:`, err.message);
    await sendOrbSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: err.message,
    });
    return { executed: false, reason: 'execution_error', error: err.message };
  }
}

export async function runOrbScanAndExecute() {
  if (!isWithinOrbSession()) {
    return { skipped: true, reason: 'outside_orb_session' };
  }

  const tradeDate = etDateKey();
  const results = [];

  for (const symbol of ORB_SYMBOLS) {
    try {
      const bars = await getFiveMinuteBars(symbol, tradeDate);
      let rangeState = await updateOpeningRange(symbol, bars, tradeDate);

      if (!isAfterRangeEnd()) {
        continue;
      }

      const postRangeBars = getPostRangeBars(bars);
      const newBars = filterNewBars(postRangeBars, rangeState.fsm.last_processed_bar_time);

      if (newBars.length === 0) {
        continue;
      }

      const {
        catchUp,
        suppressedEntryCount,
        replayBarCount,
        rangeState: updatedState,
        events,
        entries,
      } = evaluateWithCatchUp(rangeState, newBars);

      if (catchUp) {
        console.log(
          `[ORB] Catch-up replay for ${symbol}: ${replayBarCount} historical bar(s) processed without execution, ${suppressedEntryCount} entry signal(s) suppressed`
        );
      }

      updatedState.fsm.last_processed_bar_time = newBars[newBars.length - 1].time;
      await persistSymbolRangeState(updatedState);
      await persistInvalidationEvents(events, tradeDate);

      const seenBreakoutKeys = new Set();

      for (const entry of entries) {
        if (await shouldSkipDuplicateBreakout(entry, tradeDate, seenBreakoutKeys)) {
          continue;
        }

        const result = await tryExecuteEntry(entry);
        if (result.executed) {
          seenBreakoutKeys.add(breakoutIdempotencyKey(entry, tradeDate));
        }
        results.push({ symbol, ...result });
      }
    } catch (err) {
      console.error(`[ORB] Scan failed for ${symbol}:`, err.message);
      results.push({ symbol, executed: false, reason: 'scan_error', error: err.message });
    }
  }

  return { skipped: false, results };
}
