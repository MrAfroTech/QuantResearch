import { emaSide } from './emaVwapIndicators.js';

const DEFAULT_FSM = {
  ema_side: 'unknown',
  last_processed_bar_time: null,
};

export function parseFsm(raw) {
  if (!raw) return { ...DEFAULT_FSM };
  try {
    return { ...DEFAULT_FSM, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_FSM };
  }
}

/**
 * Cross FSM: track prior EMA vs VWAP side; fire entry on side flip at bar close.
 * After entry, reset ema_side to current side so a new cross is required.
 */
export function evaluateEmaVwapSignals(symbol, enrichedBars, fsm) {
  const entries = [];
  const nextFsm = { ...fsm };

  for (const bar of enrichedBars) {
    if (!bar.indicators_ready) continue;

    const currentSide = emaSide(bar.ema9, bar.vwap);
    if (currentSide === 'unknown' || currentSide === 'equal') {
      continue;
    }

    const priorSide = nextFsm.ema_side;

    if (priorSide === 'below' && currentSide === 'above') {
      entries.push(buildEntry(symbol, 'CALL', bar));
      nextFsm.ema_side = 'above';
      continue;
    }

    if (priorSide === 'above' && currentSide === 'below') {
      entries.push(buildEntry(symbol, 'PUT', bar));
      nextFsm.ema_side = 'below';
      continue;
    }

    nextFsm.ema_side = currentSide;
  }

  if (enrichedBars.length > 0) {
    nextFsm.last_processed_bar_time = enrichedBars[enrichedBars.length - 1].time;
  }

  return { fsm: nextFsm, entries };
}

function buildEntry(symbol, direction, bar) {
  return {
    symbol,
    direction,
    cross_direction: direction,
    vwap_at_entry: bar.vwap,
    ema_at_entry: bar.ema9,
    cross_candle: serializeBar(bar),
    underlying_price: bar.close,
    ema_vwap_gap: Math.abs(bar.ema9 - bar.vwap),
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
    vwap: bar.vwap,
    ema9: bar.ema9,
  };
}
