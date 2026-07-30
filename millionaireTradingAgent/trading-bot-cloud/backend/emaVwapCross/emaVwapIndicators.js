import { EMA_PERIOD } from './emaVwapConfig.js';
import { barEtMinutes } from '../orb/tradierTimesales.js';

function typicalPrice(bar) {
  return (bar.high + bar.low + bar.close) / 3;
}

/**
 * Session-anchored VWAP and 9EMA on 5-min bars (regular session).
 * Bars should be sorted oldest → newest, session-only.
 */
export function computeSessionIndicators(bars) {
  let cumulativePv = 0;
  let cumulativeVolume = 0;
  let ema = null;
  const multiplier = 2 / (EMA_PERIOD + 1);
  const enriched = [];

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const tp = typicalPrice(bar);
    const vol = Number(bar.volume) || 0;

    if (vol > 0) {
      cumulativePv += tp * vol;
      cumulativeVolume += vol;
    }

    const vwap = cumulativeVolume > 0 ? cumulativePv / cumulativeVolume : null;

    if (i + 1 < EMA_PERIOD) {
      ema = null;
    } else if (i + 1 === EMA_PERIOD) {
      const seed = bars.slice(0, EMA_PERIOD).reduce((sum, b) => sum + b.close, 0) / EMA_PERIOD;
      ema = seed;
    } else if (ema != null) {
      ema = bar.close * multiplier + ema * (1 - multiplier);
    }

    enriched.push({
      ...bar,
      vwap,
      ema9: ema,
      et_minutes: barEtMinutes(bar),
      indicators_ready: vwap != null && ema != null,
    });
  }

  return enriched;
}

export function emaSide(ema, vwap) {
  if (ema == null || vwap == null) return 'unknown';
  if (ema > vwap) return 'above';
  if (ema < vwap) return 'below';
  return 'equal';
}
