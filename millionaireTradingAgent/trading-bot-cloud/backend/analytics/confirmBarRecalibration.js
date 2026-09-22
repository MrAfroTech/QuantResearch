/**
 * Weekly confirmation-bar-quality threshold recalibration.
 *
 * Recomputes MAX_CONFIRM_RANGE_PCT / MAX_CONFIRM_OVERSHOOT_PCT / MAX_CONFIRM_VOLUME
 * from a rolling window of real 0DTE winners (ORB + Premarket + EMA/VWAP), using the
 * same winner-maxima methodology as the original diagnostic, then writes
 * pending suggested_changes — never auto-applies live thresholds.
 *
 * Why winner-maxima (not p95): preserves continuity with the gate's original
 * design (quiet-winner envelope). With a hard min-winner floor + per-cycle
 * magnitude cap, maxima remain interpretable without letting one volatile
 * week rewrite the envelope unboundedly. Revisit p95/IQR if winner n grows
 * large and maxima become outlier-dominated.
 */

import { getSql } from '../sqlClient.js';
import { etDateKey } from '../orb/tradierTimesales.js';
import {
  MAX_CONFIRM_RANGE_PCT,
  MAX_CONFIRM_OVERSHOOT_PCT,
  MAX_CONFIRM_VOLUME,
} from '../zeroDte/confirmationBarQuality.js';
import {
  ensureAnalyticsSchema,
  insertSuggestedChange,
  getSuggestedChanges,
} from './analyticsDb.js';
import { sendConfirmBarRecalSuggestionTelegram } from '../telegramHandler.js';
import {
  REAL_EXECUTION_START_DATE,
  clampToRealExecutionStart,
} from './realExecutionFloor.js';

export { REAL_EXECUTION_START_DATE };

/** Rolling lookback in calendar days (≈20–22 trading days). Matches "last ~30 days" ask; analytics daily suggestions use 7d — this job is intentionally longer. */
export const CONFIRM_BAR_RECAL_LOOKBACK_DAYS = Number(
  process.env.CONFIRM_BAR_RECAL_LOOKBACK_DAYS || 30
);

/** Skip cycle if fewer real winners with usable confirm-bar metrics. */
export const CONFIRM_BAR_RECAL_MIN_WINNERS = Number(
  process.env.CONFIRM_BAR_RECAL_MIN_WINNERS || 12
);

/** Max fractional move from current threshold in one cycle (30%). */
export const CONFIRM_BAR_RECAL_MAX_DELTA_FRAC = Number(
  process.env.CONFIRM_BAR_RECAL_MAX_DELTA_FRAC || 0.3
);

/** Cron override (default: Mondays 4:30pm ET). */
export const CONFIRM_BAR_RECAL_CRON =
  process.env.CONFIRM_BAR_RECAL_CRON || '30 16 * * 1';

const EXCLUDED_CLOSE = new Set(['entry_unfilled_cancelled']);

const CURRENT = {
  MAX_CONFIRM_RANGE_PCT,
  MAX_CONFIRM_OVERSHOOT_PCT,
  MAX_CONFIRM_VOLUME,
};

function parseJsonSafe(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseTs(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function lookbackStartDate(reportDate, lookbackDays) {
  const end = new Date(`${reportDate}T23:59:59`);
  const start = new Date(end);
  start.setDate(start.getDate() - (lookbackDays - 1));
  // Never reach into local-sim history, regardless of lookback length.
  return clampToRealExecutionStart(etDateKey(start));
}

function inLookback(closedAt, startKey, endKey) {
  const d = parseTs(closedAt);
  if (!d) return false;
  const day = etDateKey(d);
  return day >= startKey && day <= endKey;
}

/** Confirmation bar = last candle in ORB/PM array; EMA stores a single cross candle. */
function extractConfirmBar(trade, strategy) {
  if (strategy === 'ema_vwap') {
    const bar = parseJsonSafe(trade.cross_candle_json);
    if (!bar || typeof bar !== 'object') return null;
    return { bar, level: Number(bar.vwap) };
  }

  const candles = parseJsonSafe(trade.confirmation_candles_json);
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const bar = candles[candles.length - 1];
  const level = Number(trade.breakout_level);
  return {
    bar,
    level: Number.isFinite(level) ? level : null,
  };
}

function metricsFromBar(bar, direction, level) {
  const high = Number(bar?.high);
  const low = Number(bar?.low);
  const close = Number(bar?.close);
  const volume = bar?.volume != null ? Number(bar.volume) : null;
  const mid = (high + low) / 2;
  if (!(mid > 0) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
    return null;
  }

  const rangePct = (high - low) / mid;
  let overshootPct = null;
  if (level != null && Number.isFinite(level)) {
    const dir = String(direction || '').toUpperCase();
    const overshoot = dir === 'CALL' ? close - level : level - close;
    overshootPct = overshoot / mid;
  }

  return {
    rangePct,
    overshootPct,
    volume: Number.isFinite(volume) ? volume : null,
  };
}

/** Slight upward pad for float safety — same spirit as original 8.94→0.0009 style rounding. */
function padThreshold(rawMax, kind) {
  if (!Number.isFinite(rawMax) || rawMax < 0) return null;
  if (kind === 'volume') {
    return Math.ceil((rawMax * 1.005) / 1000) * 1000;
  }
  // fractions: pad 0.5% then ceil to 5 decimal places
  return Math.ceil(rawMax * 1.005 * 1e5) / 1e5;
}

function applyMagnitudeCap(current, rawSuggested, maxDeltaFrac) {
  const lo = current * (1 - maxDeltaFrac);
  const hi = current * (1 + maxDeltaFrac);
  const capped = Math.min(hi, Math.max(lo, rawSuggested));
  const wouldExceed = rawSuggested > hi + Number.EPSILON || rawSuggested < lo - Number.EPSILON;
  return { capped, raw: rawSuggested, wouldExceed, lo, hi };
}

function formatValue(parameter, value) {
  if (parameter === 'MAX_CONFIRM_VOLUME') return String(Math.round(value));
  return value.toFixed(6);
}

function confidenceLabel(winnerCount) {
  if (winnerCount >= 30) return 'HIGH';
  if (winnerCount >= 15) return 'MEDIUM';
  return 'LOW';
}

async function loadZeroDteClosedTrades() {
  const sql = getSql();
  const [orb, premarket, ema] = await Promise.all([
    sql`SELECT * FROM orb_trade_log ORDER BY closed_at`,
    sql`SELECT * FROM premarket_trade_log ORDER BY closed_at`,
    sql`SELECT * FROM emavwap_trade_log ORDER BY closed_at`,
  ]);
  return [
    ...orb.map((r) => ({ ...r, strategy: 'orb' })),
    ...premarket.map((r) => ({ ...r, strategy: 'premarket' })),
    ...ema.map((r) => ({ ...r, strategy: 'ema_vwap' })),
  ];
}

/**
 * Deduplicate ladder legs: one entry per (strategy, opened_at), sum realized_pnl.
 * Winner = net realized_pnl > 0.
 */
export function buildWinnerConfirmMetrics(trades, { startKey, endKey }) {
  const byEntry = new Map();

  for (const trade of trades) {
    if (EXCLUDED_CLOSE.has(trade.close_reason)) continue;
    if (!inLookback(trade.closed_at, startKey, endKey)) continue;

    const key = `${trade.strategy}|${trade.opened_at}|${trade.ticker}|${trade.direction}`;
    const existing = byEntry.get(key) || {
      strategy: trade.strategy,
      ticker: trade.ticker,
      direction: trade.direction,
      opened_at: trade.opened_at,
      realized_pnl: 0,
      sampleTrade: trade,
    };
    existing.realized_pnl += Number(trade.realized_pnl) || 0;
    // Prefer a row that still has confirm-bar payload.
    if (
      !extractConfirmBar(existing.sampleTrade, existing.strategy) &&
      extractConfirmBar(trade, trade.strategy)
    ) {
      existing.sampleTrade = trade;
    }
    byEntry.set(key, existing);
  }

  const winners = [];
  for (const entry of byEntry.values()) {
    if (!(entry.realized_pnl > 0)) continue;
    const extracted = extractConfirmBar(entry.sampleTrade, entry.strategy);
    if (!extracted) continue;
    const metrics = metricsFromBar(extracted.bar, entry.direction, extracted.level);
    if (!metrics) continue;
    winners.push({
      strategy: entry.strategy,
      ticker: entry.ticker,
      direction: entry.direction,
      opened_at: entry.opened_at,
      realized_pnl: entry.realized_pnl,
      metrics,
    });
  }

  return winners;
}

export function computeWinnerMaxima(winners) {
  let maxRange = -Infinity;
  let maxOvershoot = -Infinity;
  let maxVolume = -Infinity;
  let overshootN = 0;
  let volumeN = 0;

  for (const w of winners) {
    const { rangePct, overshootPct, volume } = w.metrics;
    if (Number.isFinite(rangePct)) maxRange = Math.max(maxRange, rangePct);
    if (Number.isFinite(overshootPct) && overshootPct >= 0) {
      maxOvershoot = Math.max(maxOvershoot, overshootPct);
      overshootN += 1;
    }
    if (Number.isFinite(volume)) {
      maxVolume = Math.max(maxVolume, volume);
      volumeN += 1;
    }
  }

  return {
    rangePct: Number.isFinite(maxRange) ? maxRange : null,
    overshootPct: overshootN > 0 && Number.isFinite(maxOvershoot) ? maxOvershoot : null,
    volume: volumeN > 0 && Number.isFinite(maxVolume) ? maxVolume : null,
    overshootN,
    volumeN,
  };
}

function buildParameterSuggestions({
  reportDate,
  startKey,
  endKey,
  winnerCount,
  maxima,
}) {
  const specs = [
    {
      parameter: 'MAX_CONFIRM_RANGE_PCT',
      current: CURRENT.MAX_CONFIRM_RANGE_PCT,
      rawMax: maxima.rangePct,
      kind: 'fraction',
    },
    {
      parameter: 'MAX_CONFIRM_OVERSHOOT_PCT',
      current: CURRENT.MAX_CONFIRM_OVERSHOOT_PCT,
      rawMax: maxima.overshootPct,
      kind: 'fraction',
    },
    {
      parameter: 'MAX_CONFIRM_VOLUME',
      current: CURRENT.MAX_CONFIRM_VOLUME,
      rawMax: maxima.volume,
      kind: 'volume',
    },
  ];

  const suggestions = [];
  for (const spec of specs) {
    if (spec.rawMax == null) continue;

    const padded = padThreshold(spec.rawMax, spec.kind);
    const { capped, raw, wouldExceed, lo, hi } = applyMagnitudeCap(
      spec.current,
      padded,
      CONFIRM_BAR_RECAL_MAX_DELTA_FRAC
    );

    const unchanged =
      spec.kind === 'volume'
        ? Math.round(capped) === Math.round(spec.current)
        : Math.abs(capped - spec.current) < 1e-9;
    if (unchanged) continue;

    const capNote = wouldExceed
      ? ` Raw padded max ${formatValue(spec.parameter, raw)} exceeded ±${(
          CONFIRM_BAR_RECAL_MAX_DELTA_FRAC * 100
        ).toFixed(0)}% band [${formatValue(spec.parameter, lo)}, ${formatValue(
          spec.parameter,
          hi
        )}] and was capped.`
      : '';

    suggestions.push({
      report_date: reportDate,
      strategy: 'zero_dte',
      parameter: spec.parameter,
      current_value: formatValue(spec.parameter, spec.current),
      suggested_value: formatValue(spec.parameter, capped),
      rationale:
        `Weekly confirm-bar recalibration (winner-maxima, ${winnerCount} real 0DTE winners ` +
        `${startKey}→${endKey}). Winner max ${spec.parameter.replace('MAX_CONFIRM_', '').toLowerCase()}=` +
        `${formatValue(spec.parameter, spec.rawMax)}; padded=${formatValue(spec.parameter, padded)}; ` +
        `suggested=${formatValue(spec.parameter, capped)} (cap ±${(
          CONFIRM_BAR_RECAL_MAX_DELTA_FRAC * 100
        ).toFixed(0)}%). Suggestion only — not auto-applied.` +
        capNote,
      confidence: confidenceLabel(winnerCount),
      meta: {
        winner_count: winnerCount,
        date_range: { start: startKey, end: endKey },
        raw_winner_max: spec.rawMax,
        padded,
        capped,
        magnitude_capped: wouldExceed,
      },
    });
  }

  return suggestions;
}

async function clearPendingConfirmBarSuggestions(reportDate) {
  await ensureAnalyticsSchema();
  const sql = getSql();
  await sql`
    DELETE FROM suggested_changes
    WHERE status = 'pending'
      AND strategy = 'zero_dte'
      AND parameter IN (
        'MAX_CONFIRM_RANGE_PCT',
        'MAX_CONFIRM_OVERSHOOT_PCT',
        'MAX_CONFIRM_VOLUME'
      )
      AND report_date = ${reportDate}
  `;
}

/**
 * @param {{ reportDate?: string, dryRun?: boolean, notify?: boolean }} [opts]
 */
export async function runConfirmBarRecalibration(opts = {}) {
  const reportDate = opts.reportDate || etDateKey();
  const dryRun = Boolean(opts.dryRun);
  const notify = opts.notify !== false && !dryRun;

  const startKey = lookbackStartDate(reportDate, CONFIRM_BAR_RECAL_LOOKBACK_DAYS);
  const endKey = reportDate;

  const trades = await loadZeroDteClosedTrades();
  const winners = buildWinnerConfirmMetrics(trades, { startKey, endKey });

  if (winners.length < CONFIRM_BAR_RECAL_MIN_WINNERS) {
    const skip = {
      skipped: true,
      reason: 'insufficient_winners',
      winner_count: winners.length,
      min_required: CONFIRM_BAR_RECAL_MIN_WINNERS,
      date_range: { start: startKey, end: endKey },
      lookback_days: CONFIRM_BAR_RECAL_LOOKBACK_DAYS,
      real_execution_floor: REAL_EXECUTION_START_DATE,
      current_thresholds: { ...CURRENT },
    };
    console.log(
      `[ConfirmBarRecal] skipped — winners=${winners.length} < min=${CONFIRM_BAR_RECAL_MIN_WINNERS}` +
        ` (window ${startKey}→${endKey}, floor=${REAL_EXECUTION_START_DATE})`
    );
    return skip;
  }

  const maxima = computeWinnerMaxima(winners);
  const suggestions = buildParameterSuggestions({
    reportDate: `confirm-bar-recal-${reportDate}`,
    startKey,
    endKey,
    winnerCount: winners.length,
    maxima,
  });

  const result = {
    skipped: false,
    report_date: `confirm-bar-recal-${reportDate}`,
    date_range: { start: startKey, end: endKey },
    lookback_days: CONFIRM_BAR_RECAL_LOOKBACK_DAYS,
    real_execution_floor: REAL_EXECUTION_START_DATE,
    winner_count: winners.length,
    winner_maxima: maxima,
    current_thresholds: { ...CURRENT },
    suggestions_preview: suggestions,
    stored_suggestions: [],
    dry_run: dryRun,
    methodology: 'winner_maxima_with_pad_and_magnitude_cap',
  };

  if (suggestions.length === 0) {
    console.log(
      `[ConfirmBarRecal] ${winners.length} winners — no material threshold changes vs current`
    );
    return result;
  }

  if (dryRun) {
    console.log(
      `[ConfirmBarRecal] dry-run — ${suggestions.length} suggestion(s), nothing written`
    );
    return result;
  }

  await clearPendingConfirmBarSuggestions(result.report_date);
  const stored = [];
  for (const suggestion of suggestions) {
    const { meta: _meta, ...row } = suggestion;
    stored.push(await insertSuggestedChange(row));
  }
  result.stored_suggestions = stored;

  if (notify) {
    await sendConfirmBarRecalSuggestionTelegram({
      reportDate: result.report_date,
      winnerCount: winners.length,
      dateRange: result.date_range,
      suggestions: stored,
    });
  }

  console.log(
    `[ConfirmBarRecal] wrote ${stored.length} pending suggestion(s) for ${result.report_date}`
  );
  return result;
}

/** For ops: list pending confirm-bar suggestions. */
export async function listPendingConfirmBarSuggestions() {
  const all = await getSuggestedChanges({ status: 'pending' });
  return all.filter(
    (s) =>
      s.strategy === 'zero_dte' &&
      String(s.parameter || '').startsWith('MAX_CONFIRM_')
  );
}
