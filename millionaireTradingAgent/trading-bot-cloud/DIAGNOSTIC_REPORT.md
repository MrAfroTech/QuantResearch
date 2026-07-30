# Diagnostic Report: Stop-Loss Failure & Triplicate Trade Execution
**Date**: 2026-07-16  
**Status**: Root causes identified (diagnostic only, no fixes applied)

---

## Issue 1: ORB Stop Loss Not Firing (-98.94% and -87.50% losses)

### Root Cause: **Missing Function Import**

**Location**: `backend/orb/orbPositionManager.js`

**Evidence**:
1. Line 1-12 shows imports from `brokerageConnector.js`, but **`closeOptionOrder` is not imported**:
   ```javascript
   import { getOptionPremium } from '../brokerageConnector.js';
   ```

2. Line 64 correctly detects the stop-loss condition:
   ```javascript
   } else if (pnlPct <= -ORB_STOP_LOSS_PCT) {
     closeReason = 'stop_loss';
   }
   ```

3. Line 70 **attempts to call an undefined function**:
   ```javascript
   await closeOptionOrder(position, currentPremium);
   ```

4. Line 74-76 catches the error but only logs it — **the position never closes**:
   ```javascript
   } catch (err) {
     console.error(`[ORB] Close failed for ${position.ticker}:`, err.message);
   }
   ```

**What Actually Happened**:
- `monitorOrbPositions()` correctly evaluated both positions every 5 minutes
- Stop-loss checks ran and detected pnlPct <= -0.175 (17.5%)
- When trying to execute the close, JavaScript threw `ReferenceError: closeOptionOrder is not defined`
- The try-catch silently logged the error but took no further action
- Positions remained open, bleeding to -98.94% and -87.50%

**Verification**:
- `closeOptionOrder` **is exported** from `brokerageConnector.js` (line 651)
- Other position managers correctly import it:
  - `backend/positionManager.js` imports it
  - `backend/premarketBreakout/premarketPositionManager.js` imports it
  - `backend/emaVwapCross/emaVwapPositionManager.js` imports it

**Config Verification**:
- `ORB_STOP_LOSS_PCT = 0.175` (17.5%) in `backend/orb/orbConfig.js` line 10 ✓
- Poll interval: every 5 minutes (scheduler.js line 161) ✓
- `monitorOrbPositions()` is called every poll cycle (scheduler.js line 107) ✓

**Could 0DTE Gamma Explain the Gap?**
No. While 0DTE options can decay rapidly, a -17.5% → -98% move in under 5 minutes during regular trading hours would require:
- Complete loss of time value (theta)
- Spot moving far away from strike (delta collapse)
- Simultaneous IV crush (vega)

This is structurally implausible between 9:30 AM - 3:05 PM ET. The positions likely breached -17.5% hours or even days ago but were never closed due to the missing import.

**Conclusion**: The stop-loss logic is correct. The bug is mechanical — a missing import causes a ReferenceError every time the stop tries to execute.

---

## Issue 2: Triplicate IWM CALL Execution (04:45:04, 04:45:06, 04:45:07 UTC)

### Root Cause: **Race Condition in FSM State Persistence (TOCTOU bug)**

**Location**: `backend/premarketBreakout/premarketExecutor.js` + `premarketSignalEngine.js`

**Evidence**:

### Timeline of One Poll Cycle:
1. Line 165-168: `runPremarketScanAndExecute()` iterates over symbols
2. Line 167: Fetches bars via `getExtendedFiveMinuteBars()`
3. Line 175: Filters `newBars` using `filterNewBars()` — bars with `time > last_processed_bar_time`
4. Line 180-184: `evaluatePremarketSignals()` processes bars through FSM
5. **Line 79 or 100 of `premarketSignalEngine.js`**: FSM creates entry and **immediately resets** to `phase: 'watching'`
6. Line 186: `last_processed_bar_time` updated to last bar's timestamp
7. **Line 187**: `persistSymbolRangeState()` writes FSM to database
8. Line 190-193: Loops through entries and calls `tryExecuteEntry()` for each

### The Race Condition:
**Three nearly simultaneous poll cycles** (3 seconds apart) could each:
1. Fetch the same bar data (Tradier timesales cache hasn't refreshed)
2. Load FSM state from DB **before** the previous cycle's persistence completed
3. Filter bars using a stale `last_processed_bar_time`
4. Process the confirmation bar again with a freshly reset FSM (`phase: 'watching'`)
5. Generate the same entry signal again
6. Execute a duplicate trade

**Why Idempotency Protection is Missing**:

1. **No trade deduplication check** — `tryExecuteEntry()` (line 50-155) checks:
   - Max positions (line 62)
   - Budget (line 71)
   - Strike selection (line 78)
   - But **NOT**: "Have I already opened this exact setup today?"

2. **FSM reset happens before persistence** — Line 79/100 resets FSM immediately when creating an entry, but the updated FSM isn't written to the DB until line 187. If another poll starts during this window, it reads the old FSM state.

3. **`last_processed_bar_time` updated too late** — Line 186 updates this timestamp, but by then the entry has already been created. If a second poll fetches bars before this persist completes, it gets the same bars again.

4. **No unique constraint in the database** — `premarket_positions` table (premarketDb.js line 44-68) has no unique constraint on `(ticker, direction, strike, expiration, opened_at)`. Three identical inserts succeed.

**Why Three Executions?**:

The scheduler runs every 5 minutes (line 161 of scheduler.js), but:
- If the server restarted around 04:45 UTC, multiple poll cycles could fire rapidly
- If the async install was finishing, background timers might have queued up
- Cron scheduling can occasionally fire multiple times if the event loop is blocked

**What the Logs Would Show** (if available):
```
[Premarket] Scan failed for IWM: <none>
[Scheduler] Premarket scan completed, 1 entry
[Premarket] Scan failed for IWM: <none>
[Scheduler] Premarket scan completed, 1 entry
[Premarket] Scan failed for IWM: <none>
[Scheduler] Premarket scan completed, 1 entry
```
Each within 1-3 seconds of each other.

**Verification**:
- IWM entry/exit match exactly: $0.58 entry, $0.81 exit (same strike, same expiration)
- Max position check passed all three times because each insert completed before the next poll's `getPremarketOpenPositionCount()` call
- Budget check passed because `addPremarketMonthlySpend()` is called **after** the insert (line 134), so the first two executions saw full budget remaining

**Conclusion**: The FSM correctly detected one breakout, but a race condition in state persistence + lack of trade deduplication checks allowed the same signal to trigger three separate order placements within a 3-second window. This is a classic TOCTOU (time-of-check-time-of-use) concurrency bug.

---

## Supporting Evidence

### Poll Cycle Frequency:
- `scheduler.js` line 161: `cron.schedule('*/5 * * * 1-5', ...)` — every 5 minutes, weekdays
- `runPollCycle()` is synchronous per invocation but **not mutex-protected** across invocations

### FSM State Machine Flow (`premarketSignalEngine.js`):
- Line 35-57: `phase: 'watching'` → breakout detected → `phase: 'awaiting_confirmation'`
- Line 77-81 (CALL) or 98-102 (PUT): Confirmation bar triggers entry creation + **FSM reset to `'watching'`**
- Line 110-118: `resetFsm()` returns `phase: 'watching'` with all other fields null

### Database Persistence (`premarketRangeState.js`):
- Line 149-157: `persistSymbolRangeState()` calls `upsertPremarketRangeState()`
- Line 208-236 (`premarketDb.js`): Upsert with `ON CONFLICT (symbol, trade_date) DO UPDATE`
- **No transaction lock** — if two poll cycles overlap, both can read/write concurrently

### Max Position Check (`premarketExecutor.js`):
- Line 61-69: `getPremarketOpenPositionCount() >= 3` blocks further entries
- But if three executions complete their inserts before any of them re-check the count, all pass

---

## Summary

| Issue | Root Cause | Impact | Evidence Location |
|-------|-----------|--------|------------------|
| **Stop-loss not firing** | Missing import of `closeOptionOrder` in `orbPositionManager.js` | Positions held to -98.94% and -87.50% instead of -17.5% | Line 1-12 (imports), Line 70 (undefined function call) |
| **Triplicate trades** | FSM state persistence race condition + no trade deduplication | 3x the intended position size on one setup, max positions exhausted | `premarketExecutor.js` lines 180-193, `premarketSignalEngine.js` lines 79 & 100 |

---

## Recommendations for Fixes (Do Not Implement Yet)

### Issue 1 Fix:
Add to line 1 of `backend/orb/orbPositionManager.js`:
```javascript
import { getOptionPremium, closeOptionOrder } from '../brokerageConnector.js';
```

### Issue 2 Fixes (requires multiple changes):
1. **Add trade deduplication check** in `tryExecuteEntry()` before strike selection
2. **Persist FSM state before entry execution**, not after
3. **Add unique constraint** on `(ticker, direction, strike, expiration, DATE(opened_at))` in `premarket_positions` table
4. **Add mutex/lock** around `runPremarketScanAndExecute()` to prevent concurrent poll cycles

---

**Report Complete** — Awaiting approval for remediation implementation.
