/**
 * Shared Premarket/ORB partial-lock resting-stop raise with loud failure events
 * and the same backoff retry cadence as initial-stop protection (e1311e9).
 *
 * One failed replaceStop must not leave the position on the soft loss stop until
 * the next 1-min poll — retry in-process (await first wave) and keep a background
 * loop alive until the floor rests or the position closes.
 */

import { nextStopRetryBackoffMs } from './initialStopRetry.js';
import { POSITION_UNPROTECTED_NO_RESTING_STOP } from './ladderStopOrders.js';

/** Event type written on every unsuccessful replace attempt. */
export const PARTIAL_LOCK_STOP_REPLACE_FAILED = 'partial_lock_stop_replace_failed';

export { POSITION_UNPROTECTED_NO_RESTING_STOP };

/** Awaited attempts before returning control to the monitor loop (2s+4s+8s). */
export const PARTIAL_LOCK_REPLACE_INLINE_ATTEMPTS = 3;

const inFlight = new Map();

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function replaceRetryKey(strategy, positionId, trailFloor) {
  const floorKey = Number.isFinite(Number(trailFloor))
    ? Number(trailFloor).toFixed(4)
    : 'na';
  return `${String(strategy || 'unknown')}:${positionId}:pl:${floorKey}`;
}

export function resetPartialLockStopReplaceStateForTests() {
  inFlight.clear();
}

/**
 * True when the resting broker stop already protects at/above the trail floor.
 */
export function isPartialLockFloorResting(position, trailFloor, epsilon = 0.001) {
  const current = Number(position?.broker_stop_pnl_frac);
  const floor = Number(trailFloor);
  if (!Number.isFinite(current) || !Number.isFinite(floor)) return false;
  return current + epsilon >= floor;
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
 * Live Tastytrade qty + existing broker_already_flat settlement.
 * Lookup null (API failure) is fail-open so a still-long position still gets the raise.
 */
export function buildPartialLockBrokerLiveChecks(position, {
  environment,
  strategy,
  fullClosePosition = null,
  onNotify = null,
} = {}) {
  return {
    isBrokerStillLong: async (row) => {
      const { getLiveOptionPositionQuantity } = await import('../brokerageConnector.js');
      const qty = await getLiveOptionPositionQuantity(row || position, {
        environment,
        strategy,
      });
      if (qty == null) return null;
      return qty >= 1;
    },
    onBrokerAlreadyFlat: fullClosePosition
      ? async ({ position: row }) => {
          const { settleDbOpenIfBrokerFlat } = await import('./brokerFlatSync.js');
          return settleDbOpenIfBrokerFlat(row || position, {
            environment,
            strategy,
            fullClosePosition,
            onNotify,
          });
        }
      : null,
  };
}

/**
 * Single replaceStop attempt. Updates in-memory broker_stop_* on success.
 * Always reports via onFailure/onSuccess — callers must not rely on console only.
 */
export async function attemptPartialLockStopReplace(position, {
  strategy,
  trailFloor,
  peakMfe,
  replaceStop,
  shouldRaise,
  attempt = 1,
  onSuccess = null,
  onFailure = null,
  logLabel = 'PartialLock',
} = {}) {
  if (typeof replaceStop !== 'function') {
    const result = { placed: false, reason: 'replace_stop_unavailable' };
    if (onFailure) {
      await onFailure({
        position,
        trailFloor,
        peakMfe,
        attempt,
        reason: result.reason,
        oldTrigger: position?.broker_stop_trigger_price ?? null,
        oldOrderId: position?.broker_stop_order_id ?? null,
        desiredTrigger: null,
      });
    }
    return result;
  }

  const check =
    typeof shouldRaise === 'function'
      ? shouldRaise(position, trailFloor)
      : { raise: true, desiredTrigger: null, currentTrigger: position?.broker_stop_trigger_price };

  if (!check?.raise) {
    if (isPartialLockFloorResting(position, trailFloor)) {
      return {
        placed: true,
        alreadyRaised: true,
        orderId: position.broker_stop_order_id,
        stopTrigger: position.broker_stop_trigger_price,
        stopPnlFrac: position.broker_stop_pnl_frac,
        attempt,
      };
    }
    return { placed: false, reason: 'raise_not_needed', check, attempt };
  }

  const oldTrigger = check.currentTrigger ?? position.broker_stop_trigger_price ?? null;
  const oldOrderId = position.broker_stop_order_id ?? null;

  let result;
  try {
    result = await replaceStop(position, trailFloor);
  } catch (err) {
    result = { placed: false, reason: err.message, error: err };
  }

  if (result?.placed) {
    position.broker_stop_order_id = result.orderId;
    position.broker_stop_trigger_price = result.stopTrigger;
    position.broker_stop_pnl_frac = result.stopPnlFrac;

    console.log(
      `[${logLabel}] partial_lock_stop_replace ${position.ticker} #${position.id}` +
        ` old_trigger=$${oldTrigger ?? 'n/a'} new_trigger=$${result.stopTrigger}` +
        ` mfe=${(Number(peakMfe) * 100).toFixed(1)}%` +
        ` floor=${(Number(trailFloor) * 100).toFixed(1)}%` +
        ` attempt=${attempt}` +
        ` old_order=${oldOrderId ?? 'none'} new_order=${result.orderId}`
    );

    if (onSuccess) {
      await onSuccess({
        position,
        peakMfe,
        trailFloor,
        oldTrigger,
        newTrigger: result.stopTrigger,
        oldOrderId,
        newOrderId: result.orderId,
        attempt,
      });
    }
    return { ...result, attempt };
  }

  const reason = result?.reason || 'unknown';
  console.error(
    `[${logLabel}] partial_lock_stop_replace FAILED ${position.ticker} #${position.id}` +
      ` old=$${oldTrigger ?? 'n/a'} new=$${check.desiredTrigger ?? 'n/a'}` +
      ` mfe=${(Number(peakMfe) * 100).toFixed(1)}% attempt=${attempt} reason=${reason}`
  );

  if (onFailure) {
    await onFailure({
      position,
      trailFloor,
      peakMfe,
      attempt,
      reason,
      oldTrigger,
      oldOrderId,
      desiredTrigger: check.desiredTrigger ?? null,
      eventType: result?.unprotected
        ? POSITION_UNPROTECTED_NO_RESTING_STOP
        : PARTIAL_LOCK_STOP_REPLACE_FAILED,
      unprotected: Boolean(result?.unprotected),
    });
  }

  return { placed: false, reason, attempt, error: result?.error, unprotected: Boolean(result?.unprotected) };
}

/**
 * Retry replaceStop with e1311e9 backoff until the floor rests or the position closes.
 * Dedupes in-flight loops per strategy/position/floor.
 */
export function ensurePartialLockBrokerStopRaised(
  position,
  {
    strategy,
    trailFloor,
    peakMfe,
    replaceStop,
    shouldRaise,
    getOpenPosition,
    isBrokerStillLong = null,
    onBrokerAlreadyFlat = null,
    onSuccess = null,
    onFailure = null,
    sleep = defaultSleep,
    now = Date.now,
    logLabel = 'PartialLock',
    maxAttempts = null,
  } = {}
) {
  const positionId = position?.id;
  const key = replaceRetryKey(strategy, positionId, trailFloor);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const startedAt = now();

  const abortIfBrokerFlat = async (row, attempt) => {
    if (typeof isBrokerStillLong !== 'function') return null;
    let stillLong;
    try {
      stillLong = await isBrokerStillLong(row || position);
    } catch (err) {
      console.warn(
        `[${logLabel}] broker long lookup failed #${positionId}:`,
        err.message
      );
      return null;
    }
    if (stillLong !== false) return null;
    console.log(
      `[${logLabel}] partial_lock_stop_replace skipped #${positionId} — broker already flat`
    );
    if (typeof onBrokerAlreadyFlat === 'function') {
      try {
        await onBrokerAlreadyFlat({ position: row || position, attempt });
      } catch (err) {
        console.error(
          `[${logLabel}] broker-flat settle failed #${positionId}:`,
          err.message
        );
      }
    }
    return { placed: false, reason: 'broker_already_flat', brokerFlat: true, attempt };
  };

  const run = (async () => {
    let attempt = 0;
    let lastReason = 'unknown';

    while (true) {
      const state = await readOpenRow(getOpenPosition);
      if (!state.open) {
        return { placed: false, reason: 'position_closed', attempt, lastReason };
      }

      const row = state.row || position;
      const flat = await abortIfBrokerFlat(row, attempt);
      if (flat) return flat;

      if (isPartialLockFloorResting(row, trailFloor)) {
        position.broker_stop_order_id = row.broker_stop_order_id;
        position.broker_stop_trigger_price = row.broker_stop_trigger_price;
        position.broker_stop_pnl_frac = row.broker_stop_pnl_frac;
        return {
          placed: true,
          alreadyRaised: true,
          orderId: row.broker_stop_order_id,
          attempt,
          elapsedMs: now() - startedAt,
        };
      }

      // Refresh broker-stop fields from DB so cancel/place sees current order id.
      if (state.row) {
        position.broker_stop_order_id = state.row.broker_stop_order_id;
        position.broker_stop_trigger_price = state.row.broker_stop_trigger_price;
        position.broker_stop_pnl_frac = state.row.broker_stop_pnl_frac;
      }

      attempt += 1;
      const result = await attemptPartialLockStopReplace(position, {
        strategy,
        trailFloor,
        peakMfe,
        replaceStop,
        shouldRaise,
        attempt,
        onSuccess,
        onFailure,
        logLabel,
      });

      if (result?.placed) {
        return { ...result, elapsedMs: now() - startedAt };
      }

      lastReason = result?.reason || 'unknown';
      if (lastReason === 'raise_not_needed') {
        return { placed: false, reason: lastReason, attempt };
      }

      if (maxAttempts != null && attempt >= maxAttempts) {
        return { placed: false, reason: lastReason, attempt, exhausted: true };
      }

      const waitMs = nextStopRetryBackoffMs(attempt);
      console.log(
        `[${logLabel}] partial_lock_stop_replace retry backoff ${waitMs}ms ` +
          `#${positionId} attempt=${attempt} reason=${lastReason}`
      );
      await sleep(waitMs);
    }
  })()
    .catch((err) => {
      console.error(
        `[${logLabel}] partial_lock_stop_replace retry crashed #${positionId}:`,
        err.message
      );
      return { placed: false, reason: err.message, error: err };
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, run);
  return run;
}

/**
 * Await a short inline retry wave, then keep retrying in the background so the
 * monitor can move on without waiting until the next 1-min poll.
 */
export async function syncPartialLockBrokerStopWithRetry(position, {
  strategy,
  trailFloor,
  peakMfe,
  replaceStop,
  shouldRaise,
  getOpenPosition,
  isBrokerStillLong = null,
  onBrokerAlreadyFlat = null,
  onSuccess = null,
  onFailure = null,
  sleep = defaultSleep,
  now = Date.now,
  logLabel = 'PartialLock',
  inlineAttempts = PARTIAL_LOCK_REPLACE_INLINE_ATTEMPTS,
} = {}) {
  const shared = {
    strategy,
    trailFloor,
    peakMfe,
    replaceStop,
    shouldRaise,
    getOpenPosition,
    isBrokerStillLong,
    onBrokerAlreadyFlat,
    onSuccess,
    onFailure,
    sleep,
    now,
    logLabel,
  };

  const inline = await ensurePartialLockBrokerStopRaised(position, {
    ...shared,
    maxAttempts: inlineAttempts,
  });

  if (inline?.placed) return inline;
  if (
    inline?.reason === 'broker_already_flat' ||
    inline?.reason === 'position_closed' ||
    inline?.brokerFlat
  ) {
    return inline;
  }

  // Continue beyond the inline budget without blocking the monitor cycle.
  const background = ensurePartialLockBrokerStopRaised(position, {
    ...shared,
    maxAttempts: null,
  });
  if (background && typeof background.catch === 'function') {
    background.catch((err) => {
      console.error(
        `[${logLabel}] partial_lock_stop_replace background rejected #${position?.id}:`,
        err.message
      );
    });
  }

  return { ...inline, backgroundRetry: true };
}

/**
 * Whether trail arming (raise only) should run for this decision.
 * close_all is handled by the software trail path; hard_stop / below activation skip.
 */
export function shouldArmPartialLockBrokerStop(decision) {
  if (!decision || decision.action === 'close_all') return false;
  if (decision.trailFloor == null) return false;
  if (decision.inactiveReason === 'post_milestone_ladder_owns_trail') return false;
  if (decision.inactiveReason === 'below_activation') return false;
  if (decision.inactiveReason === 'hard_stop_owns_exit') return false;
  return true;
}
