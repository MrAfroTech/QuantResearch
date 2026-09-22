import { getOrbRangeState } from '../orb/orbDb.js';
import { getPremarketRangeRow } from '../premarketBreakout/premarketDb.js';
import { getSql } from '../sqlClient.js';
import { etDateKey } from '../orb/tradierTimesales.js';

/**
 * ORB ↔ Premarket level-collision guard.
 *
 * When both strategies' breakout levels for the same ticker+direction are close
 * relative to that day's range width, the second strategy to fire is blocked —
 * first confirmed entry wins.
 *
 * Threshold: gap ≤ 25% of min(OR width, PM width).
 * Evidence:
 *   - 2026-07-31 SPY PUT: gap 1.44% of minW → collide (both stopped)
 *   - 2026-07-31 QQQ PUT: gap 8.35% → collide (both stopped)
 *   - 2026-07-24 SPY PUT: gap 3.23% → collide (both stopped)
 *   - 2026-07-24 IWM PUT: gap 18.42% → collide (both stopped)
 *   - 2026-07-31 IWM / 2026-07-24 QQQ: ~50%+ → distinct levels, allow both
 */
export const LEVEL_COLLISION_FRAC_OF_MIN_RANGE = 0.25;

export const DUPLICATE_CORRELATED_LEVEL_REASON = 'duplicate_correlated_level';

export function levelsCollide({
  levelA,
  levelB,
  rangeWidthA,
  rangeWidthB,
  frac = LEVEL_COLLISION_FRAC_OF_MIN_RANGE,
}) {
  const a = Number(levelA);
  const b = Number(levelB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;

  const wa = Number(rangeWidthA);
  const wb = Number(rangeWidthB);
  const widths = [wa, wb].filter((w) => Number.isFinite(w) && w > 0);
  if (widths.length === 0) {
    // No usable range width — fall back to 10 bps of price level.
    return Math.abs(a - b) <= Math.abs(a) * 0.001;
  }

  const minW = Math.min(...widths);
  return Math.abs(a - b) <= frac * minW;
}

function rangeWidth(high, low) {
  const h = Number(high);
  const l = Number(low);
  if (!Number.isFinite(h) || !Number.isFinite(l)) return null;
  const w = h - l;
  return w > 0 ? w : null;
}

async function loadRangeWidths(ticker, tradeDate) {
  const [orbRow, pmRow] = await Promise.all([
    getOrbRangeState(ticker, tradeDate),
    getPremarketRangeRow(ticker, tradeDate),
  ]);
  return {
    orbWidth: rangeWidth(orbRow?.or_high, orbRow?.or_low),
    pmWidth: rangeWidth(pmRow?.pm_high, pmRow?.pm_low),
    orbLow: orbRow?.or_low != null ? Number(orbRow.or_low) : null,
    orbHigh: orbRow?.or_high != null ? Number(orbRow.or_high) : null,
    pmLow: pmRow?.pm_low != null ? Number(pmRow.pm_low) : null,
    pmHigh: pmRow?.pm_high != null ? Number(pmRow.pm_high) : null,
  };
}

/**
 * Peer claims = OPEN positions or filled trade_log rows today for ticker+direction.
 * Zero-fill closes (entry_unfilled_cancelled / entry_never_filled) do not claim the slot.
 */
async function fetchPeerClaims({ peerStrategy, ticker, direction, tradeDate }) {
  const sql = getSql();
  const day = String(tradeDate).slice(0, 10);

  // 0DTE rows use expiration = ET trade date (same key as breakout idempotency).
  if (peerStrategy === 'orb') {
    const open = await sql`
      SELECT id, breakout_level, opened_at, status, 'position' AS source
      FROM orb_positions
      WHERE ticker = ${ticker}
        AND direction = ${direction}
        AND expiration = ${day}
        AND status = 'OPEN'
    `;
    const closed = await sql`
      SELECT id, breakout_level, opened_at, close_reason, 'trade_log' AS source
      FROM orb_trade_log
      WHERE ticker = ${ticker}
        AND direction = ${direction}
        AND expiration = ${day}
        AND COALESCE(close_reason, '') NOT IN ('entry_unfilled_cancelled', 'entry_never_filled')
    `;
    return [...open, ...closed];
  }

  const open = await sql`
    SELECT id, breakout_level, opened_at, status, 'position' AS source
    FROM premarket_positions
    WHERE ticker = ${ticker}
      AND direction = ${direction}
      AND expiration = ${day}
      AND status = 'OPEN'
  `;
  const closed = await sql`
    SELECT id, breakout_level, opened_at, close_reason, 'trade_log' AS source
    FROM premarket_trade_log
    WHERE ticker = ${ticker}
      AND direction = ${direction}
      AND expiration = ${day}
      AND COALESCE(close_reason, '') NOT IN ('entry_unfilled_cancelled', 'entry_never_filled')
  `;
  return [...open, ...closed];
}

/**
 * @param {'orb'|'premarket'} claimingStrategy
 * @returns {Promise<{
 *   blocked: boolean,
 *   reason: string|null,
 *   detail: object|null,
 * }>}
 */
export async function getOrbPremarketLevelCollisionGate({
  claimingStrategy,
  ticker,
  direction,
  breakoutLevel,
  tradeDate = etDateKey(),
}) {
  const claimer = String(claimingStrategy || '').toLowerCase();
  if (claimer !== 'orb' && claimer !== 'premarket') {
    return { blocked: false, reason: null, detail: null };
  }

  const peer = claimer === 'orb' ? 'premarket' : 'orb';
  const level = Number(breakoutLevel);
  if (!Number.isFinite(level)) {
    return { blocked: false, reason: null, detail: null };
  }

  const day = String(tradeDate).slice(0, 10);
  const [widths, peerClaims] = await Promise.all([
    loadRangeWidths(ticker, day),
    fetchPeerClaims({ peerStrategy: peer, ticker, direction, tradeDate: day }),
  ]);

  if (!peerClaims.length) {
    return { blocked: false, reason: null, detail: null };
  }

  // Deduplicate by breakout_level (position + trade_log can both exist briefly).
  const seenLevels = new Set();
  for (const claim of peerClaims) {
    const peerLevel = Number(claim.breakout_level);
    if (!Number.isFinite(peerLevel)) continue;
    const key = peerLevel.toFixed(4);
    if (seenLevels.has(key)) continue;
    seenLevels.add(key);

    const collide = levelsCollide({
      levelA: level,
      levelB: peerLevel,
      rangeWidthA: widths.orbWidth,
      rangeWidthB: widths.pmWidth,
    });

    if (collide) {
      const gap = Math.abs(level - peerLevel);
      const minW =
        widths.orbWidth != null && widths.pmWidth != null
          ? Math.min(widths.orbWidth, widths.pmWidth)
          : widths.orbWidth ?? widths.pmWidth;
      return {
        blocked: true,
        reason: DUPLICATE_CORRELATED_LEVEL_REASON,
        detail: {
          claimingStrategy: claimer,
          peerStrategy: peer,
          ticker,
          direction,
          claimingLevel: level,
          peerLevel,
          gap,
          orbWidth: widths.orbWidth,
          pmWidth: widths.pmWidth,
          minWidth: minW,
          fracOfMinWidth: minW ? gap / minW : null,
          thresholdFrac: LEVEL_COLLISION_FRAC_OF_MIN_RANGE,
          peerClaimSource: claim.source,
          peerOpenedAt: claim.opened_at != null ? String(claim.opened_at) : null,
        },
      };
    }
  }

  return { blocked: false, reason: null, detail: null };
}
