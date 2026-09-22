import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ladderPositionSize } from '../ladder/ladderSizing.js';
import {
  EMA_VWAP_STOP_LOSS_PCT,
  EMA_VWAP_HARD_STOP_PCT,
  EMA_VWAP_ENTRY_SIZING,
  EMA_VWAP_MAX_ENTRY_CONTRACTS,
} from './emaVwapConfig.js';
import { ORB_PREMARKET_ENTRY_SIZING } from '../ladder/ladderSizing.js';
import { PREMARKET_ENTRY_SIZING } from '../premarketBreakout/premarketConfig.js';
import { OPTION_OPENING_COMMISSION_PER_CONTRACT } from '../ladder/ladderConfig.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('EMA/VWAP go-live prerequisites', () => {
  it('uses 1.75% soft / 2% hard stops, not the old 6.5%/10% defaults', () => {
    assert.equal(EMA_VWAP_STOP_LOSS_PCT, 0.0175);
    assert.equal(EMA_VWAP_HARD_STOP_PCT, 0.02);
  });

  it('hard-caps EMA/VWAP at 1 contract even when max-affordable would allow more', () => {
    assert.equal(EMA_VWAP_MAX_ENTRY_CONTRACTS, 1);
    assert.equal(EMA_VWAP_ENTRY_SIZING.maxContracts, 1);
    assert.equal(EMA_VWAP_ENTRY_SIZING.feePerContract, OPTION_OPENING_COMMISSION_PER_CONTRACT);
    assert.notDeepEqual(EMA_VWAP_ENTRY_SIZING, ORB_PREMARKET_ENTRY_SIZING);
    const sizing = ladderPositionSize(500, 0.4, EMA_VWAP_ENTRY_SIZING);
    assert.equal(sizing.quantity, 1);
    assert.equal(sizing.affordable, true);
    assert.equal(sizing.totalCost, 41);
    const premarket = ladderPositionSize(500, 0.4, PREMARKET_ENTRY_SIZING);
    assert.equal(premarket.quantity, 1);
    assert.ok(ladderPositionSize(500, 0.4, ORB_PREMARKET_ENTRY_SIZING).quantity > 1);
  });

  it('refuses a 1-contract fill when remaining budget cannot cover premium plus $1 fee', () => {
    // $40 covers $0.40 notional but not $41 with commission — same refuse as ORB/Premarket.
    const sizing = ladderPositionSize(40, 0.4, EMA_VWAP_ENTRY_SIZING);
    assert.equal(sizing.quantity, 0);
    assert.equal(sizing.affordable, false);
    assert.equal(sizing.requiredCost, 41);
  });

  it('enforces $0.85 min entry premium floor (no max band)', () => {
    const cfg = readFileSync(join(here, 'emaVwapConfig.js'), 'utf8');
    const exec = readFileSync(join(here, 'emaVwapExecutor.js'), 'utf8');
    assert.match(cfg, /EMA_VWAP_MIN_ENTRY_PREMIUM\s*=\s*0\.85/);
    assert.doesNotMatch(cfg, /EMA_VWAP_MAX_ENTRY_PREMIUM/);
    assert.doesNotMatch(cfg, /isEmaVwapPremiumOutsideBand/);
    assert.doesNotMatch(exec, /isEmaVwapPremiumOutsideBand/);
    assert.doesNotMatch(exec, /entry_premium_outside_band/);
    assert.match(exec, /isPremiumBelowFloor/);
    assert.doesNotMatch(exec, /applyTrialSizing/);
  });

  it('executor submits OTO, books confirmed fill, and does not two-step placeInitialStop', () => {
    const src = readFileSync(join(here, 'emaVwapExecutor.js'), 'utf8');
    assert.match(src, /initialStop:\s*stopParams/);
    assert.match(src, /buildBrokerStopOrderParams/);
    assert.match(src, /shouldBookConfirmedEntry/);
    assert.match(src, /bookedEntryQuantity/);
    assert.match(src, /maybeSkipUnfilledOpenInsert/);
    assert.match(src, /order\.stopOrderId/);
    assert.match(src, /kickInitialStopUntilProtected/);
    assert.match(src, /EMA_VWAP_ENTRY_SIZING/);
    assert.match(src, /OPTION_OPENING_COMMISSION_PER_CONTRACT/);
    assert.doesNotMatch(src, /isEmaVwapPremiumOutsideBand/);
    assert.doesNotMatch(src, /await brokerStop\.placeInitialStop\(/);
  });

  it('monitor wires flatten-until-closed, cancel-exit, and pending-close persistence', () => {
    const src = readFileSync(join(here, 'emaVwapPositionManager.js'), 'utf8');
    assert.match(src, /flattenBrokerOrder/);
    assert.match(src, /cancelExitOrder/);
    assert.match(src, /getExitOrderStatus/);
    assert.match(src, /updatePendingClose:\s*updateEmaVwapPositionPendingClose/);
    assert.match(src, /getOpenPosition/);
    assert.match(src, /shouldKickInitialStop/);
    assert.match(src, /isFlattenRetryInFlight/);
    assert.match(src, /hardStopPct:\s*EMA_VWAP_HARD_STOP_PCT/);
    assert.match(src, /fullPositionExits:\s*true/);
    assert.match(src, /armEmaVwapPartialLockBeforeLadder/);
    assert.match(src, /tryEmaVwapPartialLockTrailClose/);
    assert.match(src, /logEmaVwapHardStopSlippage/);
  });
});
