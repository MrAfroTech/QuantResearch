import { barEtMinutes } from '../orb/tradierTimesales.js';
import { computeSessionIndicators } from './emaVwapIndicators.js';

/** Tradier 5-min bars are timestamped at the open. Close = start + 5 minutes. */
export const FIVE_MIN_BAR_MS = 5 * 60 * 1000;
/** Wait after close so Tradier can finalize the last print before we treat the bar as final. */
export const EMA_VWAP_BAR_SETTLE_MS = 15 * 1000;

export function isEmaVwapSessionBar(bar) {
  const mins = barEtMinutes(bar);
  if (mins == null) return false;
  return mins >= 9 * 60 + 30 && mins < 15 * 60 + 5;
}

export function filterNewEmaVwapBars(bars, lastProcessedTime) {
  if (!lastProcessedTime) return bars;
  return bars.filter((b) => b.time > lastProcessedTime);
}

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

/**
 * True once the 5-min bar's close has passed and Tradier settle has elapsed.
 * Bar `time`/`timestamp` is the period open (11:25 bar covers 11:25–11:30 ET).
 */
export function isCompletedFiveMinuteBar(
  bar,
  now = new Date(),
  settleMs = EMA_VWAP_BAR_SETTLE_MS
) {
  const startMins = barEtMinutes(bar);
  if (startMins == null) return false;
  const closeMsOfDay = (startMins + 5) * 60 * 1000;
  return etMsOfDay(now) >= closeMsOfDay + settleMs;
}

export function filterCompletedFiveMinuteBars(
  bars,
  now = new Date(),
  settleMs = EMA_VWAP_BAR_SETTLE_MS
) {
  return (bars || []).filter((bar) => isCompletedFiveMinuteBar(bar, now, settleMs));
}

/** Milliseconds to wait so the bar that just closed is past Tradier settle. */
export function msUntilFiveMinuteBarSettle(now = new Date(), settleMs = EMA_VWAP_BAR_SETTLE_MS) {
  const { hours, minutes, seconds } = etClockParts(now);
  const mins = hours * 60 + minutes;
  const slotStartMins = Math.floor(mins / 5) * 5;
  const elapsed = (mins - slotStartMins) * 60 * 1000 + seconds * 1000;
  return Math.max(0, settleMs - elapsed);
}

export async function waitForCompletedFiveMinuteBarSettle({
  now = new Date(),
  settleMs = EMA_VWAP_BAR_SETTLE_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const waitMs = msUntilFiveMinuteBarSettle(now, settleMs);
  if (waitMs > 0) {
    console.log(`[EMA/VWAP] Waiting ${waitMs}ms for Tradier 5-min bar settle`);
    await sleep(waitMs);
  }
  return waitMs;
}

/**
 * Session bars that have fully closed, with indicators computed, not yet processed.
 * Forming (in-progress) bars are excluded so EMA/VWAP/ADX never see incomplete OHLC.
 */
export function selectEmaVwapEvaluationBars(
  bars,
  { lastProcessedTime = null, now = new Date(), settleMs = EMA_VWAP_BAR_SETTLE_MS } = {}
) {
  const sessionBars = (bars || []).filter(isEmaVwapSessionBar);
  const completed = filterCompletedFiveMinuteBars(sessionBars, now, settleMs);
  const enriched = computeSessionIndicators(completed);
  return filterNewEmaVwapBars(enriched, lastProcessedTime);
}
