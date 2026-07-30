import { logPremarketEvent } from './premarketDb.js';
import { barEtMinutes } from '../orb/tradierTimesales.js';

/**
 * Breakout FSM (close-only retest, same philosophy as ORB):
 * watching -> awaiting_confirmation -> entry on hold candle
 * Wrong-side close invalidates -> watching
 */

export function evaluatePremarketSignals(rangeState, postOpenBars) {
  const events = [];
  const entries = [];

  if (!rangeState.rangeComplete || rangeState.pmHigh == null || rangeState.pmLow == null) {
    return { rangeState, events, entries };
  }

  const fsm = { ...rangeState.fsm };
  const { pmHigh, pmLow } = rangeState;

  for (const bar of postOpenBars) {
    const result = processBar(bar, fsm, pmHigh, pmLow, rangeState.symbol);
    Object.assign(fsm, result.fsm);
    if (result.event) events.push(result.event);
    if (result.entry) entries.push(result.entry);
  }

  rangeState.fsm = fsm;
  return { rangeState, events, entries };
}

function processBar(bar, fsm, pmHigh, pmLow, symbol) {
  const next = { fsm: { ...fsm }, event: null, entry: null };

  if (fsm.phase === 'idle' || fsm.phase === 'watching') {
    if (bar.close > pmHigh) {
      next.fsm = {
        phase: 'awaiting_confirmation',
        direction: 'CALL',
        breakout_level: pmHigh,
        breakout_candle: serializeBar(bar),
        breakout_bar_time: bar.time,
      };
      return next;
    }
    if (bar.close < pmLow) {
      next.fsm = {
        phase: 'awaiting_confirmation',
        direction: 'PUT',
        breakout_level: pmLow,
        breakout_candle: serializeBar(bar),
        breakout_bar_time: bar.time,
      };
      return next;
    }
    next.fsm.phase = 'watching';
    return next;
  }

  if (fsm.phase === 'awaiting_confirmation') {
    const level = fsm.breakout_level;
    const direction = fsm.direction;

    if (direction === 'CALL') {
      if (bar.close < level) {
        next.fsm = resetFsm();
        next.event = {
          type: 'breakout_invalidated',
          symbol,
          direction: 'CALL',
          breakout_level: level,
          bar: serializeBar(bar),
          reason: 'close_below_breakout_level',
        };
        return next;
      }
      if (bar.close >= level && bar.time !== fsm.breakout_bar_time) {
        next.entry = buildEntry(symbol, direction, pmHigh, pmLow, fsm, bar);
        next.fsm = resetFsm();
        return next;
      }
      return next;
    }

    if (direction === 'PUT') {
      if (bar.close > level) {
        next.fsm = resetFsm();
        next.event = {
          type: 'breakout_invalidated',
          symbol,
          direction: 'PUT',
          breakout_level: level,
          bar: serializeBar(bar),
          reason: 'close_above_breakdown_level',
        };
        return next;
      }
      if (bar.close <= level && bar.time !== fsm.breakout_bar_time) {
        next.entry = buildEntry(symbol, direction, pmHigh, pmLow, fsm, bar);
        next.fsm = resetFsm();
        return next;
      }
      return next;
    }
  }

  return next;
}

function resetFsm() {
  return {
    phase: 'watching',
    direction: null,
    breakout_level: null,
    breakout_candle: null,
    breakout_bar_time: null,
  };
}

function buildEntry(symbol, direction, pmHigh, pmLow, fsm, confirmationBar) {
  const breakoutBar = fsm.breakout_candle;
  const distance =
    direction === 'CALL'
      ? breakoutBar.close - pmHigh
      : pmLow - breakoutBar.close;

  return {
    symbol,
    direction,
    premarket_high: pmHigh,
    premarket_low: pmLow,
    breakout_level: fsm.breakout_level,
    breakout_direction: direction,
    breakout_candle: breakoutBar,
    breakout_distance: distance,
    confirmation_candles: [breakoutBar, serializeBar(confirmationBar)],
    confirmation_bar: serializeBar(confirmationBar),
  };
}

function serializeBar(bar) {
  return {
    time: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    et_minutes: barEtMinutes(bar),
  };
}

export async function persistInvalidationEvents(events, tradeDate) {
  for (const event of events) {
    if (event.type !== 'breakout_invalidated') continue;
    await logPremarketEvent({
      ticker: event.symbol,
      tradeDate,
      eventType: event.type,
      direction: event.direction,
      breakoutLevel: event.breakout_level,
      details: event,
    });
  }
}
