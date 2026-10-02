/**
 * Same-session ORB level lock, spent only after a losing close.
 *
 * Key: symbol (caller already scoped the rows) + direction + opening-range
 * breakout level. A filled loss (premium P&L < 0) spends that key for the
 * rest of the session. A win or a scratch does not. A later win does not
 * clear the spend. Flash losses spend the level too.
 */

export const ORB_LEVEL_SPENT_AFTER_LOSS_REASON = 'orb_level_spent_after_loss';

const NEVER_OPENED = new Set(['entry_unfilled_cancelled', 'entry_never_filled']);

function premiumPnl(row) {
  const stored = row?.realized_pnl ?? row?.realizedPnl;
  if (stored != null && Number.isFinite(Number(stored))) return Number(stored);
  const entry = Number(row?.entry_premium ?? row?.entryPremium);
  const exit = Number(row?.exit_premium ?? row?.exitPremium);
  const qty = Number(row?.quantity ?? 1);
  const contracts = Number.isFinite(qty) && qty > 0 ? qty : 1;
  if (!Number.isFinite(entry) || !Number.isFinite(exit)) return null;
  return (exit - entry) * 100 * contracts;
}

function rowLevel(row) {
  return Number(row?.breakout_level ?? row?.breakoutLevel ?? row?.level);
}

/**
 * @param {object[]} closes Closed ORB rows for one symbol and session.
 * @param {{ direction: string, breakoutLevel: number }} key
 */
export function evaluateOrbLevelSpentAfterLoss(closes, { direction, breakoutLevel }) {
  const level = Number(breakoutLevel);
  const dir = String(direction || '');
  const allow = {
    blocked: false,
    reason: null,
    realizedPnl: null,
    closedAt: null,
  };
  if (!dir || !Number.isFinite(level)) return allow;

  for (const row of closes || []) {
    if (String(row?.direction || '') !== dir) continue;
    if (rowLevel(row) !== level) continue;
    const reason = String(row?.close_reason ?? row?.closeReason ?? '').toLowerCase();
    if (NEVER_OPENED.has(reason)) continue;
    const pnl = premiumPnl(row);
    if (Number.isFinite(pnl) && pnl < 0) {
      return {
        blocked: true,
        reason: ORB_LEVEL_SPENT_AFTER_LOSS_REASON,
        realizedPnl: pnl,
        closedAt: row.closed_at ?? row.closedAt ?? null,
      };
    }
  }
  return allow;
}
