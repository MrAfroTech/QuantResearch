/**
 * Known bug-affected windows for trade scoring metadata.
 * Add entries here when incidents are confirmed — no schema change required.
 */
export const KNOWN_BUG_WINDOWS = [
  {
    id: 'swing_missing_expiration_ticker',
    strategies: ['swing'],
    startDate: '2026-07-14',
    endDate: '2026-07-18',
    note: 'findMonthlyExpiration() called without ticker — swing executions failed with Tradier 400',
  },
  {
    id: 'swing_sma200_short_lookback',
    strategies: ['swing'],
    startDate: '2026-07-14',
    endDate: '2026-07-18',
    note: 'daysAgo(210) returned ~142 bars — SMA200 gate skipped on every scan until widened to 320',
  },
  {
    id: 'swing_no_entry_idempotency',
    strategies: ['swing'],
    startDate: '2026-07-20',
    endDate: '2026-07-20',
    note: 'Persistent downtrend PUT re-entered every 5-min poll until MAX_POSITIONS (no per-day idempotency)',
  },
  {
    id: 'premarket_catchup_replay',
    strategies: ['premarket'],
    startDate: '2026-07-15',
    endDate: '2026-07-15',
    note: 'Post-restart catch-up replay fired duplicate IWM entries in one poll before idempotency guard',
  },
];

export function matchKnownBugWindow(trade, strategy) {
  const tradeDate = trade.trade_date;
  if (!tradeDate) return { flagged: false, bug_note: null };

  const matches = KNOWN_BUG_WINDOWS.filter((window) => {
    if (!window.strategies.includes(strategy)) return false;
    return tradeDate >= window.startDate && tradeDate <= window.endDate;
  });

  if (matches.length === 0) {
    return { flagged: false, bug_note: null };
  }

  return {
    flagged: true,
    bug_note: matches.map((m) => `${m.id}: ${m.note}`).join(' | '),
  };
}
