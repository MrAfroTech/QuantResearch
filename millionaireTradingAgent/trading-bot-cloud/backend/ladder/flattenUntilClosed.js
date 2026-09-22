/**
 * Risk/time-stop flatten retry until the position is actually closed.
 *
 * A single unfilled $0.01 STC must not restore the stop and wait for the next
 * 1-min poll — keep flattening (inline wave, then background) until the broker
 * fill prints, the broker is already flat, or the DB row is no longer OPEN.
 */

import { nextStopRetryBackoffMs } from './initialStopRetry.js';
import { isRiskExitReason, LADDER_CLOSE_REASON } from './ladderConfig.js';
import { closeFillIsConfirmed } from './orderFillStatus.js';

/** Awaited flatten attempts before returning control to the monitor loop. */
export const FLATTEN_INLINE_ATTEMPTS = 2;

const inFlight = new Map();

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flattenKey(positionId) {
  return `flatten:${positionId}`;
}

export function resetFlattenUntilClosedStateForTests() {
  inFlight.clear();
}

export function isFlattenRetryInFlight(positionId) {
  return inFlight.has(flattenKey(positionId));
}

/**
 * Do not re-arm a protective stop while a flatten is the live close path.
 * Time-stop / risk pending closes own the book until it is actually flat.
 */
export function shouldKickInitialStop({
  brokerStopOrderId,
  pendingCloseReason,
  isTimeStop = false,
  flattenInFlight = false,
} = {}) {
  if (brokerStopOrderId) return false;
  if (flattenInFlight) return false;
  if (isTimeStop) return false;
  if (isRiskExitReason(pendingCloseReason)) return false;
  if (String(pendingCloseReason || '') === LADDER_CLOSE_REASON.FORCED_CLOSE_EOD) {
    return false;
  }
  return true;
}

async function readOpenRow(getOpenPosition) {
  if (typeof getOpenPosition !== 'function') {
    return { open: true, row: null };
  }
  const row = await getOpenPosition();
  if (!row) return { open: false, row: null };
  return { open: true, row };
}

/**
 * Retry flattenBrokerOrder until filled, broker-flat, or the position is gone.
 * Dedupes in-flight loops per position. maxAttempts=null means no ceiling.
 */
export function ensureFlattenUntilClosed(
  position,
  {
    flattenBrokerOrder,
    flattenPrice,
    closeQty,
    getOpenPosition = null,
    settleFilled = null,
    sleep = defaultSleep,
    now = Date.now,
    maxAttempts = null,
    logLabel = 'LadderExit',
  } = {}
) {
  const positionId = position?.id;
  const key = flattenKey(positionId);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const startedAt = now();

  const run = (async () => {
    let attempt = 0;
    let lastReason = 'unknown';

    while (true) {
      const state = await readOpenRow(getOpenPosition);
      if (!state.open) {
        return { filled: false, reason: 'position_closed', attempt, lastReason };
      }

      attempt += 1;
      let result;
      try {
        result = await flattenBrokerOrder(position, flattenPrice, closeQty);
      } catch (err) {
        result = { filled: false, reason: err.message, error: err };
      }

      if (result?.noBrokerPosition || closeFillIsConfirmed(result)) {
        if (typeof settleFilled === 'function') {
          await settleFilled(result);
        }
        return { ...result, attempt, elapsedMs: now() - startedAt };
      }

      lastReason =
        result?.filled && !closeFillIsConfirmed(result)
          ? 'fill_price_unconfirmed'
          : (result?.reason || result?.status || 'unfilled');
      console.error(
        `[${logLabel}] Flatten did not fill #${positionId} attempt=${attempt} ` +
          `reason=${lastReason} — retrying until closed`
      );

      if (maxAttempts != null && attempt >= maxAttempts) {
        return {
          filled: false,
          reason: lastReason,
          attempt,
          exhausted: true,
          elapsedMs: now() - startedAt,
        };
      }

      const waitMs = nextStopRetryBackoffMs(attempt);
      console.log(
        `[${logLabel}] flatten retry backoff ${waitMs}ms ` +
          `#${positionId} attempt=${attempt} reason=${lastReason}`
      );
      await sleep(waitMs);
    }
  })()
    .catch((err) => {
      console.error(`[${logLabel}] flatten retry crashed #${positionId}:`, err.message);
      return { filled: false, reason: err.message, error: err };
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, run);
  return run;
}

/**
 * Await a short inline flatten wave, then keep flattening in the background
 * so the monitor can move on to other positions. Background success settles
 * via settleFilled. Stop condition is "position closed", never a timeout.
 */
export async function syncFlattenUntilClosed(position, {
  flattenBrokerOrder,
  flattenPrice,
  closeQty,
  getOpenPosition = null,
  settleFilled = null,
  sleep = defaultSleep,
  now = Date.now,
  logLabel = 'LadderExit',
  inlineAttempts = FLATTEN_INLINE_ATTEMPTS,
} = {}) {
  const inline = await ensureFlattenUntilClosed(position, {
    flattenBrokerOrder,
    flattenPrice,
    closeQty,
    getOpenPosition,
    settleFilled: null,
    sleep,
    now,
    logLabel,
    maxAttempts: inlineAttempts,
  });

  if (inline?.noBrokerPosition || closeFillIsConfirmed(inline)) return inline;
  if (inline?.reason === 'position_closed') return inline;

  const background = ensureFlattenUntilClosed(position, {
    flattenBrokerOrder,
    flattenPrice,
    closeQty,
    getOpenPosition,
    settleFilled,
    sleep,
    now,
    logLabel,
    maxAttempts: null,
  });
  if (background && typeof background.catch === 'function') {
    background.catch((err) => {
      console.error(
        `[${logLabel}] flatten background rejected #${position?.id}:`,
        err.message
      );
    });
  }

  return { ...inline, backgroundRetry: true };
}
