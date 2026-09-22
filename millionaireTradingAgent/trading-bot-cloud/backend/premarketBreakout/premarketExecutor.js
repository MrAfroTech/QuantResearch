import { placeOptionOrder } from '../brokerageConnector.js';
import { GATE_REMOVED_ENTRY_REASON } from '../zeroDte/confirmationBarQuality.js';
import { ladderPositionSize, contractEntryCost } from '../ladder/ladderSizing.js';
import { OPTION_OPENING_COMMISSION_PER_CONTRACT } from '../ladder/ladderConfig.js';
import { bookedEntryQuantity } from '../ladder/orderFillStatus.js';
import { bookedEntryPremium } from '../ladder/otoStopQuantity.js';
import { maybeSkipUnfilledOpenInsert } from '../ladder/zeroFillEntry.js';
import { reportEntryFillQty } from '../ladder/entryFillAlerts.js';
import {
  getPremarketMaxPositions,
  PREMARKET_ENTRY_SIZING,
  PREMARKET_SYMBOLS,
  PREMARKET_MIN_ENTRY_PREMIUM,
  ENTRY_BELOW_PREMIUM_FLOOR_REASON,
  PREMARKET_MAX_SPREAD_PCT,
  SPREAD_TOO_WIDE_REJECTED_REASON,
  computePremarketIvStopPcts,
  OUTSIDE_ENTRY_WINDOW_REASON,
} from './premarketConfig.js';
import {
  getPremarketMode,
  getPremarketBudgetRemaining,
  getPremarketOpenPositionCount,
  getPremarketOpenPositions,
  insertPremarketPosition,
  updatePremarketPositionBrokerStop,
  hasPremarketBreakoutExecutedToday,
  listPremarketBreakoutCloseOutcomes,
  logPremarketEvent,
  closePremarketPosition,
} from './premarketDb.js';
import { getTotalAllocated } from '../budget/budgetAllocations.js';
import { getStrategyEnvironment } from '../strategyEnvironment.js';
import { createLadderBrokerStopHandlers, buildBrokerStopOrderParams } from '../ladder/ladderStopOrders.js';
import { kickInitialStopUntilProtected, buildInitialStopRetryExtras } from '../ladder/initialStopRetry.js';
import { selectPremarketStrike } from './premarketStrikeSelector.js';
import {
  sendPremarketTradeOpenedTelegram,
  sendPremarketSignalNotExecutedTelegram,
  sendPremarketBudgetExhaustedTelegram,
  sendPremarketInsufficientBudgetTelegram,
  sendPremarketTradeClosedTelegram,
} from './premarketTelegram.js';
import { etDateKey } from '../orb/tradierTimesales.js';
import {
  getExtendedFiveMinuteBars,
  updatePremarketRange,
  persistSymbolRangeState,
  getPostOpenBars,
  isWithinPremarketSession,
  isAfterMarketOpen,
} from './premarketRangeState.js';
import { evaluatePremarketSignals, persistInvalidationEvents } from './premarketSignalEngine.js';
import { persistUnderlyingBarsInBackground } from '../marketData/persistUnderlyingBars.js';
import {
  filterCompletedBars,
  waitForCompletedBarSettle,
} from '../zeroDte/completedBarTiming.js';
import { isPremiumBelowFloor } from '../zeroDte/entryGuards.js';
import { checkLiveEntryGate } from '../budget/liveEntryGate.js';
import { getSameDayReentryGate } from '../entryReentryGate.js';
import {
  getOrbPremarketLevelCollisionGate,
  DUPLICATE_CORRELATED_LEVEL_REASON,
} from '../zeroDte/orbPremarketLevelCollision.js';
import { getDailyProfitHalt, DAILY_PROFIT_HALT_REASON, DAILY_PROFIT_HALT_THRESHOLD_DOLLARS } from '../budget/dailyProfitHalt.js';

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
      `[Premarket] Skipping duplicate entry (same poll cycle) for ${entry.symbol} ${entry.direction} breakout_level=${entry.breakout_level}`
    );
    return true;
  }

  const alreadyExecuted = await hasPremarketBreakoutExecutedToday({
    ticker: entry.symbol,
    direction: entry.direction,
    breakoutLevel: entry.breakout_level,
    tradeDate,
  });
  if (alreadyExecuted) {
    console.log(
      `[Premarket] Skipping duplicate entry (already executed today) for ${entry.symbol} ${entry.direction} breakout_level=${entry.breakout_level}`
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
      ...evaluatePremarketSignals(rangeState, newBars, options),
    };
  }

  const replayBars = newBars.length > 1 ? newBars.slice(0, -1) : [];
  const liveBars = newBars.slice(-1);
  let state = rangeState;
  const events = [];
  let suppressedEntryCount = 0;

  if (replayBars.length > 0) {
    const replay = evaluatePremarketSignals(state, replayBars, options);
    state = replay.rangeState;
    events.push(...replay.events);
    suppressedEntryCount += replay.entries.length;
  }

  const live = evaluatePremarketSignals(state, liveBars, options);
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
  return {
    ...ladderPositionSize(budgetRemaining, premium, PREMARKET_ENTRY_SIZING),
    perSlot: budgetRemaining,
    slots,
  };
}

/** Entries allowed from market open through PREMARKET_TIME_STOP only (no noon gate). */
function isWithinPremarketEntryWindow(date = new Date()) {
  return isWithinPremarketSession(date);
}

async function tryExecuteEntry(entry) {
  const mode = await getPremarketMode();
  if (mode === 'MANUAL') {
    await sendPremarketSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: 'Bot is in MANUAL mode — awaiting approval',
    });
    return { executed: false, reason: 'manual_mode' };
  }

  // Premarket new entries from market open through session time-stop (15:05 ET).
  // No start-of-window restriction beyond the active session itself.
  if (!isWithinPremarketEntryWindow()) {
    console.log(
      `[Premarket] ${OUTSIDE_ENTRY_WINDOW_REASON} — skipping ${entry.symbol} ${entry.direction}` +
        ` (entries only during session through 3:05 PM ET time-stop)`
    );
    await sendPremarketSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: 'Outside Premarket session (through 3:05 PM ET time-stop) — new entries blocked',
    });
    return { executed: false, reason: OUTSIDE_ENTRY_WINDOW_REASON };
  }

  const profitHalt = await getDailyProfitHalt('premarket');
  if (profitHalt.halt) {
    console.log(
      `[Premarket] ${DAILY_PROFIT_HALT_REASON} — skipping ${entry.symbol} ${entry.direction}` +
        ` (realizedPnlToday=$${Number(profitHalt.realizedPnlToday).toFixed(2)} on ${profitHalt.tradeDate})`
    );
    await sendPremarketSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: `Daily profit halt — account realized P&L $${Number(profitHalt.realizedPnlToday).toFixed(2)} reached $${DAILY_PROFIT_HALT_THRESHOLD_DOLLARS.toFixed(2)} today; new entries blocked`,
    });
    return { executed: false, reason: DAILY_PROFIT_HALT_REASON };
  }

  const liveGate = await checkLiveEntryGate('premarket');
  if (!liveGate.allowed) {
    console.log(`[Premarket] ${liveGate.reason} — blocking entry for ${entry.symbol}`);
    if (liveGate.reason === 'paper_entry_blocked') {
      return { executed: false, reason: 'paper_entry_blocked' };
    }
    await sendPremarketSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: 'Live daily loss limit reached (30%) — new entries blocked for today',
    });
    return { executed: false, reason: liveGate.reason };
  }

  const reentry = await getSameDayReentryGate({
    strategy: 'premarket',
    ticker: entry.symbol,
    direction: entry.direction,
  });
  if (reentry.blocked) {
    console.log(
      `[Premarket] Same-day loss block — skipping ${entry.symbol} ${entry.direction}` +
        ` (last today: ${reentry.lastCloseReason} pnl=${reentry.lastPnl})`
    );
    await sendPremarketSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: 'Same-day loss block — no re-entry after a losing close today',
    });
    return { executed: false, reason: 'same_day_loss_block' };
  }

  const collision = await getOrbPremarketLevelCollisionGate({
    claimingStrategy: 'premarket',
    ticker: entry.symbol,
    direction: entry.direction,
    breakoutLevel: entry.breakout_level,
    tradeDate: etDateKey(),
  });
  if (collision.blocked) {
    const d = collision.detail || {};
    console.log(
      `[Premarket] ${DUPLICATE_CORRELATED_LEVEL_REASON} — skipping ${entry.symbol} ${entry.direction}: ` +
        `level ${d.claimingLevel} collides with ORB ${d.peerLevel} ` +
        `(gap=${d.gap?.toFixed?.(4) ?? d.gap}, ${(100 * (d.fracOfMinWidth ?? 0)).toFixed(1)}% of min range width)`
    );
    await sendPremarketSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason:
        'Duplicate correlated level — ORB already claimed this ticker/direction on a colliding breakout level',
    });
    return {
      executed: false,
      reason: DUPLICATE_CORRELATED_LEVEL_REASON,
      detail: collision.detail,
    };
  }

  const environment = await getStrategyEnvironment('premarket');
  const maxPositions = getPremarketMaxPositions(environment);

  const openCount = await getPremarketOpenPositionCount();
  if (openCount >= maxPositions) {
    await sendPremarketSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: `Max open premarket positions (${maxPositions}) reached [${environment}]`,
    });
    return { executed: false, reason: 'max_positions' };
  }

  const budgetRemaining = await getPremarketBudgetRemaining();
  if (budgetRemaining <= 0) {
    await sendPremarketBudgetExhaustedTelegram(await getTotalAllocated('premarket'));
    return { executed: false, reason: 'budget_exhausted' };
  }

  let strikeSelection;
  try {
    strikeSelection = await selectPremarketStrike(entry);
  } catch (err) {
    console.error(`[Premarket] Strike selection failed for ${entry.symbol}:`, err.message);
    await sendPremarketSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: err.message,
    });
    return { executed: false, reason: 'strike_error' };
  }

  // Prefer ask (buy-side quote at confirmation); fall back to selector entry premium.
  const entryQuote = Number.isFinite(Number(strikeSelection.ask))
    ? Number(strikeSelection.ask)
    : Number(strikeSelection.premium);
  if (isPremiumBelowFloor(entryQuote, PREMARKET_MIN_ENTRY_PREMIUM)) {
    console.log(
      `[Premarket] ${ENTRY_BELOW_PREMIUM_FLOOR_REASON} — ${entry.symbol} ${entry.direction}` +
        ` quote=$${entryQuote} floor=$${PREMARKET_MIN_ENTRY_PREMIUM}` +
        ` (ask=${strikeSelection.ask} premium=${strikeSelection.premium})`
    );
    await logPremarketEvent({
      ticker: entry.symbol,
      tradeDate: etDateKey(),
      eventType: ENTRY_BELOW_PREMIUM_FLOOR_REASON,
      direction: entry.direction,
      breakoutLevel: entry.breakout_level,
      details: {
        reason: ENTRY_BELOW_PREMIUM_FLOOR_REASON,
        entry_quote: entryQuote,
        ask: strikeSelection.ask,
        premium: strikeSelection.premium,
        bid: strikeSelection.bid,
        mid: strikeSelection.mid,
        min_entry_premium: PREMARKET_MIN_ENTRY_PREMIUM,
        strike: strikeSelection.strike,
      },
    });
    await sendPremarketSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: `Entry premium $${entryQuote} below minimum floor ($${PREMARKET_MIN_ENTRY_PREMIUM})`,
    });
    return { executed: false, reason: ENTRY_BELOW_PREMIUM_FLOOR_REASON };
  }

  const bid = Number(strikeSelection.bid);
  const ask = Number(strikeSelection.ask);
  const mid = Number(strikeSelection.mid ?? strikeSelection.premium);
  if (Number.isFinite(bid) && Number.isFinite(ask) && Number.isFinite(mid) && mid > 0) {
    const spreadPct = (ask - bid) / mid;
    if (spreadPct > PREMARKET_MAX_SPREAD_PCT) {
      console.log(
        `[Premarket] ${SPREAD_TOO_WIDE_REJECTED_REASON} — ${entry.symbol} ${entry.direction}` +
          ` spreadPct=${(spreadPct * 100).toFixed(1)}%` +
          ` (bid=${bid} ask=${ask} mid=${mid}; max=${(PREMARKET_MAX_SPREAD_PCT * 100).toFixed(0)}%)`
      );
      await logPremarketEvent({
        ticker: entry.symbol,
        tradeDate: etDateKey(),
        eventType: SPREAD_TOO_WIDE_REJECTED_REASON,
        direction: entry.direction,
        breakoutLevel: entry.breakout_level,
        details: {
          reason: SPREAD_TOO_WIDE_REJECTED_REASON,
          bid,
          ask,
          mid,
          spread_pct: spreadPct,
          max_spread_pct: PREMARKET_MAX_SPREAD_PCT,
          strike: strikeSelection.strike,
          premium: strikeSelection.premium,
        },
      });
      await sendPremarketSignalNotExecutedTelegram({
        ticker: entry.symbol,
        direction: entry.direction,
        reason:
          `Spread too wide (${(spreadPct * 100).toFixed(1)}% of mid > ${(PREMARKET_MAX_SPREAD_PCT * 100).toFixed(0)}% max)`,
      });
      return { executed: false, reason: SPREAD_TOO_WIDE_REJECTED_REASON, spreadPct };
    }
  }

  const ivStops = computePremarketIvStopPcts(strikeSelection.entry_iv);

  const sizing = positionSize(budgetRemaining, openCount, strikeSelection.premium, maxPositions);
  if (!sizing.affordable || sizing.quantity < 1 || sizing.totalCost > budgetRemaining) {
    console.log(
      `[Premarket] skip entry ${entry.symbol}: 0 contracts affordable ` +
        `budget=$${Number(budgetRemaining).toFixed(2)} premium=$${strikeSelection.premium} ` +
        `contractCost=$${Number(sizing.requiredCost).toFixed(2)} (notional+$${OPTION_OPENING_COMMISSION_PER_CONTRACT} fee)`
    );
    await sendPremarketInsufficientBudgetTelegram({
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
      { initialStopPct: ivStops.softStopPct }
    );
    const order = await placeOptionOrder({
      ticker: strikeSelection.symbol,
      direction: strikeSelection.direction,
      strike: strikeSelection.strike,
      expiration: strikeSelection.expiration,
      quantity: sizing.quantity,
      premium: strikeSelection.premium,
      environment,
      strategy: 'premarket',
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
      strategy: 'premarket',
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
        logPremarketEvent({
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
        `[Premarket] ${strikeSelection.symbol} booked qty=${bookedQty} using selection quote ` +
          `$${strikeSelection.premium} — broker fill price was missing`
      );
    }
    const realizedCost = bookedQty * contractEntryCost(
      bookedPremium,
      OPTION_OPENING_COMMISSION_PER_CONTRACT
    );

    if (entry.gate_removed_entry === true) {
      console.log(
        `[Premarket] ${GATE_REMOVED_ENTRY_REASON} fill path — ${strikeSelection.symbol} ${strikeSelection.direction}` +
          ` would_have=${entry.would_have_rejected_reason}` +
          ` breaches=${(entry.confirm_metrics?.breaches || []).join(',') || 'n/a'}`
      );
    }

    const positionId = await insertPremarketPosition({
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
      premarket_high: entry.premarket_high,
      premarket_low: entry.premarket_low,
      breakout_level: entry.breakout_level,
      breakout_direction: entry.breakout_direction,
      confirmation_candles_json: JSON.stringify(entry.confirmation_candles),
      strike_bucket: strikeSelection.strike_bucket,
      entry_iv: strikeSelection.entry_iv,
      entry_delta: strikeSelection.entry_delta,
      entry_metadata_json: JSON.stringify({
        breakout_candle: entry.breakout_candle,
        breakout_distance: entry.breakout_distance,
        entry_policy: entry.entry_policy ?? 'control',
        confirm_metrics: entry.confirm_metrics ?? null,
        gate_removed_entry: entry.gate_removed_entry === true,
        would_have_rejected_reason: entry.would_have_rejected_reason ?? null,
        spot: strikeSelection.spot,
        bid: strikeSelection.bid,
        ask: strikeSelection.ask,
        mid: strikeSelection.mid,
        iv_stop_mult: ivStops.ivMult,
        effective_soft_stop_pct: ivStops.softStopPct,
        effective_hard_stop_pct: ivStops.hardStopPct,
        hard_stop_trigger_pct: ivStops.hardStopPct,
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

    // Premarket: resting broker stop tracks flat SOFT (1%); hard 1.75% is poll/attribution.
    const brokerStop = createLadderBrokerStopHandlers({
      strategy: 'premarket',
      environment,
      initialStopPct: ivStops.softStopPct,
      hardStopPct: ivStops.hardStopPct,
      updateBrokerStopState: updatePremarketPositionBrokerStop,
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
      await updatePremarketPositionBrokerStop(positionId, {
        broker_stop_order_id: order.stopOrderId,
        broker_stop_trigger_price: order.stopTrigger ?? stopParams?.stopTrigger ?? null,
        broker_stop_pnl_frac: order.stopPnlFrac ?? stopParams?.stopPnlFrac ?? null,
      });
      console.log(
        `[Premarket] OTO stop resting #${positionId} order=${order.stopOrderId} trigger=$${order.stopTrigger ?? stopParams?.stopTrigger}`
      );
    } else {
      kickInitialStopUntilProtected(
        brokerStop,
        openedPosition,
        buildInitialStopRetryExtras({
          strategy: 'premarket',
          position: openedPosition,
          getOpenPositions: getPremarketOpenPositions,
          environment,
          fullClosePosition: closePremarketPosition,
          onNotify: async (pos, reason, pnlFrac) => {
            await sendPremarketTradeClosedTelegram({
              ticker: pos.ticker,
              reason,
              pnlPct: pnlFrac,
            });
          },
        })
      );
    }

    console.log(
      `[Premarket] Opened ${strikeSelection.symbol} qty=${bookedQty} ` +
        `(requested=${sizing.quantity} filled=${order.fillQuantity ?? 'n/a'}) ` +
        `cost=$${Number(realizedCost).toFixed(2)} ` +
        `ladder entry_contracts=${bookedQty}` +
        (order.bracketType
          ? ` bracket=${order.bracketType}`
          : ' broker_stop retry=started')
    );

    await reportEntryFillQty({
      strategy: 'premarket',
      ticker: strikeSelection.symbol,
      direction: strikeSelection.direction,
      strike: strikeSelection.strike,
      positionId,
      breakoutLevel: entry.breakout_level,
      requestedQty: sizing.quantity,
      bookedQty,
      order,
      logEvent: async ({ ticker, eventType, direction, breakoutLevel, details }) =>
        logPremarketEvent({
          ticker,
          tradeDate: etDateKey(),
          eventType,
          direction,
          breakoutLevel,
          details,
        }),
    });

    await sendPremarketTradeOpenedTelegram({
      ticker: strikeSelection.symbol,
      direction: strikeSelection.direction,
      premium: strikeSelection.premium,
      paper: order.paper,
      strike: strikeSelection.strike,
      strikeBucket: strikeSelection.strike_bucket,
    });

    return { executed: true, order, strikeSelection };
  } catch (err) {
    console.error(`[Premarket] Order failed for ${entry.symbol}:`, err.message);
    await sendPremarketSignalNotExecutedTelegram({
      ticker: entry.symbol,
      direction: entry.direction,
      reason: err.message,
    });
    return { executed: false, reason: 'execution_error', error: err.message };
  }
}

export async function runPremarketScanAndExecute() {
  if (!isWithinPremarketSession()) {
    return { skipped: true, reason: 'outside_premarket_session' };
  }

  const intervalMinutes = 5;
  // Cron fires at bar open. Wait for Tradier to finalize the bar that just
  // closed, then evaluate that completed bar — never the one that just opened.
  await waitForCompletedBarSettle({ intervalMinutes, label: 'Premarket' });

  const tradeDate = etDateKey();
  const results = [];

  for (const symbol of PREMARKET_SYMBOLS) {
    try {
      const bars = await getExtendedFiveMinuteBars(symbol, tradeDate);
      persistUnderlyingBarsInBackground(symbol, bars, { source: 'premarket-scan' });
      const completedBars = filterCompletedBars(bars, {
        intervalMinutes,
        now: new Date(),
      });
      let rangeState = await updatePremarketRange(symbol, completedBars, tradeDate);

      if (!isAfterMarketOpen()) {
        continue;
      }

      const postOpenBars = getPostOpenBars(completedBars);
      const newBars = filterNewBars(postOpenBars, rangeState.fsm.last_processed_bar_time);

      if (newBars.length === 0) {
        continue;
      }

      const closes = await listPremarketBreakoutCloseOutcomes({ ticker: symbol, tradeDate });
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
          `[Premarket] Catch-up replay for ${symbol}: ${replayBarCount} historical bar(s) processed without execution, ${suppressedEntryCount} entry signal(s) suppressed`
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
      console.error(`[Premarket] Scan failed for ${symbol}:`, err.message);
      results.push({ symbol, executed: false, reason: 'scan_error', error: err.message });
    }
  }

  return { skipped: false, results };
}
