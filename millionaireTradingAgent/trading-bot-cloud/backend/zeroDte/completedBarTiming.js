import { barEtMinutes } from '../orb/tradierTimesales.js';

/**
 * Tradier timesales bars are timestamped at the period open.
 * Same 15s settle as EMA/VWAP (`EMA_VWAP_BAR_SETTLE_MS`): provider finalization
 * lag does not shrink with bar size. 1-min THE3-4 still evaluates the closed
 * bar 15s after its close — well before the next 1-min bar ends.
 */
export const COMPLETED_BAR_SETTLE_MS = 15 * 1000;

function etClockParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return {
    hours: get('hour'),
    minutes: get('minute'),
    seconds: get('second'),
  };
}

function etMsOfDay(date = new Date()) {
  const { hours, minutes, seconds } = etClockParts(date);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

export function normalizeIntervalMinutes(intervalMinutes) {
  const n = Number(intervalMinutes);
  return n === 1 ? 1 : 5;
}

/**
 * True once the bar's close has passed and Tradier settle has elapsed.
 * A 11:25 5-min bar covers 11:25–11:30; a 11:25 1-min bar covers 11:25–11:26.
 */
export function isCompletedBar(
  bar,
  {
    now = new Date(),
    intervalMinutes = 5,
    settleMs = COMPLETED_BAR_SETTLE_MS,
  } = {}
) {
  const startMins = barEtMinutes(bar);
  if (startMins == null) return false;
  const interval = normalizeIntervalMinutes(intervalMinutes);
  const closeMsOfDay = (startMins + interval) * 60 * 1000;
  return etMsOfDay(now) >= closeMsOfDay + settleMs;
}

export function filterCompletedBars(
  bars,
  {
    now = new Date(),
    intervalMinutes = 5,
    settleMs = COMPLETED_BAR_SETTLE_MS,
  } = {}
) {
  return (bars || []).filter((bar) =>
    isCompletedBar(bar, { now, intervalMinutes, settleMs })
  );
}

export function filterNewBars(bars, lastProcessedTime) {
  if (!lastProcessedTime) return bars;
  return (bars || []).filter((b) => b.time > lastProcessedTime);
}

/**
 * Completed bars not yet processed. Forming bars are excluded so breakout,
 * hold/confirm, and the confirmation-bar quality gate never see incomplete OHLC.
 */
export function selectCompletedNewBars(
  bars,
  {
    lastProcessedTime = null,
    now = new Date(),
    intervalMinutes = 5,
    settleMs = COMPLETED_BAR_SETTLE_MS,
  } = {}
) {
  const completed = filterCompletedBars(bars, { now, intervalMinutes, settleMs });
  return filterNewBars(completed, lastProcessedTime);
}

/** Milliseconds to wait so the bar that just closed is past Tradier settle. */
export function msUntilBarSettle(
  now = new Date(),
  intervalMinutes = 5,
  settleMs = COMPLETED_BAR_SETTLE_MS
) {
  const interval = normalizeIntervalMinutes(intervalMinutes);
  const { hours, minutes, seconds } = etClockParts(now);
  const mins = hours * 60 + minutes;
  const slotStartMins = Math.floor(mins / interval) * interval;
  const elapsed = (mins - slotStartMins) * 60 * 1000 + seconds * 1000;
  return Math.max(0, settleMs - elapsed);
}

export async function waitForCompletedBarSettle({
  now = new Date(),
  intervalMinutes = 5,
  settleMs = COMPLETED_BAR_SETTLE_MS,
  label = 'Scan',
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const waitMs = msUntilBarSettle(now, intervalMinutes, settleMs);
  if (waitMs > 0) {
    console.log(`[${label}] Waiting ${waitMs}ms for Tradier ${normalizeIntervalMinutes(intervalMinutes)}-min bar settle`);
    await sleep(waitMs);
  }
  return waitMs;
}
