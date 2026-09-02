# Stop-Loss Test Suite

Comprehensive automated test suite for verifying loss containment across all trading strategies.

## Overview

This test suite ensures that no live position can lose more than its configured stop allows. Given that three of four strategies (ORB, Premarket, EMA/VWAP) trade real capital, this is the highest-priority test coverage in the system.

## Current Configured Stop Values (as tested)

| Strategy | Soft Stop | Environment |
|---|---|---|
| ORB | 10% (0.10) | Live + Paper |
| Premarket | 10% (0.10) | Live + Paper |
| EMA/VWAP | 10% (0.10) | Live + Paper |
| Swing | 10% (0.10) | Paper only |

**Note**: All strategies currently use 10% stop-loss. Tests will fail if these values drift.

## Test Coverage

### 1. Config Drift Protection (`01-config-drift.test.js`)
- ✅ Verifies each strategy's stop-loss percentage matches expected value
- ✅ Tests fail LOUDLY if configuration silently changes
- ✅ Validates data types and ranges
- ✅ Checks cross-strategy consistency

**Why this matters**: Guards against exactly the kind of unintended config drift that could allow larger losses.

### 2. Stop Placement Correctness (`02-stop-placement.test.js`)
- ✅ Verifies stops calculated from REAL fill prices, not stale quotes
- ✅ Tests stop trigger price calculation
- ✅ Tests stop limit price calculation
- ✅ Validates rounding and precision for options pricing
- ✅ Regression test for entry-price bug

**Why this matters**: Ensures stops are placed at the correct price based on actual entry, preventing the "stale quote" bug.

### 3. Full Protection Chain (`03-protection-chain.test.js`)
- ✅ Tests initial stop placement on entry
- ✅ Verifies stop order type configuration (stop_market vs stop_limit)
- ✅ Tests stop ratcheting after partial exits
- ✅ Validates broker stop state tracking
- ✅ Tests poll-based fallback protection

**Why this matters**: Ensures the complete protection mechanism works end-to-end, with fallbacks if broker stops fail.

### 4. Worst-Case Scenarios (`04-worst-case-scenarios.test.js`)
- ✅ Simulates violent price moves (gaps through stop)
- ✅ Verifies system RESPONSE, not exact loss amount
- ✅ Tests stop_market vs stop_limit behavior under stress
- ✅ Validates poll-based fallback resilience
- ✅ Tests position quantity edge cases

**Why this matters**: Real markets can gap. Tests verify the system responds correctly even when fills are worse than trigger prices.

**Important**: These tests verify system behavior ("did it try to close?"), not market outcomes ("was loss exactly X%?"). Slippage is real and bounded, not a test failure.

### 5. Regression Suite (`05-regression-suite.test.js`)
Prevents specific bugs from reappearing:
- ✅ Bug 1: Stop-trigger-from-stale-price
- ✅ Bug 2: Zero-fill phantom positions
- ✅ Bug 3: Ghost-open-after-broker-flat
- ✅ Bug 4: Un-awaited recon Promise
- ✅ Bug 5: Node 18 crypto import issues

**Why this matters**: Every bug fixed today must be tested to prevent regression tomorrow.

### 6. Cross-Strategy Isolation (`06-cross-strategy-isolation.test.js`)
- ✅ Verifies independent configuration per strategy
- ✅ Tests shared ladder logic accepts strategy-specific stops
- ✅ Validates database isolation
- ✅ Prevents bug propagation between strategies
- ✅ Tests environment isolation (live vs paper)

**Why this matters**: With shared code, a bug in one strategy could affect others. These tests prevent that.

## Running Tests

### Run all tests
```bash
npm test
```

### Run only stop-loss tests
```bash
npm run test:stop-loss
```

### Run tests in watch mode (during development)
```bash
npm run test:watch
```

### Run tests with detailed output (CI mode)
```bash
npm run test:ci
```

## CI Integration

Tests are automatically run on:
- ✅ Every commit to any branch
- ✅ Every pull request
- ✅ Before every deploy to production

**CI must pass before deploy** - failing stop-loss tests block deployment.

## Test Results Interpretation

### ✅ All Passing
System is correctly configured. Safe to deploy.

### ❌ Config Drift Test Failing
**CRITICAL**: Stop-loss configuration has changed from expected values.
- Review the change: was it intentional?
- Update test expectations if change is approved
- Never silence these tests - they're your safety net

### ❌ Stop Placement Test Failing
**CRITICAL**: Stop calculation logic is broken.
- Positions may not be protected at correct prices
- Do not deploy until fixed

### ❌ Protection Chain Test Failing
**CRITICAL**: Stop protection mechanism is broken.
- System may fail to close positions at stop loss
- Do not deploy until fixed

### ❌ Worst-Case Test Failing
System may not respond correctly to violent price moves.
- Review: is system attempting to close positions?
- Check: are poll-based fallbacks working?

### ❌ Regression Test Failing
A previously fixed bug has reappeared.
- Identify which bug (test name indicates which)
- Review recent changes that may have reintroduced it
- Fix before deploying

### ❌ Isolation Test Failing
Changes to one strategy may be affecting others.
- Review recent changes to shared ladder logic
- Check if config changes propagated incorrectly
- Test each strategy independently

## Adding New Tests

When adding new stop-loss features:

1. Add config test in `01-config-drift.test.js`
2. Add calculation test in `02-stop-placement.test.js`
3. Add integration test in `03-protection-chain.test.js`
4. Add edge case in `04-worst-case-scenarios.test.js`
5. Document any bugs in `05-regression-suite.test.js`
6. Test isolation in `06-cross-strategy-isolation.test.js`

## Test Philosophy

### What We Test
- ✅ Configuration values don't drift
- ✅ Calculations are correct
- ✅ System responds to stop conditions
- ✅ Fallbacks activate when needed
- ✅ Bugs don't reappear
- ✅ Strategies are isolated

### What We Don't Test
- ❌ Exact fill prices (market-dependent)
- ❌ Zero slippage (impossible in real markets)
- ❌ Broker API availability (external dependency)
- ❌ Network latency (environmental)

### Key Principle
> **Test system behavior, not market outcomes.**
> 
> The system can't control fill prices, but it can control whether it ATTEMPTS to close positions at the right time with the right logic.

## Maintenance

### Updating Stop Values
If stop-loss percentages change:

1. Update the strategy config file (e.g., `orbConfig.js`)
2. Update the test expectations in `01-config-drift.test.js`
3. Update this README's table
4. Document why the change was made
5. Re-run full test suite

### Test Dependencies
- Node.js built-in test runner (no external dependencies)
- ES modules (type: "module" in package.json)
- Node 18+ required for `node:test` and `node:crypto`

## Performance

Tests run in **< 2 seconds** on modern hardware.
- No external API calls
- No database dependencies
- Pure logic testing
- Suitable for CI/CD pipelines

## Questions?

If tests fail and you're not sure why:
1. Read the test failure message (they're designed to be clear)
2. Check recent code changes
3. Review this README
4. Run tests locally with `npm run test:stop-loss`
5. Check if config values match expectations

## Critical Reminder

**These tests protect real capital.**

Three strategies (ORB, Premarket, EMA/VWAP) trade live. A failed test is not a nuisance - it's a warning that stop-loss protection may be compromised.

Never disable or skip these tests without thorough review and approval.
