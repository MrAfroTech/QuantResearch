# Timeline Analysis: Triplicate Trade Event (2026-07-15)

## Reconstructed Event Timeline

### T-5 minutes: Setup Phase
```
09:40:00 ET (04:40:00 UTC) — Premarket range established
  ├─ IWM premarket high: ~$XXX.XX
  ├─ IWM premarket low: ~$XXX.XX
  └─ FSM state: { phase: 'watching' }
```

### T-0: Breakout Detection
```
09:44:00 ET (04:44:00 UTC) — 5-minute bar closes
  ├─ IWM breaks above premarket high
  ├─ FSM detects breakout → phase: 'awaiting_confirmation'
  └─ FSM persisted to database
```

### Critical Window: Triple Execution

**09:45:04 ET (04:45:04 UTC) — Poll Cycle #1**
```
1. Fetch bars from Tradier → includes 04:44:00 bar
2. Load FSM from DB → { phase: 'awaiting_confirmation', breakout_level: XXX.XX }
3. Filter newBars → [04:44:00 bar] (passes filter)
4. processBar(04:44:00):
   ├─ Confirmation detected (close still above breakout level)
   ├─ buildEntry() creates entry signal
   └─ resetFsm() → { phase: 'watching', breakout_level: null }
5. Update last_processed_bar_time = '2026-07-15T04:44:00'
6. BEGIN ASYNC: persistSymbolRangeState()
7. tryExecuteEntry():
   ├─ Mode check: AUTO ✓
   ├─ Position count: 0 ✓
   ├─ Budget: $323.46 ✓
   ├─ Strike selection: $XXX strike
   ├─ Premium: $0.58
   └─ BEGIN ASYNC: placeOptionOrder() → Order #1
8. BEGIN ASYNC: insertPremarketPosition()
9. ASYNC PENDING: addPremarketMonthlySpend()

⏰ Database writes still in-flight...
```

**09:45:06 ET (04:45:06 UTC) — Poll Cycle #2 (+2 seconds)**
```
1. Fetch bars from Tradier → SAME 04:44:00 bar (cache)
2. Load FSM from DB → { phase: 'watching', last_processed_bar_time: '04:39:00' } ⚠️ STALE
   └─ Poll #1's persist not yet visible
3. Filter newBars → [04:44:00 bar] ⚠️ PASSES FILTER AGAIN
4. processBar(04:44:00):
   ├─ phase = 'watching' + close > pmHigh → BREAKOUT DETECTED AGAIN
   ├─ Next iteration: confirmation detected AGAIN
   ├─ buildEntry() creates DUPLICATE entry
   └─ resetFsm()
5. tryExecuteEntry():
   ├─ Mode check: AUTO ✓
   ├─ Position count: 1 ✓ (Poll #1's position just committed)
   ├─ Budget: $323.46 ✓ (addPremarketMonthlySpend not called yet)
   ├─ Strike selection: SAME $XXX strike
   ├─ Premium: $0.58 (SAME)
   └─ placeOptionOrder() → Order #2 ⚠️ DUPLICATE
6. insertPremarketPosition() → DUPLICATE INSERT SUCCEEDS (no unique constraint)
```

**09:45:07 ET (04:45:07 UTC) — Poll Cycle #3 (+1 second)**
```
1. Fetch bars → SAME bar (still cached)
2. Load FSM → Still stale (writes queued)
3. Filter → PASSES AGAIN
4. processBar → SAME LOGIC REPEATS
5. tryExecuteEntry():
   ├─ Position count: 2 ✓
   ├─ Budget: Still passing (race condition)
   └─ Order #3 placed ⚠️ TRIPLICATE
```

### T+1 minute: Consolidation
```
09:46:00 ET — Next scheduled poll cycle
  ├─ Database finally consistent
  ├─ Three identical positions now open
  ├─ getPremarketOpenPositionCount() → 3
  ├─ Max positions reached
  └─ No new entries possible until one closes
```

---

## Why Three Polls in 3 Seconds?

### Hypothesis 1: Server Restart During Deployment ⭐⭐⭐ MOST LIKELY
```
Scenario:
- Railway deployment triggered at 09:45:00 ET
- Old instance shutdown → pending cron timer fires
- New instance starts → cron initializes → fires immediately
- Another queued timer fires 1 second later
```

**Evidence For**:
- 3-second window is too fast for normal 5-minute cron
- Irregular 2s + 1s spacing (not uniform)
- Consistent with process restart behavior

**Evidence Against**:
- No deployment logs available to verify

---

### Hypothesis 2: Event Loop Backpressure 🔄 POSSIBLE
```
Scenario:
- Previous poll cycles blocked on slow async operations
- Multiple cron triggers queued in event loop
- Backpressure released → all timers fire rapidly
```

**Evidence For**:
- Node.js can queue timers if event loop is busy
- Premarket scan involves multiple API calls (Tradier, Tastytrade)

**Evidence Against**:
- Scheduler catches errors (line 148-149), shouldn't block completely
- Would expect more than 3 if this were the cause

---

### Hypothesis 3: Manual API Call + Cron Collision ⚠️ LESS LIKELY
```
Scenario:
- Cron fired at 09:45:04
- User (or monitoring tool) called /api/scan at 09:45:06
- Another manual call at 09:45:07
```

**Evidence For**:
- Could explain precise 2s + 1s spacing

**Evidence Against**:
- No manual trigger endpoint directly calls `runPremarketScanAndExecute()`
- Would require three separate manual triggers in 3 seconds

---

## Database Race Condition Details

### Postgres Transaction Isolation

**Current behavior** (`premarketDb.js`):
```javascript
// Line 208-236: upsertPremarketRangeState()
await sql`
  INSERT INTO premarket_state (symbol, trade_date, pm_high, pm_low, range_complete, fsm_json, updated_at)
  VALUES (...)
  ON CONFLICT (symbol, trade_date) DO UPDATE SET
    pm_high = EXCLUDED.pm_high,
    pm_low = EXCLUDED.pm_low,
    range_complete = EXCLUDED.range_complete,
    fsm_json = EXCLUDED.fsm_json,
    updated_at = NOW()::text
`;
```

**Problem**:
- Upsert is atomic **per statement**
- But `last_processed_bar_time` is updated **outside** the FSM upsert
- Poll #2 reads between Poll #1's entry creation and FSM update

**Timeline in microseconds**:
```
T+0ms:   Poll #1 starts
T+50ms:  Poll #1 creates entry, resets FSM
T+150ms: Poll #1 begins persist (async)
T+2000ms: Poll #2 starts ⚠️ Poll #1's persist not committed yet
T+2050ms: Poll #2 reads stale FSM
T+2100ms: Poll #2 creates duplicate entry
T+2200ms: Poll #1's persist finally commits
T+3000ms: Poll #3 starts, same scenario
```

---

## Prevention Strategies (Do Not Implement Yet)

### Short-Term: Idempotency Check
```javascript
// In tryExecuteEntry(), before strike selection:
const existingToday = await sql`
  SELECT id FROM premarket_positions
  WHERE ticker = ${entry.symbol}
    AND direction = ${entry.direction}
    AND DATE(opened_at) = CURRENT_DATE
    AND status = 'OPEN'
`;
if (existingToday.length > 0) {
  return { executed: false, reason: 'duplicate_entry_today' };
}
```

### Mid-Term: Database Constraint
```sql
ALTER TABLE premarket_positions
ADD CONSTRAINT unique_position_per_day
UNIQUE (ticker, direction, strike, expiration, DATE(opened_at));
```

### Long-Term: Mutex Lock
```javascript
let premarketScanLock = false;

export async function runPremarketScanAndExecute() {
  if (premarketScanLock) {
    console.warn('[Premarket] Scan already running, skipping');
    return { skipped: true, reason: 'lock_held' };
  }
  premarketScanLock = true;
  try {
    // ... existing logic ...
  } finally {
    premarketScanLock = false;
  }
}
```

---

## Verification Steps (For Future Investigation)

If logs were available, we'd look for:
```
[Scheduler] Running market-hours poll...
[Scheduler] Premarket scan error: <none>
[Premarket] Order placed: IWM CALL ...
[Scheduler] Running market-hours poll...  ⚠️ WITHIN 3 SECONDS
[Premarket] Order placed: IWM CALL ...    ⚠️ DUPLICATE
[Scheduler] Running market-hours poll...  ⚠️ AGAIN
[Premarket] Order placed: IWM CALL ...    ⚠️ TRIPLICATE
```

**Database query to verify** (if executed):
```sql
SELECT
  id,
  ticker,
  direction,
  strike,
  entry_premium,
  opened_at,
  EXTRACT(EPOCH FROM (opened_at::timestamp - LAG(opened_at::timestamp) OVER (ORDER BY opened_at))) AS seconds_since_prev
FROM premarket_positions
WHERE DATE(opened_at) = '2026-07-15'
  AND ticker = 'IWM'
  AND direction = 'CALL'
ORDER BY opened_at;
```

Expected output:
```
| id  | ticker | strike | entry_premium | opened_at            | seconds_since_prev |
|-----|--------|--------|---------------|----------------------|--------------------|
| 123 | IWM    | XXX    | 0.58          | 2026-07-15 04:45:04  | NULL               |
| 124 | IWM    | XXX    | 0.58          | 2026-07-15 04:45:06  | 2                  |
| 125 | IWM    | XXX    | 0.58          | 2026-07-15 04:45:07  | 1                  |
```

---

**End of Timeline Analysis**
