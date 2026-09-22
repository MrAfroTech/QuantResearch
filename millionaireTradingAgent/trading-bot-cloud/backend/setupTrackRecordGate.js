/**
 * Proven-track-record entry sizing gate — all four strategies.
 *
 * A setup = strategy + ticker + direction + signal_type.
 * Status is only ever **proven** (normal ladder sizing) or **trial** (1 contract).
 * There is no hard block — unproven / failing setups stay tradeable at trial size.
 *
 * Rolling re-judgment: once a setup has ≥ SETUP_TRIAL_CLOSED_TRADES closed entries,
 * the most recent N trades' cumulative realized_pnl decides proven vs trial.
 * A setup can move between proven and trial as that rolling window changes.
 */

import { getSql } from './sqlClient.js';
import { etDateKey } from './orb/tradierTimesales.js';
import {
  REAL_EXECUTION_START_DATE,
  isOnOrAfterRealExecution,
} from './analytics/realExecutionFloor.js';

/** Rolling window size (also minimum closes before proven is possible). Configurable. */
export const SETUP_TRIAL_CLOSED_TRADES = 3;

/** Trial entries always size to this many contracts. */
export const SETUP_TRIAL_CONTRACTS = 1;

/** Canonical signal_type labels for 0DTE strategies (no per-row signal_type column). */
export const SETUP_SIGNAL_TYPES = {
  orb: 'orb_breakout',
  premarket: 'premarket_breakout',
  emavwap: 'ema_vwap_cross',
};

const EXCLUDED_CLOSE_REASONS = new Set(['entry_unfilled_cancelled']);

const STRATEGY_LOG = {
  swing: {
    table: 'trade_log',
    signalExpr: (row) => row.signal_type || 'unknown',
    realizedPnl: swingRealizedPnl,
    openTable: 'positions',
  },
  orb: {
    table: 'orb_trade_log',
    signalExpr: () => SETUP_SIGNAL_TYPES.orb,
    realizedPnl: (row) => Number(row.realized_pnl),
    openTable: 'orb_positions',
  },
  premarket: {
    table: 'premarket_trade_log',
    signalExpr: () => SETUP_SIGNAL_TYPES.premarket,
    realizedPnl: (row) => Number(row.realized_pnl),
    openTable: 'premarket_positions',
  },
  emavwap: {
    table: 'emavwap_trade_log',
    signalExpr: () => SETUP_SIGNAL_TYPES.emavwap,
    realizedPnl: (row) => Number(row.realized_pnl),
    openTable: 'emavwap_positions',
  },
};

function swingRealizedPnl(row) {
  const entry = Number(row.entry_premium);
  const exit = Number(row.exit_premium);
  const qty = Number(row.quantity) || 0;
  if (Number.isFinite(entry) && Number.isFinite(exit)) {
    return (exit - entry) * 100 * qty;
  }
  const pct = Number(row.pnl_pct);
  if (Number.isFinite(entry) && Number.isFinite(pct)) {
    return entry * (pct / 100) * 100 * qty;
  }
  return NaN;
}

function normalizeKey({ strategy, ticker, direction, signalType }) {
  return {
    strategy: String(strategy || '').toLowerCase(),
    ticker: String(ticker || '').toUpperCase(),
    direction: String(direction || '').toUpperCase(),
    signalType: String(signalType || 'unknown'),
  };
}

let schemaReady;

export async function ensureSetupTrackRecordSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const sql = getSql();
    await sql`
      CREATE TABLE IF NOT EXISTS setup_track_record_overrides (
        strategy TEXT NOT NULL,
        ticker TEXT NOT NULL,
        direction TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        mode TEXT NOT NULL,
        reset_after TEXT,
        note TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (strategy, ticker, direction, signal_type)
      )
    `;
  })();
  return schemaReady;
}

/**
 * Manual override / reset.
 * - mode 'reset': ignore history at/before now; restart trial counting
 * - mode 'force_proven': always full size
 * - mode 'clear': remove override
 * (force_blocked removed — blocking is not a valid state.)
 */
export async function setSetupTrackRecordOverride({
  strategy,
  ticker,
  direction,
  signalType,
  mode,
  note = null,
}) {
  await ensureSetupTrackRecordSchema();
  const key = normalizeKey({ strategy, ticker, direction, signalType });
  const sql = getSql();

  if (mode === 'clear') {
    await sql`
      DELETE FROM setup_track_record_overrides
      WHERE strategy = ${key.strategy}
        AND ticker = ${key.ticker}
        AND direction = ${key.direction}
        AND signal_type = ${key.signalType}
    `;
    return { ...key, mode: 'clear' };
  }

  if (mode === 'force_blocked') {
    throw new Error(
      'force_blocked is no longer supported — setups stay at trial size instead of blocking'
    );
  }

  if (!['reset', 'force_proven'].includes(mode)) {
    throw new Error(`Invalid setup track-record mode: ${mode}`);
  }

  const resetAfter = mode === 'reset' ? new Date().toISOString() : null;
  await sql`
    INSERT INTO setup_track_record_overrides (
      strategy, ticker, direction, signal_type, mode, reset_after, note, updated_at
    ) VALUES (
      ${key.strategy}, ${key.ticker}, ${key.direction}, ${key.signalType},
      ${mode}, ${resetAfter}, ${note}, NOW()::text
    )
    ON CONFLICT (strategy, ticker, direction, signal_type) DO UPDATE SET
      mode = EXCLUDED.mode,
      reset_after = EXCLUDED.reset_after,
      note = EXCLUDED.note,
      updated_at = EXCLUDED.updated_at
  `;
  return { ...key, mode, reset_after: resetAfter, note };
}

async function getOverride(key) {
  await ensureSetupTrackRecordSchema();
  const sql = getSql();
  const [row] = await sql`
    SELECT * FROM setup_track_record_overrides
    WHERE strategy = ${key.strategy}
      AND ticker = ${key.ticker}
      AND direction = ${key.direction}
      AND signal_type = ${key.signalType}
  `;
  return row || null;
}

/**
 * Load closed entries for a setup, grouped by opened_at (ladder legs → one trade).
 * Ordered oldest-first. Excludes unfilled cancels and still-open partials.
 */
export async function loadSetupClosedEntries({ strategy, ticker, direction, signalType }) {
  const key = normalizeKey({ strategy, ticker, direction, signalType });
  const spec = STRATEGY_LOG[key.strategy];
  if (!spec) {
    throw new Error(`Unknown strategy for setup track record: ${key.strategy}`);
  }

  const sql = getSql();
  const rows = await sql`
    SELECT * FROM ${sql(spec.table)}
    WHERE UPPER(ticker) = ${key.ticker}
      AND UPPER(direction) = ${key.direction}
    ORDER BY opened_at ASC, closed_at ASC
  `;

  const openRows = await sql`
    SELECT opened_at FROM ${sql(spec.openTable)}
    WHERE UPPER(ticker) = ${key.ticker}
      AND UPPER(direction) = ${key.direction}
      AND status = 'OPEN'
  `.catch(() => []);
  const openOpenedAt = new Set((openRows || []).map((r) => String(r.opened_at)));

  const byOpened = new Map();
  for (const raw of rows) {
    if (EXCLUDED_CLOSE_REASONS.has(raw.close_reason)) continue;
    const rowSignal = spec.signalExpr(raw);
    if (String(rowSignal) !== key.signalType) continue;
    const openedAt = String(raw.opened_at);
    if (openOpenedAt.has(openedAt)) continue;

    // Ignore local-sim history before real Tastytrade-routed execution.
    const openedDay = (() => {
      const d = new Date(raw.opened_at);
      return Number.isNaN(d.getTime()) ? null : etDateKey(d);
    })();
    if (!isOnOrAfterRealExecution(openedDay)) continue;

    const pnl = spec.realizedPnl(raw);
    const existing = byOpened.get(openedAt) || { opened_at: openedAt, realized_pnl: 0, legs: 0 };
    if (Number.isFinite(pnl)) existing.realized_pnl += pnl;
    existing.legs += 1;
    byOpened.set(openedAt, existing);
  }

  return [...byOpened.values()].sort((a, b) => String(a.opened_at).localeCompare(String(b.opened_at)));
}

/**
 * Evaluate setup status for entry sizing.
 * @returns {{ status: 'trial'|'proven', closedCount, windowPnl, trialSize, detail }}
 */
export async function getSetupTrackRecordGate({ strategy, ticker, direction, signalType }) {
  const key = normalizeKey({ strategy, ticker, direction, signalType });
  const override = await getOverride(key);

  if (override?.mode === 'force_proven') {
    return {
      status: 'proven',
      closedCount: null,
      windowPnl: null,
      trialPnl: null,
      trialSize: SETUP_TRIAL_CONTRACTS,
      detail: 'force_proven_override',
      key,
    };
  }

  // Legacy force_blocked rows (if any) degrade to perpetual trial — never hard-block.
  if (override?.mode === 'force_blocked') {
    return {
      status: 'trial',
      closedCount: null,
      windowPnl: null,
      trialPnl: null,
      trialSize: SETUP_TRIAL_CONTRACTS,
      detail: 'legacy_force_blocked_as_trial',
      key,
    };
  }

  let closed = await loadSetupClosedEntries(key);
  if (override?.mode === 'reset' && override.reset_after) {
    closed = closed.filter((e) => String(e.opened_at) > String(override.reset_after));
  }

  const closedCount = closed.length;
  if (closedCount < SETUP_TRIAL_CLOSED_TRADES) {
    const windowPnl = closed.reduce((s, e) => s + e.realized_pnl, 0);
    return {
      status: 'trial',
      closedCount,
      windowPnl,
      trialPnl: windowPnl,
      trialSize: SETUP_TRIAL_CONTRACTS,
      detail: `trial_${closedCount}_of_${SETUP_TRIAL_CLOSED_TRADES}`,
      key,
    };
  }

  // Rolling window: most recent N closed entries.
  const window = closed.slice(-SETUP_TRIAL_CLOSED_TRADES);
  const windowPnl = window.reduce((s, e) => s + e.realized_pnl, 0);
  if (windowPnl > 0) {
    return {
      status: 'proven',
      closedCount,
      windowPnl,
      trialPnl: windowPnl,
      trialSize: SETUP_TRIAL_CONTRACTS,
      detail: 'proven_rolling_window',
      key,
    };
  }

  return {
    status: 'trial',
    closedCount,
    windowPnl,
    trialPnl: windowPnl,
    trialSize: SETUP_TRIAL_CONTRACTS,
    detail: 'trial_rolling_window_not_positive',
    key,
  };
}

/**
 * @deprecated No longer used for sizing. Kept as a pass-through so any stale
 * caller cannot force 1-contract trial sizing. Trial/proven status is display-only.
 */
export function applyTrialSizing(sizing, premium, gate, budgetRemaining, feePerContract = 0) {
  void premium;
  void gate;
  void budgetRemaining;
  void feePerContract;
  return sizing;
}
