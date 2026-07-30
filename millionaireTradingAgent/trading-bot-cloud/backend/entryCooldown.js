import { getSql } from './sqlClient.js';

/**
 * After a stop-loss, wait this long before the same ticker+direction
 * may be re-entered — even if a new setup otherwise qualifies.
 * Prevents immediate whipsaw re-entry without a blanket same-day ban.
 */
export const STOP_LOSS_REENTRY_COOLDOWN_MS = 20 * 60 * 1000;

const STRATEGY_STOP_LOSS_QUERY = {
  swing: {
    table: 'trade_log',
    // swing trade_log has no strategy column; all rows are swing
  },
  orb: { table: 'orb_trade_log' },
  premarket: { table: 'premarket_trade_log' },
  emavwap: { table: 'emavwap_trade_log' },
};

function parseClosedAtMs(closedAt) {
  if (closedAt == null) return null;
  if (closedAt instanceof Date) {
    const ms = closedAt.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const raw = String(closedAt).trim();
  // "2026-07-29 15:10:24.759371+00" → ISO-ish
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {'swing'|'orb'|'premarket'|'emavwap'} strategy
 * @param {string} ticker
 * @param {string} direction
 * @returns {Promise<{ blocked: boolean, remainingMs: number, closedAt: string|null }>}
 */
export async function getStopLossReentryCooldown({ strategy, ticker, direction }) {
  const key = String(strategy || '').toLowerCase();
  const cfg = STRATEGY_STOP_LOSS_QUERY[key];
  if (!cfg) {
    return { blocked: false, remainingMs: 0, closedAt: null };
  }

  const sql = getSql();
  const table = cfg.table;
  const rows = await sql`
    SELECT closed_at
    FROM ${sql(table)}
    WHERE ticker = ${ticker}
      AND direction = ${direction}
      AND close_reason = 'stop_loss'
    ORDER BY closed_at DESC
    LIMIT 1
  `;

  const closedAt = rows[0]?.closed_at ?? null;
  const closedMs = parseClosedAtMs(closedAt);
  if (closedMs == null) {
    return { blocked: false, remainingMs: 0, closedAt };
  }

  const elapsed = Date.now() - closedMs;
  if (elapsed >= STOP_LOSS_REENTRY_COOLDOWN_MS) {
    return { blocked: false, remainingMs: 0, closedAt: closedAt != null ? String(closedAt) : null };
  }

  return {
    blocked: true,
    remainingMs: STOP_LOSS_REENTRY_COOLDOWN_MS - elapsed,
    closedAt: closedAt != null ? String(closedAt) : null,
  };
}

export function formatCooldownRemaining(remainingMs) {
  const sec = Math.max(0, Math.ceil(Number(remainingMs) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
