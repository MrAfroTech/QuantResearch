import { placeOptionOrder } from '../brokerageConnector.js';
import { GATE_REMOVED_ENTRY_REASON } from '../zeroDte/confirmationBarQuality.js';
import { ladderPositionSize, contractEntryCost } from '../ladder/ladderSizing.js';
import { OPTION_OPENING_COMMISSION_PER_CONTRACT } from '../ladder/ladderConfig.js';
import { bookedEntryQuantity } from '../ladder/orderFillStatus.js';
import { bookedEntryPremium } from '../ladder/otoStopQuantity.js';
import { maybeSkipUnfilledOpenInsert } from '../ladder/zeroFillEntry.js';
import { reportEntryFillQty } from '../ladder/entryFillAlerts.js';
import {
  getOrbMaxPositions,
  ORB_SYMBOLS,
  ORB_MIN_ENTRY_PREMIUM,
  ORB_STOP_LOSS_PCT,
  ORB_HARD_STOP_PCT,
  ORB_ENTRY_WINDOW_START,
  ORB_ENTRY_WINDOW_END,
  ORB_ENTRY_SIZING,
  ORB_ENTRIES_ENABLED,
  ORB_ENTRIES_DISABLED_REASON,
  OUTSIDE_ENTRY_WINDOW_REASON,
  DAILY_PROFIT_HALT_REASON,
} from './orbConfig.js';
import {
  getOrbMode,
  getOrbBudgetRemaining,
  getOrbOpenPositionCount,
  getOrbOpenPositions,
  insertOrbPosition,
  updateOrbPositionBrokerStop,
  hasOrbBreakoutExecutedToday,
  listOrbBreakoutCloseOutcomes,
  logOrbEvent,
  closeOrbPosition,
} from './orbDb.js';
import { getOrbDailyProfitHalt } from './orbDailyProfitHalt.js';
import { DAILY_PROFIT_HALT_THRESHOLD_DOLLARS } from '../budget/dailyProfitHalt.js';
import { getTotalAllocated } from '../budget/budgetAllocations.js';
import { getStrategyEnvironment } from '../strategyEnvironment.js';
import { createLadderBrokerStopHandlers, buildBrokerStopOrderParams } from '../ladder/ladderStopOrders.js';
import { kickInitialStopUntilProtected, buildInitialStopRetryExtras } from '../ladder/initialStopRetry.js';
import { selectOrbStrike } from './orbStrikeSelector.js';
import {
  sendOrbTradeOpenedTelegram,
  sendOrbSignalNotExecutedTelegram,
  sendOrbBudgetExhaustedTelegram,
  sendOrbInsufficientBudgetTelegram,
  sendOrbTradeClosedTelegram,
} from './orbTelegram.js';
import {
  getFiveMinuteBars,
  etDateKey,
  isWithinOrbSession,
  isAfterRangeEnd,
  minutesSinceMidnightEt,
} from './tradierTimesales.js';
import {
  updateOpeningRange,
  loadSymbolRangeState,
  persistSymbolRangeState,
  getPostRangeBars,
} from './orbRangeState.js';
import { evaluateOrbSignals, persistInvalidationEvents } from './orbSignalEngine.js';
import { persistUnderlyingBarsInBackground } from '../marketData/persistUnderlyingBars.js';
import {
  filterCompletedBars,
  waitForCompletedBarSettle,
} from '../zeroDte/completedBarTiming.js';
import { isPremiumBelowFloor } from '../zeroDte/entryGuards.js';
import { checkLiveEntryGate } from '../budget/liveEntryGate.js';
import { DAILY_LOSS_LIMIT_BLOCK_REASON } from '../budget/liveDailyLossLimit.js';
import { getSameDayReentryGate } from '../entryReentryGate.js';
import {
  getOrbPremarketLevelCollisionGate,
  DUPLICATE_CORRELATED_LEVEL_REASON,
} from '../zeroDte/orbPremarketLevelCollision.js';

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

function evaluateWithCatchUp(rangeState, newBars, closes = []) {
  const lastProcessed = rangeState.fsm.last_processed_bar_time;
  const catchUp = isCatchUpReplay(lastProcessed, newBars);
  const options = { closes };

  if (!catchUp) {
    return {
      catchUp: false,
      suppressedEntryCount: 0,
      replayBarCount: newBars.length,
      ...evaluateOrbSignals(rangeState, newBars, options),
    };
  }

  const replayBars = newBars.length > 1 ? newBars.slice(0, -1) : [];
  const liveBars = newBars.slice(-1);
  let state = rangeState;
  const events = [];
  let suppressedEntryCount = 0;

  if (replayBars.length > 0) {
    const replay = evaluateOrbSignals(state, replayBars, options);
    state = replay.rangeState;
    events.push(...replay.events);
    suppressedEntryCount += replay.entries.length;
  }

  const live = evaluateOrbSignals(state, liveBars, options);
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

  // Cap and budget are independent: slots are a hard concurrent ceiling only.
  // FCFS: size against full remaining budget (not remaining ÷ open slots).
  // Tradeoff: first signal can consume most/all remaining budget.
  //
  // ORB_ENTRY_SIZING is the 1-contract hard cap (see orbConfig.js). This is
  // the only strategy that overrides max-affordable; Premarket still uses
  // maxContracts: Infinity.
  return {
    ...ladderPositionSize(budgetRemaining, premium, ORB_ENTRY_SIZING),
    perSlot: budgetRemaining,
    slots,
  };
}

function isWithinOrbEntryWindow(date = new Date()) {
  const mins = minutesSinceMidnightEt(date);
  const start = ORB_ENTRY_WINDOW_START.hour * 60 + ORB_ENTRY_WINDOW_START.minute;
  const end = ORB_ENTRY_WINDOW_END.hour * 60 + ORB_ENTRY_WINDOW_END.minute;
  return mins >= start && mins < end;
}

async function tryExecuteEntry(entry) {
  if (!ORB_ENTRIES_ENABLED) {
    console.log(
      `[ORB] ${ORB_ENTRIES_DISABLED_REASON} — no live or paper order for ${entry.symbol} ${entry.direction}`
    );
    return { executed: false, reason: ORB_ENTRIES_DISABLED_REASON };
  }

  const orbMode = await getOrbMode();
  if (orbMode === 'MANUAL') {
    await sendOrbSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: 'Bot is in MANUAL mode — awaiting approval',
    });
    return { executed: false, reason: 'manual_mode' };
  }

  if (!isWithinOrbEntryWindow()) {
    console.log(
      `[ORB] ${OUTSIDE_ENTRY_WINDOW_REASON} — skipping ${entry.symbol} ${entry.direction}` +
        ` (entries only 9:30–11:00 AM ET)`
    );
    await sendOrbSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: 'Outside ORB entry window (9:30–11:00 AM ET) — new entries blocked',
    });
    return { executed: false, reason: OUTSIDE_ENTRY_WINDOW_REASON };
  }

  const profitHalt = await getOrbDailyProfitHalt();
  if (profitHalt.halt) {
    console.log(
      `[ORB] ${DAILY_PROFIT_HALT_REASON} — skipping ${entry.symbol} ${entry.direction}` +
        ` (realizedPnlToday=$${Number(profitHalt.realizedPnlToday).toFixed(2)} on ${profitHalt.tradeDate})`
    );
    await sendOrbSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: `Daily profit halt — account realized P&L $${Number(profitHalt.realizedPnlToday).toFixed(2)} reached $${DAILY_PROFIT_HALT_THRESHOLD_DOLLARS.toFixed(2)} today; new entries blocked`,
    });
    return { executed: false, reason: DAILY_PROFIT_HALT_REASON };
  }

  const liveGate = await checkLiveEntryGate('orb');
  if (!liveGate.allowed) {
    console.log(`[ORB] ${liveGate.reason} — blocking entry for ${entry.symbol}`);
    if (liveGate.reason === 'paper_entry_blocked') {
      return { executed: false, reason: 'paper_entry_blocked' };
    }
    await sendOrbSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: DAILY_LOSS_LIMIT_BLOCK_REASON,
    });
    return { executed: false, reason: liveGate.reason };
  }

  const reentry = await getSameDayReentryGate({
    strategy: 'orb',
    ticker: entry.symbol,
    direction: entry.direction,
  });
  if (reentry.blocked) {
    console.log(
      `[ORB] Same-day loss block — skipping ${entry.symbol} ${entry.direction}` +
        ` (last today: ${reentry.lastCloseReason} pnl=${reentry.lastPnl})`
    );
    await sendOrbSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: 'Same-day loss block — no re-entry after a losing close today',
    });
    return { executed: false, reason: 'same_day_loss_block' };
  }

  const collision = await getOrbPremarketLevelCollisionGate({
    claimingStrategy: 'orb',
    ticker: entry.symbol,
    direction: entry.direction,
    breakoutLevel: entry.breakout_level,
    tradeDate: etDateKey(),
  });
  if (collision.blocked) {
    const d = collision.detail || {};
    console.log(
      `[ORB] ${DUPLICATE_CORRELATED_LEVEL_REASON} — skipping ${entry.symbol} ${entry.direction}: ` +
        `level ${d.claimingLevel} collides with Premarket ${d.peerLevel} ` +
        `(gap=${d.gap?.toFixed?.(4) ?? d.gap}, ${(100 * (d.fracOfMinWidth ?? 0)).toFixed(1)}% of min range width)`
    );
    await sendOrbSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason:
        'Duplicate correlated level — Premarket already claimed this ticker/direction on a colliding breakout level',
    });
    return {
      executed: false,
      reason: DUPLICATE_CORRELATED_LEVEL_REASON,
      detail: collision.detail,
    };
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
    console.log(
      `[ORB] skip entry ${entry.symbol}: 0 contracts affordable ` +
        `budget=$${Number(budgetRemaining).toFixed(2)} premium=$${strikeSelection.premium} ` +
        `contractCost=$${Number(sizing.requiredCost).toFixed(2)} (notional+$${OPTION_OPENING_COMMISSION_PER_CONTRACT} fee)`
    );
    await sendOrbInsufficientBudgetTelegram({
      ticker: entry.symbol,
      requiredCost: sizing.requiredCost,
      budgetRemaining,
    });
    return { executed: false, reason: 'zero_contracts_unaffordable' };
  }

  try {
    const stopParams = buildBrokerStopOrderParams(
      {
        entry_premium: strikeSelection.premium,
        quantity: sizing.quantity,
        contracts_open: sizing.quantity,
        exit_phase: 'LADDER:0',
        trail_peak_pnl_frac: 0,
      },
      { initialStopPct: ORB_STOP_LOSS_PCT }
    );
    const order = await placeOptionOrder({
      ticker: strikeSelection.symbol,
      direction: strikeSelection.direction,
      strike: strikeSelection.strike,
      expiration: strikeSelection.expiration,
      quantity: sizing.quantity,
      premium: strikeSelection.premium,
      environment,
      strategy: 'orb',
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
      strategy: 'orb',
      ticker: strikeSelection.symbol,
      direction: strikeSelection.direction,
      breakoutLevel: entry.breakout_level,
      confirmTags: {
        confirm_mode: entry.confirm_mode ?? null,
        confirm_timeframe: entry.confirm_timeframe ?? null,
        experiment_id: entry.experiment_id ?? null,
        entry_policy: entry.entry_policy ?? 'control',
      },
      logEvent: async ({ ticker, eventType, direction, breakoutLevel, details }) =>
        logOrbEvent({
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
    const bookedPremium = bookedEntryPremium(order.fillPrice, strikeSelection.premium);
    if (bookedQty >= 1 && order.fillPrice == null) {
      console.error(
        `[ORB] ${strikeSelection.symbol} booked qty=${bookedQty} using selection quote ` +
          `$${strikeSelection.premium} — broker fill price was missing`
      );
    }
    const realizedCost = bookedQty * contractEntryCost(
      bookedPremium,
      OPTION_OPENING_COMMISSION_PER_CONTRACT
    );

    if (entry.gate_removed_entry === true) {
      console.log(
        `[ORB] ${GATE_REMOVED_ENTRY_REASON} fill path — ${strikeSelection.symbol} ${strikeSelection.direction}` +
          ` would_have=${entry.would_have_rejected_reason}` +
          ` breaches=${(entry.confirm_metrics?.breaches || []).join(',') || 'n/a'}`
      );
    }

    const positionId = await insertOrbPosition({
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
        entry_policy: entry.entry_policy ?? 'control',
        confirm_metrics: entry.confirm_metrics ?? null,
        gate_removed_entry: entry.gate_removed_entry === true,
        would_have_rejected_reason: entry.would_have_rejected_reason ?? null,
        spot: strikeSelection.spot,
        requested_quantity: sizing.quantity,
        fill_quantity: order.fillQuantity ?? null,
        booked_quantity: bookedQty,
        selection_premium: strikeSelection.premium,
        fill_premium: order.fillPrice ?? null,
        realized_entry_cost: realizedCost,
        observed_oto_stop_qty: order.observedOtoStopQty ?? null,
        observed_oto_stop_trigger: order.observedOtoStopTrigger ?? null,
        broker_stop_matched_fill: order.brokerStopMatchedFill ?? null,
        stop_qty_replaced: order.stopQtyReplaced ?? null,
        stop_align_reason: order.stopAlignReason ?? null,
      }),
    });

    const brokerStop = createLadderBrokerStopHandlers({
      strategy: 'orb',
      environment,
      initialStopPct: ORB_STOP_LOSS_PCT,
      hardStopPct: ORB_HARD_STOP_PCT,
      updateBrokerStopState: updateOrbPositionBrokerStop,
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
      await updateOrbPositionBrokerStop(positionId, {
        broker_stop_order_id: order.stopOrderId,
        broker_stop_trigger_price: order.stopTrigger ?? stopParams?.stopTrigger ?? null,
        broker_stop_pnl_frac: order.stopPnlFrac ?? stopParams?.stopPnlFrac ?? null,
      });
      console.log(
        `[ORB] OTO stop resting #${positionId} order=${order.stopOrderId} trigger=$${order.stopTrigger ?? stopParams?.stopTrigger}`
      );
    } else {
      kickInitialStopUntilProtected(
        brokerStop,
        openedPosition,
        buildInitialStopRetryExtras({
          strategy: 'orb',
          position: openedPosition,
          getOpenPositions: getOrbOpenPositions,
          environment,
          fullClosePosition: closeOrbPosition,
          onNotify: async (pos, reason, pnlFrac) => {
            await sendOrbTradeClosedTelegram({
              ticker: pos.ticker,
              reason,
              pnlPct: pnlFrac,
            });
          },
        })
      );
    }

    console.log(
      `[ORB] Opened ${strikeSelection.symbol} qty=${bookedQty} ` +
        `(requested=${sizing.quantity} filled=${order.fillQuantity ?? 'n/a'}) ` +
        `cost=$${Number(realizedCost).toFixed(2)} ` +
        `ladder entry_contracts=${bookedQty}` +
        (order.bracketType ? ` bracket=${order.bracketType}` : '')
    );

    await reportEntryFillQty({
      strategy: 'orb',
      ticker: strikeSelection.symbol,
      direction: strikeSelection.direction,
      strike: strikeSelection.strike,
      positionId,
      breakoutLevel: entry.breakout_level,
      requestedQty: sizing.quantity,
      bookedQty,
      order,
      logEvent: async ({ ticker, eventType, direction, breakoutLevel, details }) =>
        logOrbEvent({
          ticker,
          tradeDate: etDateKey(),
          eventType,
          direction,
          breakoutLevel,
          details,
        }),
    });

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

  const intervalMinutes = 5;
  // Cron fires at bar open. Wait for Tradier to finalize the bar that just
  // closed, then evaluate that completed bar — never the one that just opened.
  await waitForCompletedBarSettle({ intervalMinutes, label: 'ORB' });

  const tradeDate = etDateKey();
  const results = [];

  for (const symbol of ORB_SYMBOLS) {
    try {
      const bars = await getFiveMinuteBars(symbol, tradeDate);
      persistUnderlyingBarsInBackground(symbol, bars, { source: 'orb-scan' });
      const completedBars = filterCompletedBars(bars, {
        intervalMinutes,
        now: new Date(),
      });
      let rangeState = await updateOpeningRange(symbol, completedBars, tradeDate);

      if (!isAfterRangeEnd()) {
        continue;
      }

      const postRangeBars = getPostRangeBars(completedBars);
      const newBars = filterNewBars(postRangeBars, rangeState.fsm.last_processed_bar_time);

      if (newBars.length === 0) {
        continue;
      }

      const closes = await listOrbBreakoutCloseOutcomes({ ticker: symbol, tradeDate });
      const {
        catchUp,
        suppressedEntryCount,
        replayBarCount,
        rangeState: updatedState,
        events,
        entries,
      } = evaluateWithCatchUp(rangeState, newBars, closes);

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
        if (!ORB_ENTRIES_ENABLED) {
          results.push({
            symbol,
            executed: false,
            reason: ORB_ENTRIES_DISABLED_REASON,
          });
          continue;
        }
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
