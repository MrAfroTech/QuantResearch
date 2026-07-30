import { logOrbEvent } from './orbDb.js';
import { candleBody } from './tradierTimesales.js';

/**
 * Breakout FSM:
 * watching -> breakout_detected -> awaiting_confirmation -> entry_ready
 * Any close on wrong side of breakout level -> invalidate -> watching
 */

export function evaluateOrbSignals(rangeState, postRangeBars) {
  const events = [];
  const entries = [];

  if (!rangeState.rangeComplete || rangeState.orHigh == null || rangeState.orLow == null) {
    return { rangeState, events, entries };
  }

  const fsm = { ...rangeState.fsm };
  const { orHigh, orLow } = rangeState;

  for (const bar of postRangeBars) {
    const result = processBar(bar, fsm, orHigh, orLow, rangeState.symbol);
    Object.assign(fsm, result.fsm);
    if (result.event) events.push(result.event);
    if (result.entry) entries.push(result.entry);
  }

  rangeState.fsm = fsm;
  return { rangeState, events, entries };
}

function processBar(bar, fsm, orHigh, orLow, symbol) {
  const next = { fsm: { ...fsm }, event: null, entry: null };

  if (fsm.phase === 'idle' || fsm.phase === 'watching') {
    if (bar.close > orHigh) {
      next.fsm = {
        phase: 'awaiting_confirmation',
        direction: 'CALL',
        breakout_level: orHigh,
        breakout_candle: serializeBar(bar),
        breakout_bar_time: bar.time,
      };
      return next;
    }
    if (bar.close < orLow) {
      next.fsm = {
        phase: 'awaiting_confirmation',
        direction: 'PUT',
        breakout_level: orLow,
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
        next.fsm = { phase: 'watching', direction: null, breakout_level: null, breakout_candle: null, breakout_bar_time: null };
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
        next.entry = buildEntry(symbol, direction, orHigh, orLow, fsm, bar);
        next.fsm = { phase: 'watching', direction: null, breakout_level: null, breakout_candle: null, breakout_bar_time: null };
        return next;
      }
      return next;
    }

    if (direction === 'PUT') {
      if (bar.close > level) {
        next.fsm = { phase: 'watching', direction: null, breakout_level: null, breakout_candle: null, breakout_bar_time: null };
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
        next.entry = buildEntry(symbol, direction, orHigh, orLow, fsm, bar);
        next.fsm = { phase: 'watching', direction: null, breakout_level: null, breakout_candle: null, breakout_bar_time: null };
        return next;
      }
      return next;
    }
  }

  return next;
}

function buildEntry(symbol, direction, orHigh, orLow, fsm, confirmationBar) {
  return {
    symbol,
    direction,
    opening_range_high: orHigh,
    opening_range_low: orLow,
    breakout_level: fsm.breakout_level,
    breakout_direction: direction,
    breakout_candle: fsm.breakout_candle,
    confirmation_candles: [fsm.breakout_candle, serializeBar(confirmationBar)],
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
    body: candleBody(bar),
  };
}

export async function persistInvalidationEvents(events, tradeDate) {
  for (const event of events) {
    if (event.type !== 'breakout_invalidated') continue;
    await logOrbEvent({
      ticker: event.symbol,
      tradeDate,
      eventType: event.type,
      direction: event.direction,
      breakoutLevel: event.breakout_level,
      details: event,
    });
  }
}
