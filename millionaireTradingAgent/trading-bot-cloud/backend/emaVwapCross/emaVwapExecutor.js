import { placeOptionOrder } from '../brokerageConnector.js';
import { ladderPositionSize } from '../ladder/ladderSizing.js';
import { OPTION_OPENING_COMMISSION_PER_CONTRACT } from '../ladder/ladderConfig.js';
import { bookedEntryQuantity, shouldBookConfirmedEntry } from '../ladder/orderFillStatus.js';
import { maybeSkipUnfilledOpenInsert } from '../ladder/zeroFillEntry.js';
import { reportEntryFillQty } from '../ladder/entryFillAlerts.js';
import {
  EMA_VWAP_MAX_POSITIONS,
  EMA_VWAP_SYMBOLS,
  EMA_VWAP_ENTRY_SIZING,
  EMA_VWAP_STOP_LOSS_PCT,
  EMA_VWAP_HARD_STOP_PCT,
  EMA_VWAP_CORRELATION_GROUP,
  CORRELATED_POSITION_BLOCK_REASON,
  EMA_VWAP_MIN_ENTRY_PREMIUM,
} from './emaVwapConfig.js';
import {
  getEmaVwapMode,
  getEmaVwapBudgetRemaining,
  getEmaVwapOpenPositionCount,
  getEmaVwapOpenPositions,
  insertEmaVwapPosition,
  updateEmaVwapPositionBrokerStop,
  getEmaVwapSymbolState,
  upsertEmaVwapSymbolState,
  hasEmaVwapCrossExecutedToday,
  logEmaVwapEvent,
  closeEmaVwapPosition,
} from './emaVwapDb.js';
import { getTotalAllocated } from '../budget/budgetAllocations.js';
import { getStrategyEnvironment } from '../strategyEnvironment.js';
import { createLadderBrokerStopHandlers, buildBrokerStopOrderParams } from '../ladder/ladderStopOrders.js';
import { kickInitialStopUntilProtected, buildInitialStopRetryExtras } from '../ladder/initialStopRetry.js';
import { GATE_REMOVED_ENTRY_REASON } from '../zeroDte/confirmationBarQuality.js';
import { selectEmaVwapStrike } from './emaVwapStrikeSelector.js';
import {
  sendEmaVwapTradeOpenedTelegram,
  sendEmaVwapSignalNotExecutedTelegram,
  sendEmaVwapBudgetExhaustedTelegram,
  sendEmaVwapInsufficientBudgetTelegram,
  sendEmaVwapTradeClosedTelegram,
} from './emaVwapTelegram.js';
import {
  getFiveMinuteBars,
  etDateKey,
  isWithinOrbSession,
} from '../orb/tradierTimesales.js';
import { persistUnderlyingBarsInBackground } from '../marketData/persistUnderlyingBars.js';
import {
  evaluateEmaVwapSignals,
  parseFsm,
  logEmaVwapExplosiveEvents,
} from './emaVwapSignalEngine.js';
import {
  selectEmaVwapEvaluationBars,
  waitForCompletedFiveMinuteBarSettle,
} from './emaVwapBarTiming.js';
import { checkLiveEntryGate } from '../budget/liveEntryGate.js';
import { DAILY_LOSS_LIMIT_BLOCK_REASON } from '../budget/liveDailyLossLimit.js';
import { getSameDayReentryGate } from '../entryReentryGate.js';
import { getDailyProfitHalt, DAILY_PROFIT_HALT_REASON, DAILY_PROFIT_HALT_THRESHOLD_DOLLARS } from '../budget/dailyProfitHalt.js';
import { isPremiumBelowFloor } from '../zeroDte/entryGuards.js';

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
    const { fsm: updatedFsm, entries, events } = evaluateEmaVwapSignals(
      symbol,
      newBars,
      fsm
    );
    return {
      catchUp: false,
      suppressedEntryCount: 0,
      replayBarCount: newBars.length,
      fsm: updatedFsm,
      entries,
      events,
    };
  }

  const replayBars = newBars.length > 1 ? newBars.slice(0, -1) : [];
  const liveBars = newBars.slice(-1);
  let state = fsm;
  let suppressedEntryCount = 0;
  const events = [];

  if (replayBars.length > 0) {
    const replay = evaluateEmaVwapSignals(symbol, replayBars, state);
    state = replay.fsm;
    suppressedEntryCount += replay.entries.length;
    events.push(...(replay.events || []));
  }

  const live = evaluateEmaVwapSignals(symbol, liveBars, state);
  events.push(...(live.events || []));

  return {
    catchUp: true,
    suppressedEntryCount,
    replayBarCount: replayBars.length,
    fsm: live.fsm,
    entries: live.entries,
    events,
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

  // Cap and budget are independent: slots are a hard concurrent ceiling only.
  // FCFS: size against full remaining budget (not remaining ÷ open slots).
  // Tradeoff: first signal can consume most/all remaining budget.
  return {
    ...ladderPositionSize(budgetRemaining, premium, EMA_VWAP_ENTRY_SIZING),
    perSlot: budgetRemaining,
    slots,
  };
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

  const profitHalt = await getDailyProfitHalt('emavwap');
  if (profitHalt.halt) {
    console.log(
      `[EMA/VWAP] ${DAILY_PROFIT_HALT_REASON} — skipping ${entry.symbol} ${entry.direction}` +
        ` (realizedPnlToday=$${Number(profitHalt.realizedPnlToday).toFixed(2)} on ${profitHalt.tradeDate})`
    );
    await sendEmaVwapSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: `Daily profit halt — account realized P&L $${Number(profitHalt.realizedPnlToday).toFixed(2)} reached $${DAILY_PROFIT_HALT_THRESHOLD_DOLLARS.toFixed(2)} today; new entries blocked`,
    });
    return { executed: false, reason: DAILY_PROFIT_HALT_REASON };
  }

  const liveGate = await checkLiveEntryGate('emavwap');
  if (!liveGate.allowed) {
    console.log(`[EMA/VWAP] ${liveGate.reason} — blocking entry for ${entry.symbol}`);
    if (liveGate.reason === 'paper_entry_blocked') {
      return { executed: false, reason: 'paper_entry_blocked' };
    }
    await sendEmaVwapSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: DAILY_LOSS_LIMIT_BLOCK_REASON,
    });
    return { executed: false, reason: liveGate.reason };
  }

  const reentry = await getSameDayReentryGate({
    strategy: 'emavwap',
    ticker: entry.symbol,
    direction: entry.direction,
  });
  if (reentry.blocked) {
    console.log(
      `[EMA/VWAP] Same-day loss block — skipping ${entry.symbol} ${entry.direction}` +
        ` (last today: ${reentry.lastCloseReason} pnl=${reentry.lastPnl})`
    );
    await sendEmaVwapSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: 'Same-day loss block — no re-entry after a losing close today',
    });
    return { executed: false, reason: 'same_day_loss_block' };
  }

  const openCount = await getEmaVwapOpenPositionCount();
  if (openCount >= EMA_VWAP_MAX_POSITIONS) {
    await sendEmaVwapSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: `Max open EMA/VWAP positions (${EMA_VWAP_MAX_POSITIONS}) reached`,
    });
    return { executed: false, reason: 'max_positions' };
  }

  const openPositions = await getEmaVwapOpenPositions();
  const entryTicker = String(entry.symbol || '').toUpperCase();
  const entryDir = String(entry.direction || '').toUpperCase();
  const corrGroup = new Set(EMA_VWAP_CORRELATION_GROUP.map((t) => String(t).toUpperCase()));
  if (corrGroup.has(entryTicker)) {
    const peer = openPositions.find((p) => {
      const pTicker = String(p.ticker || '').toUpperCase();
      const pDir = String(p.direction || '').toUpperCase();
      return (
        corrGroup.has(pTicker) &&
        pTicker !== entryTicker &&
        pDir === entryDir
      );
    });
    if (peer) {
      console.log(
        `[EMA/VWAP] ${CORRELATED_POSITION_BLOCK_REASON} — skipping ${entry.symbol} ${entry.direction}` +
          ` (open peer ${peer.ticker} ${peer.direction})`
      );
      await sendEmaVwapSignalNotExecutedTelegram({
        ticker: entry.symbol,
        direction: entry.direction,
        reason:
          `Correlated position block — already open ${peer.ticker} ${peer.direction} in SPY/QQQ/IWM group`,
      });
      return {
        executed: false,
        reason: CORRELATED_POSITION_BLOCK_REASON,
        peer: { ticker: peer.ticker, direction: peer.direction },
      };
    }
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
    await sendEmaVwapSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: `Entry premium $${strikeSelection.premium} below minimum floor ($${EMA_VWAP_MIN_ENTRY_PREMIUM})`,
    });
    return { executed: false, reason: 'premium_below_floor' };
  }

  const sizing = positionSize(budgetRemaining, openCount, strikeSelection.premium);
  if (!sizing.affordable || sizing.quantity < 1 || sizing.totalCost > budgetRemaining) {
    console.log(
      `[EMA/VWAP] skip entry ${entry.symbol}: 0 contracts affordable ` +
        `budget=$${Number(budgetRemaining).toFixed(2)} premium=$${strikeSelection.premium} ` +
        `contractCost=$${Number(sizing.requiredCost).toFixed(2)} (notional+$${OPTION_OPENING_COMMISSION_PER_CONTRACT} fee)`
    );
    await sendEmaVwapInsufficientBudgetTelegram({
      ticker: entry.symbol,
      requiredCost: sizing.requiredCost,
      budgetRemaining,
    });
    return { executed: false, reason: 'budget_exhausted' };
  }

  try {
    const environment = await getStrategyEnvironment('emavwap');
    const stopParams = buildBrokerStopOrderParams(
      {
        entry_premium: strikeSelection.premium,
        quantity: sizing.quantity,
        contracts_open: sizing.quantity,
        exit_phase: 'LADDER:0',
        trail_peak_pnl_frac: 0,
      },
      { initialStopPct: EMA_VWAP_STOP_LOSS_PCT }
    );
    const order = await placeOptionOrder({
      ticker: strikeSelection.symbol,
      direction: strikeSelection.direction,
      strike: strikeSelection.strike,
      expiration: strikeSelection.expiration,
      quantity: sizing.quantity,
      premium: strikeSelection.premium,
      environment,
      strategy: 'emavwap',
      initialStop: stopParams,
    });

    const bookedQty = bookedEntryQuantity({
      requestedQuantity: sizing.quantity,
      fillQuantity: order.fillQuantity,
    });
    const unfilledSkip = await maybeSkipUnfilledOpenInsert({
      order,
      bookedQty,
      environment,
      strategy: 'emavwap',
      ticker: strikeSelection.symbol,
      direction: strikeSelection.direction,
      logEvent: async ({ ticker, eventType, direction, breakoutLevel, details }) =>
        logEmaVwapEvent({
          ticker,
          tradeDate: etDateKey(),
          eventType,
          direction,
          breakoutLevel,
          details,
        }),
    });
    if (unfilledSkip.skipped) {
      return { executed: false, reason: unfilledSkip.reason, order, strikeSelection };
    }
    if (
      !shouldBookConfirmedEntry({
        fillQuantity: order.fillQuantity,
        bookedQuantity: bookedQty,
        fillPrice: order.fillPrice,
        dryRun: order.dryRun,
        simulated: order.simulated,
      })
    ) {
      console.error(
        `[EMA/VWAP] ${strikeSelection.symbol} filled qty=${bookedQty} without a confirmed fill price ` +
          `— refusing to book the selection quote $${strikeSelection.premium}`
      );
      return { executed: false, reason: 'entry_fill_price_missing', order, strikeSelection };
    }
    const bookedPremium = Number(order.fillPrice);

    if (entry.gate_removed_entry === true) {
      console.log(
        `[EMA/VWAP] ${GATE_REMOVED_ENTRY_REASON} fill path — ${strikeSelection.symbol} ${strikeSelection.direction}` +
          ` would_have=${entry.would_have_rejected_reason}` +
          ` breaches=${(entry.confirm_metrics?.breaches || []).join(',') || 'n/a'}`
      );
    }

    const positionId = await insertEmaVwapPosition({
      ticker: strikeSelection.symbol,
      direction: strikeSelection.direction,
      strike: strikeSelection.strike,
      expiration: strikeSelection.expiration,
      entry_premium: bookedPremium,
      quantity: bookedQty,
      order_id: order.orderId,
      broker: order.broker || 'tastytrade',
      entry_contracts: bookedQty,
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
        entry_policy: entry.entry_policy ?? 'control',
        confirm_metrics: entry.confirm_metrics ?? null,
        gate_removed_entry: entry.gate_removed_entry === true,
        would_have_rejected_reason: entry.would_have_rejected_reason ?? null,
        spot: strikeSelection.spot,
        adx_at_entry: entry.adx_at_entry ?? null,
        requested_quantity: sizing.quantity,
        fill_quantity: order.fillQuantity ?? null,
        booked_quantity: bookedQty,
        selection_premium: strikeSelection.premium,
        fill_premium: order.fillPrice ?? null,
      }),
    });

    const brokerStop = createLadderBrokerStopHandlers({
      strategy: 'emavwap',
      environment,
      initialStopPct: EMA_VWAP_STOP_LOSS_PCT,
      hardStopPct: EMA_VWAP_HARD_STOP_PCT,
      updateBrokerStopState: updateEmaVwapPositionBrokerStop,
      fullClosePosition: async () => null,
    });
    const openedPosition = {
      id: positionId,
      ticker: strikeSelection.symbol,
      direction: strikeSelection.direction,
      strike: strikeSelection.strike,
      expiration: strikeSelection.expiration,
      entry_premium: bookedPremium,
      quantity: bookedQty,
      contracts_open: bookedQty,
      order_id: order.orderId,
      exit_phase: 'LADDER:0',
      trail_peak_pnl_frac: 0,
    };
    if (order.stopOrderId && !order.stopAlignFailed) {
      await updateEmaVwapPositionBrokerStop(positionId, {
        broker_stop_order_id: order.stopOrderId,
        broker_stop_trigger_price: order.stopTrigger ?? stopParams?.stopTrigger ?? null,
        broker_stop_pnl_frac: order.stopPnlFrac ?? stopParams?.stopPnlFrac ?? null,
      });
      console.log(
        `[EMA/VWAP] OTO stop resting #${positionId} order=${order.stopOrderId} trigger=$${order.stopTrigger ?? stopParams?.stopTrigger}`
      );
    } else {
      kickInitialStopUntilProtected(
        brokerStop,
        openedPosition,
        buildInitialStopRetryExtras({
          strategy: 'emavwap',
          position: openedPosition,
          getOpenPositions: getEmaVwapOpenPositions,
          environment,
          fullClosePosition: closeEmaVwapPosition,
          onNotify: async (pos, reason, pnlFrac) => {
            await sendEmaVwapTradeClosedTelegram({
              ticker: pos.ticker,
              reason,
              pnlPct: pnlFrac,
            });
          },
        })
      );
    }

    console.log(
      `[EMA/VWAP] Opened ${strikeSelection.symbol} qty=${bookedQty} ` +
        `(requested=${sizing.quantity} filled=${order.fillQuantity ?? 'n/a'}) ` +
        `premium=$${bookedPremium} ladder entry_contracts=${bookedQty}` +
        (order.bracketType ? ` bracket=${order.bracketType}` : '')
    );

    await reportEntryFillQty({
      strategy: 'emavwap',
      ticker: strikeSelection.symbol,
      direction: strikeSelection.direction,
      strike: strikeSelection.strike,
      positionId,
      requestedQty: sizing.quantity,
      bookedQty,
      order,
      logEvent: async ({ ticker, eventType, direction, breakoutLevel, details }) =>
        logEmaVwapEvent({
          ticker,
          tradeDate: etDateKey(),
          eventType,
          direction,
          breakoutLevel,
          details,
        }),
    });

    await sendEmaVwapTradeOpenedTelegram({
      ticker: strikeSelection.symbol,
      direction: strikeSelection.direction,
      premium: bookedPremium,
      paper: order.paper,
      strike: strikeSelection.strike,
      strikeBucket: strikeSelection.strike_bucket,
    });

    return { executed: true, order, strikeSelection };
  } catch (err) {
    console.error(`[EMA/VWAP] Order failed for ${entry.symbol}:`, err.message);
    try {
      await logEmaVwapEvent({
        ticker: entry.symbol,
        tradeDate: etDateKey(),
        eventType: 'execution_error',
        direction: entry.direction,
        breakoutLevel: entry.vwap_at_entry ?? null,
        details: {
          reason: 'execution_error',
          error: err.message,
        },
      });
    } catch (logErr) {
      console.warn(`[EMA/VWAP] execution_error event log failed:`, logErr.message);
    }
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

  // Cron fires at :00/:05/:10. Wait for Tradier to finalize the bar that just
  // closed, then evaluate that completed bar — never the one that just opened.
  await waitForCompletedFiveMinuteBarSettle();

  const tradeDate = etDateKey();
  const results = [];

  for (const symbol of EMA_VWAP_SYMBOLS) {
    try {
      const bars = await getFiveMinuteBars(symbol, tradeDate);
      persistUnderlyingBarsInBackground(symbol, bars, { source: 'emavwap-scan' });

      let fsm = await loadSymbolFsm(symbol, tradeDate);
      const newBars = selectEmaVwapEvaluationBars(bars, {
        lastProcessedTime: fsm.last_processed_bar_time,
        now: new Date(),
      });

      let updatedFsm = fsm;
      let entries = [];

      if (newBars.length > 0) {
        const {
          catchUp,
          suppressedEntryCount,
          replayBarCount,
          fsm: nextFsm,
          entries: liveEntries,
          events,
        } = evaluateEmaVwapWithCatchUp(symbol, fsm, newBars);

        updatedFsm = nextFsm;
        entries = liveEntries;
        await logEmaVwapExplosiveEvents(events || [], tradeDate);

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
