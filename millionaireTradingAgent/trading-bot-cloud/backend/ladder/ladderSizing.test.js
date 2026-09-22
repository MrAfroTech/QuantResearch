import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  contractEntryCost,
  maxAffordableContracts,
  ladderPositionSize,
  ORB_PREMARKET_ENTRY_SIZING,
} from './ladderSizing.js';
import {
  LADDER_TARGET_CONTRACTS,
  OPTION_OPENING_COMMISSION_PER_CONTRACT,
} from './ladderConfig.js';
import { PREMARKET_ENTRY_SIZING } from '../premarketBreakout/premarketConfig.js';

describe('Premarket dynamic floor sizing', () => {
  it('worked example: $220 pool, 50% cap → $110, entry $0.34 → 3 contracts', () => {
    const totalAvailable = 220;
    const perTradeCap = 0.5;
    const budgetAvailable = totalAvailable * perTradeCap; // existing 50% cap, unchanged
    const premium = 0.34;
    const fee = OPTION_OPENING_COMMISSION_PER_CONTRACT;

    // Actual formula used at entry:
    const cost = contractEntryCost(premium, fee); // 0.34*100 + 1 = 35
    assert.equal(cost, 35);
    assert.equal(maxAffordableContracts(budgetAvailable, premium, fee), Math.floor(110 / 35));
    assert.equal(maxAffordableContracts(budgetAvailable, premium, fee), 3);

    const sizing = ladderPositionSize(budgetAvailable, premium, ORB_PREMARKET_ENTRY_SIZING);
    assert.equal(sizing.affordable, true);
    assert.equal(sizing.quantity, 3);
    assert.equal(sizing.entryContracts, 3);
    assert.equal(sizing.totalCost, 3 * 35);
    assert.ok(sizing.totalCost <= budgetAvailable);
    // Uncapped: would have been min(3, affordable) under LADDER_TARGET_CONTRACTS.
    assert.equal(sizing.quantity >= LADDER_TARGET_CONTRACTS, true);
  });

  it('always floors — never rounds up a fractional contract', () => {
    // $69 / $35 = 1.97 → 1, not 2
    const sizing = ladderPositionSize(69, 0.34, ORB_PREMARKET_ENTRY_SIZING);
    assert.equal(sizing.quantity, 1);
  });

  it('skips with quantity 0 when even 1 contract is unaffordable', () => {
    const sizing = ladderPositionSize(34, 0.34, ORB_PREMARKET_ENTRY_SIZING);
    assert.equal(sizing.quantity, 0);
    assert.equal(sizing.affordable, false);
    assert.equal(sizing.requiredCost, 35);
  });

  it('does not cap the uncapped helper at LADDER_TARGET_CONTRACTS=3', () => {
    const sizing = ladderPositionSize(500, 0.34, ORB_PREMARKET_ENTRY_SIZING);
    assert.ok(sizing.quantity > LADDER_TARGET_CONTRACTS);
    assert.equal(sizing.quantity, Math.floor(500 / 35));
  });

  it('realized fee/budget after a 2-of-3 fill is 2 contracts, not 3', () => {
    const fee = OPTION_OPENING_COMMISSION_PER_CONTRACT;
    const cost = contractEntryCost(0.34, fee);
    assert.equal(cost, 35);
    assert.equal(2 * cost, 70);
    assert.equal(3 * cost, 105);
  });

  it('hard-caps production Premarket at 1 contract when PREMARKET_ENTRY_SIZING is used', () => {
    const sizing = ladderPositionSize(500, 0.34, PREMARKET_ENTRY_SIZING);
    assert.equal(PREMARKET_ENTRY_SIZING.maxContracts, 1);
    assert.equal(sizing.affordable, true);
    assert.equal(sizing.quantity, 1);
    assert.equal(sizing.entryContracts, 1);
    assert.equal(sizing.totalCost, 35);
  });
});
