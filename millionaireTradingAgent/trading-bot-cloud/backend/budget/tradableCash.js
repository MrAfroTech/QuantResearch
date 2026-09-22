/**
 * Tradable live cash from a Tastytrade GET /accounts/{id}/balances payload.
 * Settled cash-balance plus signed pending-cash (Credit adds, Debit subtracts).
 */

function parseNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function field(data, ...keys) {
  for (const key of keys) {
    const parsed = parseNumber(data?.[key]);
    if (parsed != null) return parsed;
  }
  return null;
}

export function settledCashFromBalances(data) {
  return field(
    data,
    'cash-balance',
    'cash_balance',
    'cash-available-for-trading',
    'cash_available_for_trading'
  );
}

/**
 * pending-cash is an absolute magnitude; pending-cash-effect is Credit | Debit | None.
 */
export function signedPendingCashFromBalances(data) {
  const amount = field(data, 'pending-cash', 'pending_cash');
  if (amount == null || amount === 0) return 0;
  const effect = String(
    data?.['pending-cash-effect'] ?? data?.pending_cash_effect ?? ''
  ).toLowerCase();
  if (effect === 'debit') return -Math.abs(amount);
  if (effect === 'credit' || effect === '' || effect === 'none') {
    // Credit: add. None with a non-zero amount still counts so pending is not dropped.
    return effect === 'none' ? 0 : Math.abs(amount);
  }
  return amount;
}

/** Settled cash + signed pending cash, floored at 0. */
export function computeTradableCashBalance(data) {
  const settled = settledCashFromBalances(data) ?? 0;
  const tradable = settled + signedPendingCashFromBalances(data);
  return Math.max(0, Number(tradable.toFixed(4)));
}
