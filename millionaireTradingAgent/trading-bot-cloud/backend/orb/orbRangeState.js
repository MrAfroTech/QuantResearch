import {
  getOrbRangeState,
  upsertOrbRangeState,
  logOrbEvent,
} from './orbDb.js';
import {
  getFiveMinuteBars,
  etDateKey,
  isOpeningRangeBar,
  isAfterRangeEnd,
  barEtMinutes,
} from './tradierTimesales.js';

const DEFAULT_FSM = {
  phase: 'idle',
  direction: null,
  breakout_level: null,
  breakout_candle: null,
  breakout_bar_time: null,
};

function parseFsm(raw) {
  if (!raw) return { ...DEFAULT_FSM };
  try {
    return { ...DEFAULT_FSM, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_FSM };
  }
}

function computeOpeningRange(bars) {
  const rangeBars = bars.filter(isOpeningRangeBar);
  if (rangeBars.length === 0) return null;

  const highs = rangeBars.map((b) => b.high).filter(Number.isFinite);
  const lows = rangeBars.map((b) => b.low).filter(Number.isFinite);
  if (!highs.length || !lows.length) return null;

  return {
    orHigh: Math.max(...highs),
    orLow: Math.min(...lows),
    barCount: rangeBars.length,
    bars: rangeBars,
  };
}

export async function loadSymbolRangeState(symbol, tradeDate = etDateKey()) {
  const row = await getOrbRangeState(symbol, tradeDate);
  if (!row) {
    return {
      symbol,
      tradeDate,
      orHigh: null,
      orLow: null,
      rangeComplete: false,
      fsm: { ...DEFAULT_FSM },
    };
  }
  return {
    symbol,
    tradeDate,
    orHigh: row.or_high,
    orLow: row.or_low,
    rangeComplete: Boolean(row.range_complete),
    fsm: parseFsm(row.fsm_json),
  };
}

export async function persistSymbolRangeState(state) {
  await upsertOrbRangeState({
    symbol: state.symbol,
    tradeDate: state.tradeDate,
    orHigh: state.orHigh,
    orLow: state.orLow,
    rangeComplete: state.rangeComplete,
    fsmJson: state.fsm,
  });
}

/**
 * Update opening range from intraday bars. Marks range complete once past 9:45 ET
 * and at least one opening-range bar exists.
 */
export async function updateOpeningRange(symbol, bars, tradeDate = etDateKey()) {
  const state = await loadSymbolRangeState(symbol, tradeDate);
  const computed = computeOpeningRange(bars);

  if (computed) {
    state.orHigh = computed.orHigh;
    state.orLow = computed.orLow;
  }

  if (isAfterRangeEnd() && state.orHigh != null && state.orLow != null) {
    state.rangeComplete = true;
    if (state.fsm.phase === 'idle') {
      state.fsm.phase = 'watching';
    }
  }

  await persistSymbolRangeState(state);
  return state;
}

export function getPostRangeBars(bars) {
  return bars.filter((bar) => {
    const mins = barEtMinutes(bar);
    return mins != null && mins >= 9 * 60 + 45;
  });
}

export { DEFAULT_FSM, parseFsm, computeOpeningRange };
