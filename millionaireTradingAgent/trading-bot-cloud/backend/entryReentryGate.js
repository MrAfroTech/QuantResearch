import { getSql } from './sqlClient.js';
import { etDateKey } from './orb/tradierTimesales.js';
import {
  computeRealizedPnlDollars,
  isNeverOpenedCloseReason,
} from './tradePnl.js';
import {
  FLASH_STOP_MAX_HOLD_MS,
  holdMsFromTimestamps,
  isFlashStopHold,
} from './zeroDte/spentBreakoutLevel.js';

/**
 * Same-day win/loss re-entry gate (replaces the former 20-min stop-loss cooldown).
 *
 * Per strategy + ticker + direction + ET trading day:
 * - No prior real win/loss today → allow
 * - Most recent real outcome was a WIN (pnl > 0) → allow re-entry
 * - Most recent real outcome was a LOSS (pnl < 0) → block for the rest of the day
 * - $0 / never-opened closes are skipped when finding "most recent"
 * - Flash losses (held under FLASH_STOP_MAX_HOLD_MS, 60s) do not count as a
 *   same-day loss. A loss held 60s or longer still blocks.
 */

const STRATEGY_TRADE_LOG = {
  swing: { table: 'trade_log', hasRealizedPnl: false },
  orb: { table: 'orb_trade_log', hasRealizedPnl: true },
  premarket: { table: 'premarket_trade_log', hasRealizedPnl: true },
  emavwap: { table: 'emavwap_trade_log', hasRealizedPnl: true },
};

const ALLOW = {
  blocked: false,
  reason: null,
  lastOutcome: null,
  lastPnl: null,
  lastClosedAt: null,
  lastCloseReason: null,
};

function closedAtEtDateKey(closedAt) {
  if (closedAt == null) return null;
  const d = closedAt instanceof Date ? closedAt : new Date(String(closedAt));
  if (Number.isFinite(d.getTime())) return etDateKey(d);
  const raw = String(closedAt).trim();
  const prefix = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(prefix) ? prefix : null;
}

function tradeRealizedPnl(row) {
  if (isNeverOpenedCloseReason(row.close_reason)) return 0;
  if (row.realized_pnl != null && Number.isFinite(Number(row.realized_pnl))) {
    return Number(row.realized_pnl);
  }
  return computeRealizedPnlDollars({
    entryPremium: row.entry_premium,
    exitPremium: row.exit_premium,
    quantity: row.quantity,
    closeReason: row.close_reason,
  });
}

function isFlashLoss(row, pnl) {
  if (!(pnl < 0)) return false;
  const holdMs = holdMsFromTimestamps(row.opened_at, row.closed_at);
  return isFlashStopHold(holdMs);
}

function gateFromLastReal(row, pnl) {
  if (pnl < 0) {
    return {
      blocked: true,
      reason: 'same_day_loss_block',
      lastOutcome: 'loss',
      lastPnl: pnl,
      lastClosedAt: row.closed_at != null ? String(row.closed_at) : null,
      lastCloseReason: row.close_reason ?? null,
    };
  }
  return {
    blocked: false,
    reason: null,
    lastOutcome: 'win',
    lastPnl: pnl,
    lastClosedAt: row.closed_at != null ? String(row.closed_at) : null,
    lastCloseReason: row.close_reason ?? null,
  };
}

/**
 * Pure evaluator — same rules as getSameDayReentryGate, no I/O.
 * @param {{ rows: object[], tradeDate: string }} args
 */
export function evaluateSameDayReentry({ rows, tradeDate }) {
  const dayKey = String(tradeDate).slice(0, 10);
  let lastReal = null;
  for (const row of rows || []) {
    if (closedAtEtDateKey(row.closed_at) !== dayKey) continue;
    const pnl = tradeRealizedPnl(row);
    if (!Number.isFinite(pnl) || pnl === 0) continue;
    if (isFlashLoss(row, pnl)) continue;
    lastReal = { row, pnl };
    break;
  }
  if (!lastReal) return { ...ALLOW };
  return gateFromLastReal(lastReal.row, lastReal.pnl);
}

/**
 * @param {'swing'|'orb'|'premarket'|'emavwap'} strategy
 * @param {string} ticker
 * @param {string} direction
 * @param {string} [tradeDate] ET YYYY-MM-DD (defaults to today ET)
 */
export async function getSameDayReentryGate({
  strategy,
  ticker,
  direction,
  tradeDate = etDateKey(),
}) {
  const key = String(strategy || '').toLowerCase();
  const cfg = STRATEGY_TRADE_LOG[key];
  if (!cfg) return { ...ALLOW };

  const sql = getSql();
  const dayKey = String(tradeDate).slice(0, 10);

  // Identifier-safe: table names come only from the static map above.
  const rows = cfg.hasRealizedPnl
    ? await sql.unsafe(
        `SELECT id, entry_premium, exit_premium, quantity, realized_pnl, close_reason, opened_at, closed_at
         FROM ${cfg.table}
         WHERE ticker = $1 AND direction = $2
         ORDER BY closed_at DESC
         LIMIT 50`,
        [ticker, direction]
      )
    : await sql.unsafe(
        `SELECT id, entry_premium, exit_premium, quantity, close_reason, opened_at, closed_at
         FROM ${cfg.table}
         WHERE ticker = $1 AND direction = $2
         ORDER BY closed_at DESC
         LIMIT 50`,
        [ticker, direction]
      );

  return evaluateSameDayReentry({ rows, tradeDate: dayKey });
}

export { FLASH_STOP_MAX_HOLD_MS };
