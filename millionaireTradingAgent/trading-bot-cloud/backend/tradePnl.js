/**
 * Dollar P&L for closed option legs.
 * Never-opened closes (entry cancelled / never filled) must be $0 — no trade occurred.
 *
 * Stored realized_pnl stays premium-only (computeRealizedPnlDollars).
 * Dashboard / calendar display subtracts Tastytrade opening commission.
 */

import { OPTION_OPENING_COMMISSION_PER_CONTRACT } from './ladder/ladderConfig.js';

const NEVER_OPENED_CLOSE_REASONS = new Set([
  'entry_unfilled_cancelled',
  'entry_never_filled',
]);

export function isNeverOpenedCloseReason(reason) {
  return NEVER_OPENED_CLOSE_REASONS.has(String(reason || '').toLowerCase());
}

export function tradeContractCount(trade) {
  const qty = Number(
    trade?.quantity ?? trade?.entry_contracts ?? trade?.contracts ?? trade?.contracts_open
  );
  return Number.isFinite(qty) && qty > 0 ? qty : 1;
}

/** $1 per contract opening fee. Never-opened closes are $0. */
export function tradeCommissionDollars(trade) {
  if (isNeverOpenedCloseReason(trade?.close_reason ?? trade?.closeReason)) return 0;
  return tradeContractCount(trade) * OPTION_OPENING_COMMISSION_PER_CONTRACT;
}

function grossPnlFromPremiums(trade) {
  const entry = Number(trade?.entry_premium ?? trade?.entryPremium) || 0;
  const exit = Number(trade?.exit_premium ?? trade?.exitPremium) || 0;
  return (exit - entry) * 100 * tradeContractCount(trade);
}

/** Premium P&L as stored / used by halt and risk — no commission. */
export function grossRealizedPnlDollars(trade) {
  if (isNeverOpenedCloseReason(trade?.close_reason ?? trade?.closeReason)) return 0;
  if (trade?.realized_pnl != null && Number.isFinite(Number(trade.realized_pnl))) {
    return Number(trade.realized_pnl);
  }
  return grossPnlFromPremiums(trade);
}

/** Dashboard / calendar P&L after Tastytrade $1/contract opening commission. */
export function displayPnlDollars(trade) {
  return grossRealizedPnlDollars(trade) - tradeCommissionDollars(trade);
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
