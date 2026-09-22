/**
 * Confirmation-bar quality gate for ORB / Premarket / EMA-VWAP.
 *
 * Finding (sandbox fills 2026-07-30 + 2026-07-31 only): winners confirm on
 * quiet bars; losers disproportionately confirm on explosive bars (large range,
 * high volume, large overshoot past the level). Thresholds are the winner
 * maxima from that 2-day sample, rounded slightly up for float safety.
 *
 * PROVISIONAL — n=5 winners. Revisit as more real trading days accumulate.
 * Do not retune from pre-2026-07-30 local-simulation data.
 * Recalibration job enforces REAL_EXECUTION_START_DATE ('2026-07-30') as a hard floor.
 */

/** Max confirmation-bar range as a fraction of bar mid (9.0 bps). Winner max was 8.94 bps. */
export const MAX_CONFIRM_RANGE_PCT = 0.0009;

/** Max close-past-level overshoot as a fraction of bar mid (18.0 bps). Winner max was 17.81 bps. */
export const MAX_CONFIRM_OVERSHOOT_PCT = 0.0018;

/** Max confirmation-bar volume. Winner max was 114,495. */
export const MAX_CONFIRM_VOLUME = 115_000;

export const CONFIRMATION_TOO_EXPLOSIVE_REASON = 'confirmation_too_explosive';
/** ORB/Premarket/EMA: former reject now admitted. */
export const GATE_REMOVED_ENTRY_REASON = 'gate_removed_entry';

/**
 * @param {object} bar - OHLC (+ volume) bar
 * @param {{ direction: 'CALL'|'PUT', level: number|null|undefined }} opts
 *   level = breakout level (ORB/PM) or VWAP at cross (EMA)
 * @returns {{
 *   ok: boolean,
 *   reason: string|null,
 *   breaches: string[],
 *   metrics: object,
 * }}
 */
export function assessConfirmationBarQuality(bar, { direction, level } = {}) {
  const high = Number(bar?.high);
  const low = Number(bar?.low);
  const close = Number(bar?.close);
  const volume = bar?.volume != null ? Number(bar.volume) : null;
  const range = high - low;
  const mid = (high + low) / 2;

  // Missing/invalid bar data → do not block (fail open on data quality).
  if (!(mid > 0) || !Number.isFinite(range) || !Number.isFinite(close)) {
    return {
      ok: true,
      reason: null,
      breaches: [],
      metrics: { range: null, rangePct: null, volume, overshoot: null, overshootPct: null },
    };
  }

  const rangePct = range / mid;
  let overshoot = null;
  let overshootPct = null;
  if (level != null && Number.isFinite(Number(level))) {
    const lvl = Number(level);
    const dir = String(direction || '').toUpperCase();
    overshoot = dir === 'CALL' ? close - lvl : lvl - close;
    overshootPct = overshoot / mid;
  }

  const breaches = [];
  if (rangePct > MAX_CONFIRM_RANGE_PCT) breaches.push('range');
  if (overshootPct != null && overshootPct > MAX_CONFIRM_OVERSHOOT_PCT) {
    breaches.push('overshoot');
  }
  if (volume != null && Number.isFinite(volume) && volume > MAX_CONFIRM_VOLUME) {
    breaches.push('volume');
  }

  const metrics = {
    range,
    rangePct,
    volume,
    overshoot,
    overshootPct,
    thresholds: {
      max_range_pct: MAX_CONFIRM_RANGE_PCT,
      max_overshoot_pct: MAX_CONFIRM_OVERSHOOT_PCT,
      max_volume: MAX_CONFIRM_VOLUME,
    },
  };

  if (!breaches.length) {
    return { ok: true, reason: null, breaches: [], metrics };
  }

  return {
    ok: false,
    reason: CONFIRMATION_TOO_EXPLOSIVE_REASON,
    breaches,
    metrics,
  };
}
