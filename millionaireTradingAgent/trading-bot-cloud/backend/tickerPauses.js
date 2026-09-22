/**
 * Deliberate per-ticker / per-direction entry pauses.
 * Easy to re-enable: remove or comment the matching rule.
 *
 * SOFI PUT (Swing): 0% WR / −$318 (n=7), largely re-entry cascades before
 * the same-day win/loss gate. Pause until enough post-gate data accumulates.
 */
const PAUSED_ENTRIES = [
  {
    strategy: 'swing',
    ticker: 'SOFI',
    direction: 'PUT',
    reason: 'ticker_paused_sofi_put',
    note: 'Paused after 0/7 WR (−$318); re-evaluate once win/loss re-entry gate has a clean sample',
  },
];

/**
 * @param {'swing'|'orb'|'premarket'|'emavwap'} strategy
 * @param {string} ticker
 * @param {string} direction
 * @returns {{ blocked: boolean, reason: string|null, note: string|null }}
 */
export function getTickerPauseGate({ strategy, ticker, direction }) {
  const strat = String(strategy || '').toLowerCase();
  const t = String(ticker || '').toUpperCase();
  const d = String(direction || '').toUpperCase();

  const hit = PAUSED_ENTRIES.find(
    (r) => r.strategy === strat && r.ticker === t && r.direction === d
  );
  if (!hit) return { blocked: false, reason: null, note: null };
  return { blocked: true, reason: hit.reason, note: hit.note };
}
