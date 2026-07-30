# Technical Verification: Code Path Analysis

This document provides detailed code flow verification for both diagnostic issues.

---

## Issue 1 Verification: Missing Import in ORB Position Manager

### Import Statement Analysis

**File**: `backend/orb/orbPositionManager.js`

**Current imports (lines 1-12)**:
```javascript
import { getOptionPremium } from '../brokerageConnector.js';
import {
  ORB_PROFIT_PCT,
  ORB_STOP_LOSS_PCT,
} from './orbConfig.js';
import {
  getOrbOpenPositions,
  updateOrbPositionExcursion,
  closeOrbPosition,
} from './orbDb.js';
import { isAtOrAfterTimeStop, isWithinOrbSession } from './tradierTimesales.js';
import { sendOrbTradeClosedTelegram } from './orbTelegram.js';
```

**Missing**: `closeOptionOrder` from `'../brokerageConnector.js'`

### Execution Flow When Stop-Loss Triggers

```
monitorOrbPositions() [Line 23]
  ├─ Loop through positions [Line 31]
  │   ├─ Fetch currentPremium via getOptionPremium() [Line 34-39] ✓ WORKS
  │   ├─ Calculate pnlPct [Line 48]
  │   ├─ Check stop-loss: pnlPct <= -0.175 [Line 64] ✓ WORKS
  │   ├─ Set closeReason = 'stop_loss' [Line 65] ✓ WORKS
  │   └─ Try to execute close [Line 68-76]:
  │       ├─ Call closeOptionOrder(position, currentPremium) [Line 70] ❌ FAILS
  │       │   └─ ReferenceError: closeOptionOrder is not defined
  │       ├─ Call closeOrbPosition() [Line 71] ⊘ NEVER REACHED
  │       ├─ Send Telegram notification [Line 72] ⊘ NEVER REACHED
  │       └─ Catch block logs error [Line 75] ✓ LOGS ERROR
  │           └─ console.error(`[ORB] Close failed for ${position.ticker}:`, err.message)
  │               → Output: "[ORB] Close failed for IWM: closeOptionOrder is not defined"
  └─ Return actions (no close action added)
```

### Comparison: Other Position Managers That Work

**`backend/positionManager.js` (SWING strategy)** — Line 1-9:
```javascript
import {
  getOptionPremium,
  closeOptionOrder,  // ✓ IMPORTED
  isPaperTrading,
} from './brokerageConnector.js';
```

**`backend/premarketBreakout/premarketPositionManager.js`** — Line 1-5:
```javascript
import {
  getOptionPremium,
  closeOptionOrder,  // ✓ IMPORTED
} from '../brokerageConnector.js';
```

**`backend/emaVwapCross/emaVwapPositionManager.js`** — Line 1-5:
```javascript
import {
  getOptionPremium,
  closeOptionOrder,  // ✓ IMPORTED
} from '../brokerageConnector.js';
```

### Why the Positions Bled to -98%

1. **First stop-loss check at -17.5%** → ReferenceError thrown → caught → position stays open
2. **Every subsequent 5-minute check** → Same error → Same catch → Position still open
3. **No circuit breaker** — the error handler doesn't:
   - Force-close the position via database
   - Escalate to manual intervention
   - Prevent further checks
4. **0DTE time decay** continues unchecked until expiration or -99%

### Proof That Stop-Loss Logic is Correct

**Config file** (`backend/orb/orbConfig.js` line 10):
```javascript
export const ORB_STOP_LOSS_PCT = 0.175;  // 17.5%
```

**Comparison in position manager** (line 64):
```javascript
} else if (pnlPct <= -ORB_STOP_LOSS_PCT) {  // pnlPct <= -0.175
  closeReason = 'stop_loss';
}
```

✓ Math is correct: `-0.9894 <= -0.175` → TRUE  
✓ Math is correct: `-0.8750 <= -0.175` → TRUE

The logic **detected** both stop-losses correctly. The **execution** failed due to the missing import.

---

## Issue 2 Verification: Race Condition in Premarket Executor

### Normal Single-Execution Flow

```
runPremarketScanAndExecute() [Line 157]
  ├─ For each symbol (IWM, etc.) [Line 165]
  │   ├─ Fetch bars: getExtendedFiveMinuteBars() [Line 167]
  │   ├─ Load range state from DB [Line 168]
  │   ├─ Check if after market open [Line 170-172]
  │   ├─ Get post-open bars [Line 174]
  │   ├─ Filter new bars: time > last_processed_bar_time [Line 175]
  │   ├─ If newBars.length === 0, skip [Line 177-179]
  │   └─ Evaluate signals [Line 180-184]:
  │       └─ evaluatePremarketSignals(rangeState, newBars)
  │           ├─ For each bar [Line 21-26]
  │           │   └─ processBar(bar, fsm, pmHigh, pmLow, symbol)
  │           │       ├─ Detect breakout → phase: 'awaiting_confirmation' [Line 36-54]
  │           │       └─ Confirmation bar → buildEntry() + resetFsm() [Line 77-81 or 98-102]
  │           └─ Return { rangeState, events, entries }
  │               └─ entries[0] = { symbol: 'IWM', direction: 'CALL', ... }
  ├─ Update FSM last_processed_bar_time [Line 186]
  ├─ Persist updated FSM state to DB [Line 187]
  └─ For each entry [Line 190-193]:
      └─ tryExecuteEntry(entry)
          ├─ Check mode === 'MANUAL' [Line 51-59]
          ├─ Check max positions [Line 61-69]
          ├─ Check budget [Line 71-75]
          ├─ Select strike [Line 77-88]
          ├─ Place order [Line 101-108]
          └─ Insert position into DB [Line 110-132]
```

### Pathological Race Condition Flow (3 Simultaneous Polls)

**Time: 04:45:04 UTC**
```
Poll #1 starts:
  ├─ Fetch bars → includes bar @ 2026-07-15 04:44:00
  ├─ Load FSM from DB → { phase: 'awaiting_confirmation', ... }
  ├─ Filter newBars → [bar @ 04:44:00]
  ├─ processBar(04:44:00) → confirmation detected
  │   ├─ buildEntry() creates entry
  │   └─ resetFsm() → { phase: 'watching', breakout_level: null, ... }
  ├─ Update last_processed_bar_time = '2026-07-15T04:44:00'
  ├─ Persist to DB (async write starts, not yet committed)
  └─ tryExecuteEntry()
      ├─ getPremarketOpenPositionCount() → 0
      ├─ getPremarketBudgetRemaining() → $323.46
      ├─ placeOptionOrder() → Order #1 placed
      └─ insertPremarketPosition() → DB write starts
```

**Time: 04:45:06 UTC (2 seconds later)**
```
Poll #2 starts BEFORE Poll #1's persistence completes:
  ├─ Fetch bars → includes bar @ 2026-07-15 04:44:00 (same data, Tradier cache)
  ├─ Load FSM from DB → { phase: 'watching', ... } (Poll #1's reset, but last_processed_bar_time is OLD)
  ├─ Filter newBars → [bar @ 04:44:00] (passes filter because DB not updated yet)
  ├─ processBar(04:44:00) → SAME LOGIC RUNS AGAIN
  │   ├─ phase = 'watching' + close > pmHigh → phase: 'awaiting_confirmation'
  │   └─ Next bar (or same bar) → buildEntry() + resetFsm()
  ├─ tryExecuteEntry()
      ├─ getPremarketOpenPositionCount() → 1 (Poll #1's position just inserted)
      ├─ getPremarketBudgetRemaining() → $323.46 (Poll #1's spend not updated yet)
      ├─ placeOptionOrder() → Order #2 placed
      └─ insertPremarketPosition() → DB write starts
```

**Time: 04:45:07 UTC (1 second later)**
```
Poll #3 starts:
  ├─ Same scenario as Poll #2
  ├─ getPremarketOpenPositionCount() → 2
  ├─ Budget check passes (addPremarketMonthlySpend hasn't been called for all 3 yet)
  └─ Order #3 placed
```

### Why No Idempotency Protection?

**1. No Trade Deduplication Check**:
```javascript
// tryExecuteEntry() checks:
- Mode (MANUAL/AUTO)
- Max positions (3)
- Budget remaining
// BUT DOES NOT CHECK:
- "Is there already a position with this exact ticker/direction/strike/expiration opened today?"
```

**2. FSM Persistence Timing**:
```javascript
// premarketSignalEngine.js line 79-80:
next.entry = buildEntry(symbol, direction, pmHigh, pmLow, fsm, bar);
next.fsm = resetFsm();  // Reset happens IMMEDIATELY

// But persistence is LATER in premarketExecutor.js line 187:
await persistSymbolRangeState(updatedState);
```
⏰ **Time window**: 100-500ms between FSM reset and DB write completion

**3. last_processed_bar_time Updated After Signal Evaluation**:
```javascript
// premarketExecutor.js line 186-187:
updatedState.fsm.last_processed_bar_time = newBars[newBars.length - 1].time;
await persistSymbolRangeState(updatedState);
```
If Poll #2 reads from DB before this write commits, it gets stale `last_processed_bar_time`.

### Database Constraint Analysis

**`premarket_positions` table** (`premarketDb.js` line 44-68):
```sql
CREATE TABLE IF NOT EXISTS premarket_positions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticker TEXT NOT NULL,
  direction TEXT NOT NULL,
  strike DOUBLE PRECISION NOT NULL,
  expiration TEXT NOT NULL,
  entry_premium DOUBLE PRECISION NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  order_id TEXT,
  broker TEXT,
  opened_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  -- ... other fields ...
)
```

❌ **No unique constraint** on `(ticker, direction, strike, expiration, opened_at)`  
✓ Three identical inserts succeed (different `id` values)

### Why Scheduler Could Fire 3 Times in 3 Seconds

**Normal operation**: Cron fires every 5 minutes (scheduler.js line 161)

**Anomaly scenarios**:
1. **Server restart during deployment** → Cron re-initializes → pending timers fire
2. **Event loop backpressure** → Multiple cron triggers queue up → all fire when loop unblocks
3. **Clock skew** → Cron library (node-cron) sees time jump → fires multiple times
4. **Manual trigger** → If `/api/scan` endpoint was called simultaneously with cron

**Evidence from timestamps**:
- 04:45:04 UTC
- 04:45:06 UTC (+2s)
- 04:45:07 UTC (+1s)

This 2s-1s pattern is **NOT** consistent with a 5-minute cron. Likely a restart/queue scenario.

---

## Summary Table

| Component | Expected Behavior | Actual Behavior | Root Cause |
|-----------|------------------|-----------------|------------|
| **ORB Stop-Loss** | Close position at -17.5% | Position stays open to -98% | `closeOptionOrder` not imported |
| **Premarket Dedup** | Execute once per breakout | Execute 3 times in 3 seconds | Race condition + no idempotency check |
| **FSM State** | Persist before execution | Persist after signal evaluation | Design flaw in `premarketExecutor.js` |
| **Budget Check** | Block if budget exhausted | Passes 3 times | `addPremarketMonthlySpend()` called after order placement |
| **Position Count** | Block if >= 3 positions | Passes 3 times | Inserts complete before re-check |

---

## Files Requiring Changes (Do Not Modify Yet)

### Issue 1:
- `backend/orb/orbPositionManager.js` (add import)

### Issue 2:
- `backend/premarketBreakout/premarketExecutor.js` (add mutex + dedup check)
- `backend/premarketBreakout/premarketSignalEngine.js` (reorder persistence)
- `backend/premarketBreakout/premarketDb.js` (add unique constraint)

**End of Verification**
