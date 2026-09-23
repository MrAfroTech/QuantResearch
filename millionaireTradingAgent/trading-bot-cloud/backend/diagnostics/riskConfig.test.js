import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRiskConfigSnapshot } from './riskConfig.js';
import { LIVE_PER_TRADE_CAP_FRAC, livePerTradeCapFracFor } from '../budget/liveBudget.js';
import {
  ORB_ENTRIES_ENABLED,
  ORB_HARD_STOP_PCT,
  ORB_MAX_ENTRY_CONTRACTS,
  ORB_MIN_ENTRY_PREMIUM,
  ORB_PARTIAL_LOCK_ACTIVATION_MFE,
  ORB_STOP_LOSS_PCT,
} from '../orb/orbConfig.js';
import {
  PREMARKET_HARD_STOP_TRIGGER,
  PREMARKET_MAX_ENTRY_CONTRACTS,
  PREMARKET_MIN_ENTRY_PREMIUM,
  PREMARKET_STOP_LOSS_PCT,
} from '../premarketBreakout/premarketConfig.js';
import {
  EMA_VWAP_HARD_STOP_PCT,
  EMA_VWAP_MAX_ENTRY_CONTRACTS,
  EMA_VWAP_MIN_ENTRY_PREMIUM,
  EMA_VWAP_STOP_LOSS_PCT,
} from '../emaVwapCross/emaVwapConfig.js';

describe('buildRiskConfigSnapshot', () => {
  it('returns the same in-memory bindings the strategy configs export', () => {
    const snap = buildRiskConfigSnapshot();
    assert.equal(snap.source, 'in_memory_module_exports');
    assert.equal(snap.orb_entries_enabled, ORB_ENTRIES_ENABLED);
    assert.equal(snap.account.live_per_trade_cap_frac, LIVE_PER_TRADE_CAP_FRAC);
    assert.equal(snap.strategies.orb.per_trade_cap_frac, livePerTradeCapFracFor('orb'));
    assert.equal(snap.strategies.orb.max_entry_contracts, ORB_MAX_ENTRY_CONTRACTS);
    assert.equal(snap.strategies.orb.premium_floor, ORB_MIN_ENTRY_PREMIUM);
    assert.equal(snap.strategies.orb.soft_stop_pct, ORB_STOP_LOSS_PCT);
    assert.equal(snap.strategies.orb.hard_stop_pct, ORB_HARD_STOP_PCT);
    assert.equal(snap.strategies.orb.partial_lock.activation_mfe, ORB_PARTIAL_LOCK_ACTIVATION_MFE);
    assert.equal(snap.strategies.orb.partial_lock.start_mfe, 0.03);
    assert.equal(snap.strategies.orb.partial_lock.increment_to_100, 0.05);
    assert.equal(snap.strategies.orb.partial_lock.increment_after_100, 0.1);
    assert.equal(snap.strategies.orb.partial_lock.max_mfe, 10);
    assert.equal(snap.strategies.premarket.max_entry_contracts, PREMARKET_MAX_ENTRY_CONTRACTS);
    assert.equal(snap.strategies.premarket.premium_floor, PREMARKET_MIN_ENTRY_PREMIUM);
    assert.equal(snap.strategies.premarket.soft_stop_pct, PREMARKET_STOP_LOSS_PCT);
    assert.equal(snap.strategies.premarket.hard_stop_pct, PREMARKET_HARD_STOP_TRIGGER);
    assert.equal(snap.strategies.emavwap.max_entry_contracts, EMA_VWAP_MAX_ENTRY_CONTRACTS);
    assert.equal(snap.strategies.emavwap.premium_floor, EMA_VWAP_MIN_ENTRY_PREMIUM);
    assert.equal(snap.strategies.emavwap.soft_stop_pct, EMA_VWAP_STOP_LOSS_PCT);
    assert.equal(snap.strategies.emavwap.hard_stop_pct, EMA_VWAP_HARD_STOP_PCT);
    assert.equal(snap.strategies.orb.premium_floor, snap.strategies.premarket.premium_floor);
    assert.equal(snap.orb_entries_enabled, false);
  });
});
