/**
 * Earliest calendar day (ET date key) of real Tastytrade-routed execution.
 *
 * Local-simulation fills before this date are frictionless / not broker-constrained
 * and must never feed confirmation-bar recalibration, diagnosis lookbacks,
 * suggestion engines, or setup track-record judgment.
 *
 * Do not silently lower this. If real-execution history is intentionally
 * re-baselined, update this constant explicitly and redeploy.
 */
export const REAL_EXECUTION_START_DATE = '2026-07-30';

/** Raise a lookback/start date key so it never precedes real execution. */
export function clampToRealExecutionStart(dateKey) {
  if (!dateKey || typeof dateKey !== 'string') return REAL_EXECUTION_START_DATE;
  return dateKey < REAL_EXECUTION_START_DATE ? REAL_EXECUTION_START_DATE : dateKey;
}

export function isOnOrAfterRealExecution(dateKey) {
  return Boolean(dateKey) && dateKey >= REAL_EXECUTION_START_DATE;
}
