import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  settledCashFromBalances,
  signedPendingCashFromBalances,
  computeTradableCashBalance,
} from './tradableCash.js';

const LIVE_SNAPSHOT = {
  'cash-balance': '121.533',
  'pending-cash': '109.0',
  'pending-cash-effect': 'Credit',
  'cash-available-to-withdraw': '62.57',
  'available-trading-funds': '0.0',
  'net-liquidating-value': '149.955',
  'equity-buying-power': '230.533',
  'derivative-buying-power': '230.533',
};

describe('computeTradableCashBalance', () => {
  it('adds pending-cash Credit to cash-balance (live 2026-08-21 snapshot)', () => {
    assert.equal(settledCashFromBalances(LIVE_SNAPSHOT), 121.533);
    assert.equal(signedPendingCashFromBalances(LIVE_SNAPSHOT), 109);
    assert.equal(computeTradableCashBalance(LIVE_SNAPSHOT), 230.533);
    assert.equal(
      computeTradableCashBalance(LIVE_SNAPSHOT),
      Number(LIVE_SNAPSHOT['equity-buying-power'])
    );
  });

  it('subtracts pending-cash Debit from cash-balance', () => {
    const data = {
      'cash-balance': '121.533',
      'pending-cash': '20',
      'pending-cash-effect': 'Debit',
    };
    assert.equal(computeTradableCashBalance(data), 101.533);
  });

  it('ignores pending-cash when effect is None', () => {
    const data = {
      'cash-balance': '121.533',
      'pending-cash': '0.0',
      'pending-cash-effect': 'None',
    };
    assert.equal(signedPendingCashFromBalances(data), 0);
    assert.equal(computeTradableCashBalance(data), 121.533);
  });

  it('falls back to settled cash when pending fields are absent', () => {
    assert.equal(computeTradableCashBalance({ 'cash-balance': '80' }), 80);
    assert.equal(signedPendingCashFromBalances({ 'cash-balance': '80' }), 0);
  });
});
