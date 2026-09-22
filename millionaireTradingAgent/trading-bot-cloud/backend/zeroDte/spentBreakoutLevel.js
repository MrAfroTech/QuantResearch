/**
 * Breakout-level suppression for ORB / Premarket.
 *
 * Three rules:
 *  1. Repeat block — after an emitted entry, stay quiet on later bars that are
 *     still beyond the same level with no retreat (the original phantom loop).
 *  2. Retest clearance — a completed close back through the level clears both
 *     the repeat block and a hard spend so a later break is a new setup.
 *  3. Flash pardon — a close held under FLASH_STOP_MAX_HOLD_MS does not count
 *     as "tested and failed." Only a meaningful-duration *loss* hard-spends.
 *     Each close outcome is applied once (applied_close_ids). Incremental
 *     polls must not re-pardon the same flash for the rest of the day.
 */

export const FLASH_STOP_MAX_HOLD_MS = 60 * 1000;

export function spentLevelKey(direction, level) {
  return `${String(direction)}:${Number(level)}`;
}

export function listSpentLevels(fsmOrLevels) {
  if (Array.isArray(fsmOrLevels)) return fsmOrLevels;
  return Array.isArray(fsmOrLevels?.spent_levels) ? fsmOrLevels.spent_levels : [];
}

export function listRepeatBlocks(fsmOrLevels) {
  if (Array.isArray(fsmOrLevels)) return fsmOrLevels;
  return Array.isArray(fsmOrLevels?.repeat_blocks) ? fsmOrLevels.repeat_blocks : [];
}

export function listAppliedCloseIds(fsm) {
  return Array.isArray(fsm?.applied_close_ids) ? fsm.applied_close_ids : [];
}

/** Stable id for one trade-log close so a poll cannot re-apply it. */
export function closeOutcomeId(close) {
  if (!close) return null;
  const openedAt = close.openedAt ?? close.opened_at;
  const openedMs = Number.isFinite(close.openedAtMs)
    ? close.openedAtMs
    : parseStampMs(openedAt);
  const closedMs = Number.isFinite(close.closedAtMs)
    ? close.closedAtMs
    : parseStampMs(close.closedAt ?? close.closed_at);
  const level = close.level ?? close.breakoutLevel ?? close.breakout_level;
  if (close.direction == null || level == null || !Number.isFinite(closedMs)) return null;
  const openedPart = Number.isFinite(openedMs) ? String(openedMs) : '';
  return `${close.direction}:${Number(level)}:${openedPart}:${closedMs}`;
}

export function isBreakoutLevelSpent(fsmOrLevels, direction, level) {
  return listSpentLevels(fsmOrLevels).includes(spentLevelKey(direction, level));
}

export function isRepeatBlocked(fsmOrLevels, direction, level) {
  return listRepeatBlocks(fsmOrLevels).includes(spentLevelKey(direction, level));
}

export function shouldSuppressBreakout(fsmOrLevels, direction, level) {
  return (
    isBreakoutLevelSpent(fsmOrLevels, direction, level) ||
    isRepeatBlocked(fsmOrLevels, direction, level)
  );
}

export function withSpentBreakoutLevel(fsmOrLevels, direction, level) {
  const current = listSpentLevels(fsmOrLevels);
  const key = spentLevelKey(direction, level);
  return current.includes(key) ? current : [...current, key];
}

export function withRepeatBlock(fsmOrLevels, direction, level) {
  const current = listRepeatBlocks(fsmOrLevels);
  const key = spentLevelKey(direction, level);
  return current.includes(key) ? current : [...current, key];
}

function withoutKey(list, key) {
  return list.filter((item) => item !== key);
}

export function clearLevelSuppression(fsmOrLevels, direction, level) {
  const key = spentLevelKey(direction, level);
  return {
    ...(fsmOrLevels && !Array.isArray(fsmOrLevels) ? fsmOrLevels : {}),
    spent_levels: withoutKey(listSpentLevels(fsmOrLevels), key),
    repeat_blocks: withoutKey(listRepeatBlocks(fsmOrLevels), key),
  };
}

export function isRetestClearanceBar(direction, level, bar) {
  const px = Number(bar?.close);
  const lv = Number(level);
  if (!Number.isFinite(px) || !Number.isFinite(lv)) return false;
  return direction === 'CALL' ? px <= lv : px >= lv;
}

export function applyRetestClearance(fsm, high, low, bar) {
  let next = {
    ...fsm,
    spent_levels: listSpentLevels(fsm),
    repeat_blocks: listRepeatBlocks(fsm),
  };
  if (isRetestClearanceBar('CALL', high, bar)) {
    next = clearLevelSuppression(next, 'CALL', high);
  }
  if (isRetestClearanceBar('PUT', low, bar)) {
    next = clearLevelSuppression(next, 'PUT', low);
  }
  return next;
}

function parseStampMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value == null) return NaN;
  const raw = String(value).trim();
  let normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  normalized = normalized.replace(/([+-]\d{2})$/, '$1:00');
  return Date.parse(normalized);
}

export function holdMsFromTimestamps(openedAt, closedAt) {
  const opened = parseStampMs(openedAt);
  const closed = parseStampMs(closedAt);
  if (!Number.isFinite(opened) || !Number.isFinite(closed)) return null;
  return Math.max(0, closed - opened);
}

export function isFlashStopHold(holdMs) {
  return Number.isFinite(holdMs) && holdMs < FLASH_STOP_MAX_HOLD_MS;
}

export function normalizeCloseOutcome(raw) {
  if (!raw) return null;
  const openedAt = raw.openedAt ?? raw.opened_at;
  const closedAt = raw.closedAt ?? raw.closed_at;
  const holdMs =
    raw.holdMs ??
    raw.hold_ms ??
    holdMsFromTimestamps(openedAt, closedAt);
  const closedAtMs =
    Number.isFinite(raw.closedAtMs) ? raw.closedAtMs : parseStampMs(closedAt);
  const level = raw.level ?? raw.breakoutLevel ?? raw.breakout_level;
  if (raw.direction == null || level == null) return null;
  const openedAtMs = parseStampMs(openedAt);
  return {
    direction: raw.direction,
    level,
    holdMs,
    realizedPnl: Number(raw.realizedPnl ?? raw.realized_pnl),
    openedAt,
    openedAtMs: Number.isFinite(openedAtMs) ? openedAtMs : null,
    closedAt: closedAt,
    closedAtMs: Number.isFinite(closedAtMs) ? closedAtMs : Number.POSITIVE_INFINITY,
  };
}

export function sortCloseOutcomes(closes) {
  return (closes || [])
    .map(normalizeCloseOutcome)
    .filter(Boolean)
    .sort((a, b) => a.closedAtMs - b.closedAtMs);
}

/**
 * Apply fills that have already closed. Last close for a key wins.
 * Flash → clear spend + repeat. Meaningful loss → hard spend.
 * Meaningful non-loss → drop hard spend, keep/add repeat block until a retest.
 */
export function applyCloseOutcomesToSuppression(fsm, closes = []) {
  let spent = listSpentLevels(fsm);
  let repeat = listRepeatBlocks(fsm);
  let applied = listAppliedCloseIds(fsm);

  for (const raw of closes) {
    const close = normalizeCloseOutcome(raw);
    if (!close) continue;
    const id = closeOutcomeId(close);
    if (id && applied.includes(id)) continue;
    const key = spentLevelKey(close.direction, close.level);

    if (isFlashStopHold(close.holdMs)) {
      spent = withoutKey(spent, key);
      repeat = withoutKey(repeat, key);
      if (id) applied = applied.includes(id) ? applied : [...applied, id];
      continue;
    }

    if (!Number.isFinite(close.holdMs)) continue;

    if (Number.isFinite(close.realizedPnl) && close.realizedPnl < 0) {
      if (!spent.includes(key)) spent = [...spent, key];
      repeat = withoutKey(repeat, key);
      if (id) applied = applied.includes(id) ? applied : [...applied, id];
      continue;
    }

    spent = withoutKey(spent, key);
    if (!repeat.includes(key)) repeat = [...repeat, key];
    if (id) applied = applied.includes(id) ? applied : [...applied, id];
  }

  return {
    ...fsm,
    spent_levels: spent,
    repeat_blocks: repeat,
    applied_close_ids: applied,
  };
}

export function takeClosesUpTo(closes, asOfMs, startIdx = 0) {
  const batch = [];
  let i = startIdx;
  if (!Number.isFinite(asOfMs)) return { batch, nextIdx: i };
  while (i < closes.length && closes[i].closedAtMs <= asOfMs) {
    batch.push(closes[i]);
    i += 1;
  }
  return { batch, nextIdx: i };
}

function etIsoOffset(dateStr) {
  const utc = new Date(`${dateStr}T17:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'longOffset',
  }).formatToParts(utc);
  const name = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT-4';
  const match = name.match(/GMT([+-])(\d+)/);
  if (!match) return '-04:00';
  return `${match[1]}${String(match[2]).padStart(2, '0')}:00`;
}

/** UTC ms of the bar's close. Tradier 5-min `time` is ET wall; `timestamp` is epoch seconds. */
export function barClosedAtMs(bar, intervalMinutes = 5) {
  const ts = Number(bar?.timestamp);
  if (Number.isFinite(ts) && ts > 0) {
    const ms = ts > 1e12 ? ts : ts * 1000;
    return ms + intervalMinutes * 60 * 1000;
  }
  const wall = String(bar?.time || '');
  if (!wall) return NaN;
  const zoned =
    /[zZ]|[+-]\d{2}:\d{2}$/.test(wall) ? wall : `${wall}${etIsoOffset(wall.slice(0, 10))}`;
  const openMs = Date.parse(zoned);
  if (!Number.isFinite(openMs)) return NaN;
  return openMs + intervalMinutes * 60 * 1000;
}

export function applyDueCloses(fsm, sortedCloses, bar, startIdx = 0) {
  const { batch, nextIdx } = takeClosesUpTo(sortedCloses, barClosedAtMs(bar), startIdx);
  if (batch.length === 0) return { fsm, nextIdx };
  return { fsm: applyCloseOutcomesToSuppression(fsm, batch), nextIdx };
}
