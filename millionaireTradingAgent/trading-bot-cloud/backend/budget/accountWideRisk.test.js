import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyTrialSizing } from '../setupTrackRecordGate.js';
import { ORB_MIN_ENTRY_PREMIUM } from '../orb/orbConfig.js';
import { PREMARKET_MIN_ENTRY_PREMIUM } from '../premarketBreakout/premarketConfig.js';
import { EMA_VWAP_MIN_ENTRY_PREMIUM } from '../emaVwapCross/emaVwapConfig.js';
import {
  ORB_PARTIAL_LOCK_TRAIL_DIVISOR,
} from '../orb/orbConfig.js';
import { PREMARKET_PARTIAL_LOCK_TRAIL_DIVISOR } from '../premarketBreakout/premarketConfig.js';
import { EMA_VWAP_PARTIAL_LOCK_TRAIL_DIVISOR } from '../emaVwapCross/emaVwapConfig.js';
import { LIVE_PER_TRADE_CAP_FRAC, livePerTradeCapFracFor } from './liveBudget.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

describe('account-wide live risk extensions', () => {
  it('min premium floors are $0.85 on ORB, Premarket, and EMA/VWAP', () => {
    assert.equal(ORB_MIN_ENTRY_PREMIUM, 0.85);
    assert.equal(PREMARKET_MIN_ENTRY_PREMIUM, 0.85);
    assert.equal(EMA_VWAP_MIN_ENTRY_PREMIUM, 0.85);
  });

  it('partial-lock trail divisor is 1.3 on all three strategies', () => {
    assert.equal(ORB_PARTIAL_LOCK_TRAIL_DIVISOR, 1.3);
    assert.equal(PREMARKET_PARTIAL_LOCK_TRAIL_DIVISOR, 1.3);
    assert.equal(EMA_VWAP_PARTIAL_LOCK_TRAIL_DIVISOR, 1.3);
  });

  it('live per-trade cap is 80% for orb, premarket, and emavwap', () => {
    assert.equal(LIVE_PER_TRADE_CAP_FRAC, 0.8);
    assert.equal(livePerTradeCapFracFor('orb'), 0.8);
    assert.equal(livePerTradeCapFracFor('premarket'), 0.8);
    assert.equal(livePerTradeCapFracFor('emavwap'), 0.8);
  });

  it('applyTrialSizing is a no-op pass-through (no 1-contract force)', () => {
    const sizing = {
      quantity: 5,
      totalCost: 500,
      requiredCost: 100,
      affordable: true,
      entryContracts: 5,
    };
    const out = applyTrialSizing(
      sizing,
      1.0,
      { status: 'trial', detail: 'trial_0_of_3' },
      1000,
      1
    );
    assert.equal(out.quantity, 5);
    assert.equal(out.totalCost, 500);
    assert.equal(out.affordable, true);
    assert.equal(out.trial, undefined);
  });

  it('executors do not call applyTrialSizing', () => {
    for (const rel of [
      'orb/orbExecutor.js',
      'premarketBreakout/premarketExecutor.js',
      'emaVwapCross/emaVwapExecutor.js',
      'tradeExecutor.js',
    ]) {
      const src = readFileSync(join(root, rel), 'utf8');
      assert.doesNotMatch(src, /applyTrialSizing/);
    }
  });
});
