/**
 * Dollar P&L for closed option legs.
 * Never-opened closes (entry cancelled / never filled) must be $0 — no trade occurred.
 */

const NEVER_OPENED_CLOSE_REASONS = new Set([
  'entry_unfilled_cancelled',
  'entry_never_filled',
]);

export function isNeverOpenedCloseReason(reason) {
  return NEVER_OPENED_CLOSE_REASONS.has(String(reason || '').toLowerCase());
}

/**
 * Realized P&L in dollars for one closed leg.
 * @param {{ entryPremium: number, exitPremium: number, quantity?: number, closeReason?: string }} args
 */
export function computeRealizedPnlDollars({
  entryPremium,
  exitPremium,
  quantity = 1,
  closeReason,
}) {
  if (isNeverOpenedCloseReason(closeReason)) return 0;

  const entry = Number(entryPremium);
  const exit = Number(exitPremium);
  const qty = Number(quantity);
  const contracts = Number.isFinite(qty) && qty > 0 ? qty : 1;
  if (!Number.isFinite(entry) || !Number.isFinite(exit)) return 0;
  return (exit - entry) * 100 * contracts;
}
