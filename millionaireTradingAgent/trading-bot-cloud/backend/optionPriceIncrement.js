/**
 * Equity-option minimum price variation (MPV) helpers for Tastytrade order prices.
 *
 * Rules (tastytrade / OCC Penny Interval Program):
 * - SPY, QQQ, IWM: $0.01 at all premiums
 * - Other penny-program names (default here): $0.01 below $3, $0.05 at/above $3
 * - Non-penny names use $0.05 / $0.10 — we default to penny-program tiers because
 *   most watched equities are in the program; a wrong nickel/dime tier still needs
 *   broker feedback, but sub-penny prices are always invalid.
 *
 * Apply immediately before API submission so mid/markup math cannot reintroduce
 * sub-penny precision downstream.
 */

/** Ultra-liquid ETFs that trade in pennies at every premium. */
export const ALWAYS_PENNY_UNDERLYINGS = new Set(['SPY', 'QQQ', 'IWM']);

/**
 * Extract underlying root from an OCC / Tastytrade option symbol.
 * e.g. "PTON  260815C00005000" → "PTON"
 */
export function underlyingFromOptionSymbol(optionSymbol) {
  const raw = String(optionSymbol || '').trim();
  if (!raw) return null;
  const match = raw.match(/^\/?([A-Za-z0-9.]+)/);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Minimum price increment for a given premium and underlying.
 * @param {number} price
 * @param {string|null} underlying
 */
export function optionPriceIncrement(price, underlying = null) {
  const u = String(underlying || '').toUpperCase();
  if (ALWAYS_PENNY_UNDERLYINGS.has(u)) return 0.01;

  const p = Number(price);
  if (!Number.isFinite(p)) return 0.01;
  // Penny Interval Program default tiers
  return p < 3 ? 0.01 : 0.05;
}

/**
 * Round an option limit/stop price to a valid exchange increment.
 * Returns a number with no excess float noise (safe to String() into the API).
 */
export function roundOptionLimitPrice(price, { underlying = null } = {}) {
  const raw = Number(price);
  if (!Number.isFinite(raw) || raw <= 0) return null;

  const increment = optionPriceIncrement(raw, underlying);
  const rounded = Math.round(raw / increment) * increment;
  // Guard float artifacts (e.g. 0.15000000000000002)
  const fixed = Number(rounded.toFixed(2));
  // Never round to zero for a positive input — bump one tick
  if (fixed <= 0) return Number(increment.toFixed(2));
  return fixed;
}

/** Format for Tastytrade JSON body (always two decimal places for equity options). */
export function formatOptionPriceForApi(price, { underlying = null } = {}) {
  const rounded = roundOptionLimitPrice(price, { underlying });
  if (rounded == null) return null;
  return rounded.toFixed(2);
}
