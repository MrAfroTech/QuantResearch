import { getSql } from '../sqlClient.js';
import { getBotState } from '../db.js';
import { setEmaVwapMode } from '../emaVwapCross/emaVwapDb.js';

export const SCHEDULED_TRADING_HALT_REASON = 'scheduled_trading_halt';

export function parseHaltUntil(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/** Active while now is strictly before the resume instant (inclusive resume). */
export function isScheduledTradingHaltActive(now, untilMs) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  return Number.isFinite(untilMs) && Number.isFinite(t) && t < untilMs;
}

export function formatHaltUntilEt(untilMs) {
  if (!Number.isFinite(untilMs)) return null;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(new Date(untilMs));
}

export async function getScheduledTradingHalt(now = new Date()) {
  const state = await getBotState();
  const untilMs = parseHaltUntil(state?.entries_halted_until);
  const active = isScheduledTradingHaltActive(now, untilMs);
  return {
    active,
    untilMs,
    resumeAt: untilMs ? new Date(untilMs).toISOString() : null,
    resumeAtEt: untilMs ? formatHaltUntilEt(untilMs) : null,
  };
}

export async function maybeResumeScheduledHalt(now = new Date()) {
  const halt = await getScheduledTradingHalt(now);
  if (!halt.untilMs) {
    return { resumed: false, reason: 'no_halt_scheduled' };
  }
  if (halt.active) {
    return { resumed: false, reason: 'halt_still_active', untilMs: halt.untilMs };
  }

  await setEmaVwapMode('AUTO');

  const sql = getSql();
  const rows = await sql`
    UPDATE bot_state
    SET
      execution_mode = 'AUTO',
      swing_mode = 'AUTO',
      orb_mode = 'AUTO',
      premarket_mode = 'AUTO',
      entries_halted_until = NULL,
      updated_at = NOW()::text
    WHERE id = 1
      AND entries_halted_until IS NOT NULL
      AND entries_halted_until <= ${now}
    RETURNING id
  `;

  if (!rows.length) {
    return { resumed: false, reason: 'already_cleared' };
  }

  try {
    const { sendScheduledHaltResumeTelegram } = await import('../telegramHandler.js');
    await sendScheduledHaltResumeTelegram(halt);
  } catch (err) {
    console.error('[TradingHalt] resume Telegram failed:', err.message);
  }

  console.log(`[TradingHalt] resumed AUTO — halt until ${halt.resumeAtEt} expired`);
  return { resumed: true, resumeAtEt: halt.resumeAtEt };
}
