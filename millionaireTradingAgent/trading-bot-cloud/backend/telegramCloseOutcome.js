import { isNeverOpenedCloseReason } from './tradePnl.js';

export const CLOSED_TRADE_ICON_WIN = '✅';
export const CLOSED_TRADE_ICON_LOSS = '❌';
export const CLOSED_TRADE_ICON_FLAT = '⚪';

/**
 * Display P&L percent for close alerts. Matches the historical `* 100 .toFixed(1)` format.
 * Non-finite values render as 0.0 so cancelled/unknown closes do not look like a loss.
 */
export function formatClosedPnlPct(pnlPct) {
  const n = Number(pnlPct);
  if (!Number.isFinite(n)) return '0.0';
  return (n * 100).toFixed(1);
}

/**
 * Icon for a closed-trade Telegram alert.
 * Branches on outcome, not open/closed state:
 *   ✅ win (displayed P&L > 0)
 *   ❌ loss (displayed P&L < 0)
 *   ⚪ breakeven / 0.0% / never filled
 */
export function closedTradeTelegramIcon({ reason, pnlPct, realizedPnl } = {}) {
  if (isNeverOpenedCloseReason(reason)) return CLOSED_TRADE_ICON_FLAT;

  const displayed = Number(formatClosedPnlPct(pnlPct));
  if (displayed > 0) return CLOSED_TRADE_ICON_WIN;
  if (displayed < 0) return CLOSED_TRADE_ICON_LOSS;

  const dollars = Number(realizedPnl);
  if (dollars > 0) return CLOSED_TRADE_ICON_WIN;
  if (dollars < 0) return CLOSED_TRADE_ICON_LOSS;

  return CLOSED_TRADE_ICON_FLAT;
}

/** Full close-alert text used by ORB / Premarket / EMA / Swing. */
export function formatClosedTradeTelegramText({ label, ticker, reason, pnlPct, realizedPnl } = {}) {
  const icon = closedTradeTelegramIcon({ reason, pnlPct, realizedPnl });
  const pct = formatClosedPnlPct(pnlPct);
  return `${icon} ${label} CLOSED ${ticker} — ${reason} | P&L: ${pct}%`;
}
