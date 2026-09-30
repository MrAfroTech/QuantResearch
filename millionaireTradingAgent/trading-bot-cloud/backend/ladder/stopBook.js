/**
 * In-process stop lifecycle for one strategy position.
 *
 * The stored broker order id is the durable identity. It is not proof that
 * the order is resting. Unknown confirmation is never treated as absence.
 *
 * replaceInFlight, initialStopInFlight, and cancelInFlight record a broker
 * stop mutation on the exact strategy:positionId key before the async call.
 * A loss exit that arrives during one of those operations sets exitRequested
 * and returns. It does not wait, and it does not submit a competing sell.
 * exitRequested stays set until the position is confirmed flat and idle, so
 * a later ratchet does not PUT or POST.
 */

export const STOP_STATE = {
  NONE: 'NONE',
  RESTING_CONFIRMED: 'RESTING_CONFIRMED',
  PLACED_UNCONFIRMED: 'PLACED_UNCONFIRMED',
  CANCEL_REQUESTED_UNCONFIRMED: 'CANCEL_REQUESTED_UNCONFIRMED',
  FILLED: 'FILLED',
  ABSENT: 'ABSENT',
  UNKNOWN: 'UNKNOWN',
};

const UNRESOLVED = new Set([
  STOP_STATE.PLACED_UNCONFIRMED,
  STOP_STATE.CANCEL_REQUESTED_UNCONFIRMED,
  STOP_STATE.UNKNOWN,
  STOP_STATE.FILLED,
]);

const books = new Map();
/** Authoritative owner is strategy:positionId. The order-id index is secondary. */
const unconfirmedByPosition = new Map();
const unconfirmedByOrderId = new Map();

export function stopBookKey(strategy, positionId) {
  return `${String(strategy || 'unknown')}:${positionId}`;
}

function ledgerKey(strategy, positionOrId) {
  const positionId =
    positionOrId != null && typeof positionOrId === 'object'
      ? positionOrId.id
      : positionOrId;
  return stopBookKey(strategy, positionId);
}

function emptyRecord() {
  return {
    replaceInFlight: false,
    initialStopInFlight: false,
    cancelInFlight: false,
    exitRequested: false,
  };
}

function recordFor(strategy, positionId) {
  const key = stopBookKey(strategy, positionId);
  let rec = books.get(key);
  if (!rec) {
    rec = emptyRecord();
    books.set(key, rec);
  }
  return rec;
}

function recordId(key) {
  const idx = key.lastIndexOf(':');
  return idx >= 0 ? key.slice(idx + 1) : key;
}

/**
 * Callers that know the strategy always use that exact key.
 * A caller with no strategy may use a record only when this process has
 * exactly one book for that whole position id. Two strategies never match.
 */
function existingKeyFor(strategy, positionId) {
  if (strategy) {
    const key = stopBookKey(strategy, positionId);
    return books.has(key) ? key : null;
  }
  const token = String(positionId);
  const keys = [];
  for (const key of books.keys()) {
    if (recordId(key) === token) keys.push(key);
  }
  return keys.length === 1 ? keys[0] : null;
}

function recordForRead(strategy, positionId) {
  const key = existingKeyFor(strategy, positionId);
  return key ? books.get(key) : null;
}

export function isExitRequested(strategy, positionId) {
  return Boolean(recordForRead(strategy, positionId)?.exitRequested);
}

export function isReplaceInFlight(strategy, positionId) {
  return Boolean(recordForRead(strategy, positionId)?.replaceInFlight);
}

export function isInitialStopInFlight(strategy, positionId) {
  return Boolean(recordForRead(strategy, positionId)?.initialStopInFlight);
}

export function isCancelInFlight(strategy, positionId) {
  return Boolean(recordForRead(strategy, positionId)?.cancelInFlight);
}

export function isBrokerStopMutationInFlight(strategy, positionId) {
  const rec = recordForRead(strategy, positionId);
  if (!rec) return false;
  return Boolean(rec.replaceInFlight || rec.initialStopInFlight || rec.cancelInFlight);
}

/** @returns {boolean} false when a PUT or no-prior POST must not start */
export function beginStopReplace(strategy, positionId) {
  if (isExitRequested(strategy, positionId)) return false;
  const rec = recordFor(strategy, positionId);
  if (rec.exitRequested || rec.replaceInFlight || rec.initialStopInFlight || rec.cancelInFlight) {
    return false;
  }
  rec.replaceInFlight = true;
  return true;
}

/**
 * Clear replaceInFlight. Leave exitRequested set so a later ratchet still
 * refuses to start. The record is removed only after the position is flat.
 */
export function finishStopReplace(strategy, positionId) {
  const rec = books.get(stopBookKey(strategy, positionId));
  if (!rec) return { exitRequested: false };
  const exitRequested = Boolean(rec.exitRequested);
  rec.replaceInFlight = false;
  return { exitRequested };
}

/** @returns {boolean} false when this POST must not start */
export function beginInitialStop(strategy, positionId) {
  if (isExitRequested(strategy, positionId)) return false;
  const rec = recordFor(strategy, positionId);
  if (rec.exitRequested || rec.replaceInFlight || rec.cancelInFlight || rec.initialStopInFlight) {
    return false;
  }
  rec.initialStopInFlight = true;
  return true;
}

export function endInitialStop(strategy, positionId) {
  const rec = books.get(stopBookKey(strategy, positionId));
  if (rec) rec.initialStopInFlight = false;
}

/** @returns {boolean} false when a cancel must not start */
export function beginStopCancel(strategy, positionId) {
  const rec = recordFor(strategy, positionId);
  if (rec.replaceInFlight || rec.initialStopInFlight || rec.cancelInFlight) return false;
  rec.cancelInFlight = true;
  return true;
}

export function endStopCancel(strategy, positionId) {
  const rec = books.get(stopBookKey(strategy, positionId));
  if (rec) rec.cancelInFlight = false;
}

export function requestStopExit(strategy, positionId) {
  const existing = existingKeyFor(strategy, positionId);
  if (existing) {
    books.get(existing).exitRequested = true;
    return;
  }
  if (!strategy) return;
  recordFor(strategy, positionId).exitRequested = true;
}

/**
 * Drop the record after the position is confirmed flat and no broker
 * stop mutation is still resolving. A close request alone does not delete it.
 */
export function releaseStopBookIfIdle(strategy, positionId) {
  const key = existingKeyFor(strategy, positionId);
  if (!key) return false;
  const rec = books.get(key);
  if (!rec) return false;
  if (rec.replaceInFlight || rec.initialStopInFlight || rec.cancelInFlight) return false;
  books.delete(key);
  return true;
}

/**
 * Record an unresolved broker stop for this strategy position only.
 * A second position in the same option contract does not see or replace it.
 */
export function rememberUnconfirmedStop(strategy, position, orderId, state = STOP_STATE.PLACED_UNCONFIRMED) {
  if (!orderId) return;
  const key = ledgerKey(strategy, position);
  const entry = {
    orderId: String(orderId),
    state,
    key,
  };
  const previous = unconfirmedByPosition.get(key);
  if (previous && previous.orderId !== entry.orderId) {
    const indexed = unconfirmedByOrderId.get(previous.orderId);
    if (indexed?.key === key) unconfirmedByOrderId.delete(previous.orderId);
  }
  unconfirmedByPosition.set(key, entry);
  const indexed = unconfirmedByOrderId.get(entry.orderId);
  if (!indexed || indexed.key === key) {
    unconfirmedByOrderId.set(entry.orderId, entry);
  }
}

export function lookupUnconfirmedStop(strategy, position) {
  return unconfirmedByPosition.get(ledgerKey(strategy, position)) || null;
}

export function unconfirmedStateForOrder(orderId) {
  if (!orderId) return null;
  return unconfirmedByOrderId.get(String(orderId))?.state || null;
}

export function forgetUnconfirmedStop(strategy, position, orderId = null) {
  const key = ledgerKey(strategy, position);
  const existing = unconfirmedByPosition.get(key);
  if (existing) {
    unconfirmedByPosition.delete(key);
    const indexed = unconfirmedByOrderId.get(existing.orderId);
    if (indexed?.key === key) unconfirmedByOrderId.delete(existing.orderId);
  }
  if (orderId) {
    const indexed = unconfirmedByOrderId.get(String(orderId));
    if (!indexed || indexed.key === key) unconfirmedByOrderId.delete(String(orderId));
  }
}

export function isUnconfirmedStopResult(result) {
  if (!result) return false;
  const state = result.stopProtectionState;
  if (state === STOP_STATE.FILLED || result.reason === 'child_already_filled') return true;
  if (!result.orderId) return false;
  if (UNRESOLVED.has(state)) return true;
  if (result.unresolved === true) return true;
  const reason = String(result.reason || '');
  return reason === 'stop_status_unconfirmed' || reason === 'cancel_unconfirmed' || reason.includes('cancel_unconfirmed');
}

export function resetStopBookForTests() {
  books.clear();
  unconfirmedByPosition.clear();
  unconfirmedByOrderId.clear();
}
