import { getBrokerOrderStatus } from '../brokerageConnector.js';

/** Same fill-poll window as waitForBrokerOrderFill (6dfc5f7). */
export const ENTRY_FILL_WAIT_TIMEOUT_MS = 15_000;
export const ENTRY_FILL_WAIT_POLL_MS = 1_000;

/** 0DTE backoff: 2s → 4s → 8s → 16s → 30s cap. */
export const STOP_RETRY_BACKOFF_INITIAL_MS = 2_000;
export const STOP_RETRY_BACKOFF_MAX_MS = 30_000;

/** THE3-2 candidate: open + no resting stop louder after this grace. */
export const UNPROTECTED_STOP_ALERT_AFTER_MS = 45_000;
export const UNPROTECTED_STOP_ALERT_COOLDOWN_MS = 5 * 60 * 1000;

const inFlight = new Map();

export function isEntryNotFilledStopConflict(reason) {
  return /illegal_buy_and_sell_on_same_symbol/i.test(String(reason || ''));
}

export function nextStopRetryBackoffMs(attemptNumber) {
  const attempt = Math.max(1, Number(attemptNumber) || 1);
  return Math.min(
    STOP_RETRY_BACKOFF_MAX_MS,
    STOP_RETRY_BACKOFF_INITIAL_MS * 2 ** (attempt - 1)
  );
}

export function resetInitialStopRetryStateForTests() {
  inFlight.clear();
}

function stopRetryKey(strategy, positionId) {
  return `${String(strategy || 'unknown')}:${positionId}`;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll entry order until filled, terminal, timeout, or abort.
 * PAPER-* ids are treated as already filled so paper paths do not spin.
 */
export async function waitForEntryOrderFill(
  orderId,
  {
    environment,
    strategy,
    timeoutMs = ENTRY_FILL_WAIT_TIMEOUT_MS,
    pollMs = ENTRY_FILL_WAIT_POLL_MS,
    shouldAbort,
    sleep = defaultSleep,
    now = Date.now,
    getStatus = getBrokerOrderStatus,
  } = {}
) {
  if (!orderId || String(orderId).startsWith('PAPER-')) {
    return { status: 'paper', isFilled: true, isTerminal: true, skipped: true };
  }

  const deadline = now() + timeoutMs;
  let last = null;
  while (now() < deadline) {
    if (shouldAbort && (await shouldAbort())) {
      return { aborted: true, last, isFilled: false, isTerminal: false };
    }
    last = await getStatus(orderId, { environment, strategy });
    if (last?.isFilled || last?.isTerminal) return last;
    await sleep(pollMs);
  }
  return last || { isFilled: false, isTerminal: false, status: 'timeout' };
}

async function readOpenState(getOpenPosition) {
  if (typeof getOpenPosition !== 'function') {
    return { open: true, protected: false, row: null };
  }
  const row = await getOpenPosition();
  if (!row) return { open: false, protected: false, row: null };
  return {
    open: true,
    protected: Boolean(row.broker_stop_order_id),
    row,
  };
}

/**
 * Place the initial resting stop and never give up while the position is still
 * open and unprotected. Does not block forever on the caller — use the returned
 * promise; executors/monitors should not await it past fire-and-forget.
 *
 * illegal_buy_and_sell_on_same_symbol: wait for BTO fill, then retry place.
 * Any other failure: exponential backoff, then retry place.
 * Stops only when the stop rests or the position is no longer OPEN.
 */
export function ensureInitialBrokerStopUntilProtected(
  position,
  {
    strategy,
    environment,
    placeStop,
    getOpenPosition,
    onUnprotectedAlert = null,
    waitForFill = waitForEntryOrderFill,
    sleep = defaultSleep,
    now = Date.now,
    isBrokerStillLong = null,
    onBrokerAlreadyFlat = null,
  } = {}
) {
  const positionId = position?.id;
  const key = stopRetryKey(strategy, positionId);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const startedAt = now();
  const entryOrderId = position?.order_id || position?.orderId || null;

  const run = (async () => {
    let attempt = 0;
    let lastAlertAt = null;
    let skipNextFlatCheck = false;

    const abortIfBrokerFlat = async (row) => {
      if (typeof isBrokerStillLong !== 'function') return null;
      let stillLong;
      try {
        stillLong = await isBrokerStillLong(row || position);
      } catch (err) {
        console.warn(
          `[LadderStop][${strategy}] broker long lookup failed #${positionId}:`,
          err.message
        );
        return null;
      }
      if (stillLong !== false) return null;
      console.error(
        `[LadderStop][${strategy}] UNPROTECTED retry stopped — broker already flat #${positionId}`
      );
      if (typeof onBrokerAlreadyFlat === 'function') {
        try {
          await onBrokerAlreadyFlat({ position: row || position, attempt });
        } catch (err) {
          console.error(
            `[LadderStop][${strategy}] broker-flat settle failed #${positionId}:`,
            err.message
          );
        }
      }
      return { placed: false, reason: 'broker_already_flat', brokerFlat: true, attempt };
    };

    while (true) {
      const state = await readOpenState(getOpenPosition);
      if (!state.open) {
        console.log(
          `[LadderStop][${strategy}] Stop retry stopped — #${positionId} no longer open`
        );
        return { placed: false, reason: 'position_closed', attempt };
      }
      if (state.protected) {
        console.log(
          `[LadderStop][${strategy}] Stop already resting #${positionId} order=${state.row.broker_stop_order_id}`
        );
        return {
          placed: true,
          alreadyProtected: true,
          orderId: state.row.broker_stop_order_id,
          attempt,
        };
      }

      if (attempt >= 1 && !skipNextFlatCheck) {
        const flat = await abortIfBrokerFlat(state.row || position);
        if (flat) return flat;
      }
      skipNextFlatCheck = false;

      attempt += 1;
      let result;
      try {
        result = await placeStop(state.row || position);
      } catch (err) {
        result = { placed: false, reason: err.message, error: err };
      }

      if (result?.placed) {
        const elapsed = now() - startedAt;
        console.log(
          `[LadderStop][${strategy}] Stop resting #${positionId} after ${attempt} attempt(s) ` +
            `elapsed=${elapsed}ms order=${result.orderId || result.broker_stop_order_id || '?'}`
        );
        return { ...result, attempt, elapsedMs: elapsed };
      }

      const reason = result?.reason || 'unknown';
      if (!isEntryNotFilledStopConflict(reason)) {
        const flat = await abortIfBrokerFlat(state.row || position);
        if (flat) return flat;
      }
      const elapsed = now() - startedAt;
      console.error(
        `[LadderStop][${strategy}] UNPROTECTED #${positionId} attempt=${attempt} ` +
          `elapsed=${elapsed}ms reason=${reason}`
      );

      if (
        elapsed >= UNPROTECTED_STOP_ALERT_AFTER_MS &&
        (lastAlertAt == null || now() - lastAlertAt >= UNPROTECTED_STOP_ALERT_COOLDOWN_MS)
      ) {
        lastAlertAt = now();
        console.error(
          `[LadderStop][${strategy}] THE3-2 unprotected_broker_stop #${positionId} ` +
            `attempt=${attempt} elapsed=${elapsed}ms ticker=${position?.ticker || '?'} ` +
            `reason=${reason}`
        );
        if (typeof onUnprotectedAlert === 'function') {
          try {
            await onUnprotectedAlert({ attempt, elapsedMs: elapsed, reason, position });
          } catch (err) {
            console.error(
              `[LadderStop][${strategy}] UNPROTECTED alert send failed #${positionId}:`,
              err.message
            );
          }
        }
      }

      if (isEntryNotFilledStopConflict(reason) && entryOrderId) {
        while (true) {
          const fillState = await readOpenState(getOpenPosition);
          if (!fillState.open) {
            return { placed: false, reason: 'position_closed', attempt };
          }
          if (fillState.protected) {
            return {
              placed: true,
              alreadyProtected: true,
              orderId: fillState.row.broker_stop_order_id,
              attempt,
            };
          }

          console.log(
            `[LadderStop][${strategy}] UNPROTECTED #${positionId} waiting for entry fill ` +
              `order=${entryOrderId} attempt=${attempt} elapsed=${now() - startedAt}ms`
          );

          let fill;
          try {
            fill = await waitForFill(entryOrderId, {
              environment,
              strategy,
              sleep,
              now,
              shouldAbort: async () => {
                const s = await readOpenState(getOpenPosition);
                return !s.open || s.protected;
              },
            });
          } catch (err) {
            console.error(
              `[LadderStop][${strategy}] Entry fill poll failed #${positionId}:`,
              err.message
            );
            await sleep(nextStopRetryBackoffMs(attempt));
            continue;
          }

          if (fill?.aborted) {
            const after = await readOpenState(getOpenPosition);
            if (!after.open) return { placed: false, reason: 'position_closed', attempt };
            if (after.protected) {
              return {
                placed: true,
                alreadyProtected: true,
                orderId: after.row.broker_stop_order_id,
                attempt,
              };
            }
          }

          if (fill?.isFilled) {
            console.log(
              `[LadderStop][${strategy}] Entry filled — retrying stop immediately #${positionId}`
            );
            skipNextFlatCheck = true;
            break;
          }

          if (fill?.isTerminal && !fill?.isFilled) {
            console.error(
              `[LadderStop][${strategy}] Entry ${fill.status || 'terminal'} without fill ` +
                `#${positionId} — stop retry stopped (no long to protect)`
            );
            return { placed: false, reason: 'entry_not_filled_terminal', attempt, fill };
          }

          const waitMs = nextStopRetryBackoffMs(attempt);
          console.log(
            `[LadderStop][${strategy}] UNPROTECTED #${positionId} entry still unfilled; ` +
              `backoff ${waitMs}ms then poll fill again`
          );
          await sleep(waitMs);
        }
        continue;
      }

      const waitMs = nextStopRetryBackoffMs(attempt);
      console.log(
        `[LadderStop][${strategy}] UNPROTECTED #${positionId} retry backoff ${waitMs}ms ` +
          `attempt=${attempt}`
      );
      await sleep(waitMs);
    }
  })()
    .catch((err) => {
      console.error(
        `[LadderStop][${strategy}] Stop retry loop crashed #${positionId}:`,
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

export function kickInitialStopUntilProtected(brokerStop, position, extras) {
  if (!brokerStop?.enabled) return null;
  if (typeof brokerStop.ensureInitialStopUntilProtected !== 'function') return null;
  const promise = brokerStop.ensureInitialStopUntilProtected(position, extras);
  if (promise && typeof promise.catch === 'function') {
    promise.catch((err) => {
      console.error(
        `[LadderStop][${extras?.strategy || '?'}] ` +
          `ensureInitialStopUntilProtected rejected #${position?.id}:`,
        err.message
      );
    });
  }
  return promise;
}

export function buildInitialStopRetryExtras({
  strategy,
  position,
  getOpenPositions,
  environment,
  fullClosePosition = null,
  onNotify = null,
}) {
  return {
    getOpenPosition: async () => {
      const open = await getOpenPositions();
      return open.find((p) => Number(p.id) === Number(position.id)) || null;
    },
    onUnprotectedAlert: async ({ attempt, elapsedMs, reason }) => {
      const { sendUnprotectedBrokerStopTelegram } = await import('../telegramHandler.js');
      return sendUnprotectedBrokerStopTelegram({
        strategy,
        positionId: position.id,
        ticker: position.ticker,
        direction: position.direction,
        strike: position.strike,
        attempt,
        elapsedMs,
        reason,
      });
    },
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
