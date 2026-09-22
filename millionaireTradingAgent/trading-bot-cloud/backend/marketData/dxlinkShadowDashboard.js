/**
 * Read-only DXLink shadow dashboard queries.
 * SELECT only — does not create tables, insert rows, or touch trading paths.
 */
import { getSql } from '../sqlClient.js';
import { etDateKey, getEtParts } from '../orb/tradierTimesales.js';
import { parseShadowPrice } from './dxlinkShadowPrices.js';
import { refreshShadowTradierTimesales, lookupShadowTradierClose } from './dxlinkShadowTradier.js';

export const DXLINK_SHADOW_CLOSE_TOLERANCE = 0.03;
export const DXLINK_SHADOW_BAR_LIMIT = 80;
export const DXLINK_SHADOW_DETECTION_LIMIT = 40;

const WEEKDAYS_FROM_MONDAY = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

export function isMissingRelationError(err) {
  return err?.code === '42P01' || /does not exist/i.test(String(err?.message || ''));
}

export function etWindowStartDate(windowKey, now = new Date()) {
  const today = etDateKey(now);
  if (windowKey !== 'week') return today;
  const { year, month, day, weekday } = getEtParts(now);
  const daysFromMonday = WEEKDAYS_FROM_MONDAY[weekday] ?? 0;
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() - daysFromMonday);
  return `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, '0')}-${String(utc.getUTCDate()).padStart(2, '0')}`;
}

export function classifyCloseMatch(dxlinkClose, tradierClose, tolerance = DXLINK_SHADOW_CLOSE_TOLERANCE) {
  const d = parseShadowPrice(dxlinkClose);
  const t = parseShadowPrice(tradierClose);
  if (d == null || t == null) {
    return { comparable: false, matched: false, diff: null };
  }
  const diff = Math.abs(d - t);
  return { comparable: true, matched: diff <= tolerance, diff };
}

export function numericMean(values) {
  const nums = values.map(Number).filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

export function numericMedian(values) {
  const nums = values.map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

export function summarizeBarMatches(rows, tolerance = DXLINK_SHADOW_CLOSE_TOLERANCE) {
  let comparable = 0;
  let matched = 0;
  for (const row of rows) {
    const result = classifyCloseMatch(row.dxlink_close, row.tradier_close, tolerance);
    if (result.comparable) {
      comparable += 1;
      if (result.matched) matched += 1;
    }
  }
  return {
    comparable,
    matched,
    incomplete: rows.length - comparable,
    match_rate: comparable ? matched / comparable : null,
    tolerance,
  };
}

export function summarizeDetections(rows) {
  if (!rows.length) {
    return {
      count: 0,
      empty: true,
      avg_latency_from_touch_ms: null,
      median_latency_from_touch_ms: null,
      avg_saved_vs_bar_close_ms: null,
      median_saved_vs_bar_close_ms: null,
    };
  }
  return {
    count: rows.length,
    empty: false,
    avg_latency_from_touch_ms: numericMean(rows.map((r) => r.latency_from_touch_ms)),
    median_latency_from_touch_ms: numericMedian(rows.map((r) => r.latency_from_touch_ms)),
    avg_saved_vs_bar_close_ms: numericMean(rows.map((r) => r.saved_vs_bar_close_ms)),
    median_saved_vs_bar_close_ms: numericMedian(rows.map((r) => r.saved_vs_bar_close_ms)),
  };
}

function emptyPayload(windowKey, sinceDate) {
  return {
    observational: true,
    not_used_for_trading: true,
    label: 'Shadow / Observational — Not used for trading decisions',
    window: windowKey,
    since_et: sinceDate,
    tolerance: DXLINK_SHADOW_CLOSE_TOLERANCE,
    bars: [],
    bar_match: summarizeBarMatches([]),
    detections: [],
    detection_latency: summarizeDetections([]),
  };
}

function toNullableNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function overlayTradierClose(row) {
  const dxlink = parseShadowPrice(row.dxlink_close);
  const stored = parseShadowPrice(row.tradier_close);
  if (stored != null) {
    return { tradier_close: stored, tradier_source: 'underlying_bars', reason: null };
  }
  const live = lookupShadowTradierClose(row.ticker, row.bar_time);
  if (live?.close != null) {
    return {
      tradier_close: live.close,
      tradier_source: 'tradier_timesales',
      reason: null,
    };
  }
  return {
    tradier_close: null,
    tradier_source: null,
    reason: dxlink != null ? 'tradier_row_not_persisted_yet' : null,
  };
}

export async function getDxlinkShadowDashboard({ window: windowKey = 'today' } = {}) {
  const windowNorm = windowKey === 'week' ? 'week' : 'today';
  const sinceDate = etWindowStartDate(windowNorm);
  const sinceBarTime = `${sinceDate}T00:00:00`;
  const empty = emptyPayload(windowNorm, sinceDate);

  let sql;
  try {
    sql = getSql();
  } catch (err) {
    return empty;
  }

  try {
    const [barStatsRows, bars, detectionStatsRows, detections] = await Promise.all([
      sql`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (
            WHERE dxlink_close IS NOT NULL AND dxlink_close <> 0
              AND tradier_close IS NOT NULL AND tradier_close <> 0
          )::int AS comparable,
          COUNT(*) FILTER (
            WHERE dxlink_close IS NOT NULL AND dxlink_close <> 0
              AND tradier_close IS NOT NULL AND tradier_close <> 0
              AND ABS(dxlink_close - tradier_close) <= ${DXLINK_SHADOW_CLOSE_TOLERANCE}
          )::int AS matched
        FROM dxlink_shadow_bars
        WHERE bar_time >= ${sinceBarTime}
      `,
      sql`
        SELECT ticker, bar_time, timeframe, dxlink_close, tradier_close, recorded_at
        FROM dxlink_shadow_bars
        WHERE bar_time >= ${sinceBarTime}
        ORDER BY bar_time DESC, ticker ASC
        LIMIT ${DXLINK_SHADOW_BAR_LIMIT}
      `,
      sql`
        SELECT
          COUNT(*)::int AS count,
          AVG(latency_from_touch_ms) AS avg_latency_from_touch_ms,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_from_touch_ms)
            AS median_latency_from_touch_ms,
          AVG(saved_vs_bar_close_ms) AS avg_saved_vs_bar_close_ms,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY saved_vs_bar_close_ms)
            AS median_saved_vs_bar_close_ms
        FROM dxlink_shadow_detections
        WHERE detected_at >= (${sinceDate}::timestamp AT TIME ZONE 'America/New_York')
      `,
      sql`
        SELECT
          id, ticker, strategy, direction, kind, level, price, detected_at,
          bar_close_eval_ts, latency_from_touch_ms, saved_vs_bar_close_ms
        FROM dxlink_shadow_detections
        WHERE detected_at >= (${sinceDate}::timestamp AT TIME ZONE 'America/New_York')
        ORDER BY detected_at DESC
        LIMIT ${DXLINK_SHADOW_DETECTION_LIMIT}
      `,
    ]);

    const barStats = barStatsRows[0] || {};
    const detStats = detectionStatsRows[0] || {};
    const detectionCount = Number(detStats.count) || 0;

    const missingTradier = (bars || []).some(
      (row) => parseShadowPrice(row.dxlink_close) != null && parseShadowPrice(row.tradier_close) == null
    );
    if (missingTradier) {
      const tickers = [...new Set((bars || []).map((row) => String(row.ticker || '').toUpperCase()).filter(Boolean))];
      await refreshShadowTradierTimesales(tickers, sinceDate).catch(() => null);
    }

    const mappedBars = (bars || []).map((row) => {
      const overlay = overlayTradierClose(row);
      const match = classifyCloseMatch(row.dxlink_close, overlay.tradier_close);
      return {
        ticker: row.ticker,
        bar_time: row.bar_time,
        timeframe: row.timeframe,
        dxlink_close: parseShadowPrice(row.dxlink_close),
        tradier_close: overlay.tradier_close,
        tradier_source: overlay.tradier_source,
        reason: overlay.reason,
        recorded_at: row.recorded_at,
        comparable: match.comparable,
        matched: match.matched,
        diff: match.diff,
      };
    });
    const overlayStats = summarizeBarMatches(mappedBars);

    return {
      ...empty,
      bars: mappedBars,
      bar_match: {
        comparable: overlayStats.comparable,
        matched: overlayStats.matched,
        incomplete: overlayStats.incomplete,
        match_rate: overlayStats.match_rate,
        tolerance: DXLINK_SHADOW_CLOSE_TOLERANCE,
        total: mappedBars.length,
        stored_comparable: Number(barStats.comparable) || 0,
      },
      detections: detections.map((row) => ({
        id: row.id,
        ticker: row.ticker,
        strategy: row.strategy,
        direction: row.direction,
        kind: row.kind,
        level: parseShadowPrice(row.level),
        price: parseShadowPrice(row.price),
        detected_at: row.detected_at,
        bar_close_eval_ts: row.bar_close_eval_ts != null ? Number(row.bar_close_eval_ts) : null,
        latency_from_touch_ms: toNullableNumber(row.latency_from_touch_ms),
        saved_vs_bar_close_ms: toNullableNumber(row.saved_vs_bar_close_ms),
      })),
      detection_latency: {
        count: detectionCount,
        empty: detectionCount === 0,
        avg_latency_from_touch_ms: toNullableNumber(detStats.avg_latency_from_touch_ms),
        median_latency_from_touch_ms: toNullableNumber(detStats.median_latency_from_touch_ms),
        avg_saved_vs_bar_close_ms: toNullableNumber(detStats.avg_saved_vs_bar_close_ms),
        median_saved_vs_bar_close_ms: toNullableNumber(detStats.median_saved_vs_bar_close_ms),
      },
    };
  } catch (err) {
    if (isMissingRelationError(err)) return empty;
    throw err;
  }
}
