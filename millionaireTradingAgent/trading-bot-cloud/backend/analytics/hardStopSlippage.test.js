import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatHardStopSlippageLabel,
  isBrokerRestingStopFill,
  matchHardStopSlippage,
  normalizeHardStopSlippageEvent,
  resolveDisplayHardStopSlippage,
} from './hardStopSlippage.js';

describe('normalizeHardStopSlippageEvent', () => {
  it('parses QQQ −$4 slip shape', () => {
    const slip = normalizeHardStopSlippageEvent({
      strategy: 'orb',
      ticker: 'QQQ',
      created_at: '2026-08-25T16:01:06Z',
      details_json: JSON.stringify({
        type: 'hard_stop_slippage',
        position_id: 80,
        entry_premium: 0.775,
        trigger_price: 0.76,
        fill_price: 0.72,
        quantity: 1,
        slippage_pct_of_entry: -0.05161290322580649,
        slippage_dollars: -4,
      }),
    });
    assert.equal(slip.trigger_price, 0.76);
    assert.equal(slip.fill_price, 0.72);
    assert.equal(slip.slippage_dollars, -4);
    assert.equal(slip.position_id, 80);
    assert.equal(slip.limit_price_present, false);
  });

  it('marks explicit null limit_price as present (broker-stop fingerprint)', () => {
    const slip = normalizeHardStopSlippageEvent({
      strategy: 'orb',
      ticker: 'SPY',
      details_json: JSON.stringify({
        type: 'hard_stop_slippage',
        position_id: 86,
        entry_premium: 1.255,
        trigger_price: 1.23,
        limit_price: null,
        fill_price: 1.17,
        quantity: 1,
        slippage_dollars: -6,
        slippage_pct_of_entry: -0.0478,
        escalated: false,
      }),
    });
    assert.equal(slip.limit_price_present, true);
    assert.equal(slip.limit_price, null);
    assert.equal(slip.escalated, false);
    assert.equal(isBrokerRestingStopFill(slip), true);
  });

  it('parses skipped_limit_escalation from gate-removed market path', () => {
    const slip = normalizeHardStopSlippageEvent({
      strategy: 'premarket',
      ticker: 'SPY',
      details_json: JSON.stringify({
        type: 'hard_stop_slippage',
        position_id: 74,
        entry_premium: 1.13,
        trigger_price: 1.11,
        limit_price: null,
        fill_price: 1,
        quantity: 1,
        slippage_dollars: -11,
        slippage_pct_of_entry: -0.0973,
        escalated: true,
        skipped_limit_escalation: true,
      }),
    });
    assert.equal(slip.escalated, true);
    assert.equal(slip.skipped_limit_escalation, true);
  });
});

describe('matchHardStopSlippage', () => {
  const slip = {
    strategy: 'orb',
    ticker: 'QQQ',
    created_at: '2026-08-25T16:01:06Z',
    entry_premium: 0.775,
    trigger_price: 0.76,
    fill_price: 0.72,
    slippage_dollars: -4,
    slippage_pct_of_entry: -0.0516,
  };

  it('matches Aug-25 QQQ trade_log row to position_id event', () => {
    const trade = {
      strategy: 'orb',
      ticker: 'QQQ',
      close_reason: 'hard_stop',
      entry_premium: 0.775,
      exit_premium: 0.72,
      closed_at: '2026-08-25T16:01:05.551Z',
    };
    assert.equal(matchHardStopSlippage(trade, slip), true);
  });

  it('rejects non-hard_stop closes', () => {
    assert.equal(
      matchHardStopSlippage(
        {
          strategy: 'orb',
          ticker: 'QQQ',
          close_reason: 'stop_loss',
          entry_premium: 0.775,
          exit_premium: 0.72,
          closed_at: '2026-08-25T16:01:05.551Z',
        },
        slip
      ),
      false
    );
  });
});

describe('resolveDisplayHardStopSlippage', () => {
  it('rebases trade-90 broker-stop fill onto the 1% resting trigger', () => {
    const display = resolveDisplayHardStopSlippage({
      strategy: 'orb',
      entry_premium: 1.255,
      trigger_price: 1.23,
      fill_price: 1.17,
      quantity: 1,
      slippage_dollars: -6,
      slippage_pct_of_entry: -0.0478,
      escalated: false,
      limit_price: null,
      limit_price_present: true,
    });
    assert.equal(display.trigger_price, 1.24);
    assert.equal(display.slippage_dollars, -7);
    assert.ok(Math.abs(display.slippage_pct_of_entry - -0.07 / 1.255) < 1e-12);
  });

  it('rebases EMA/VWAP broker-stop fills onto the 1.75% resting trigger', () => {
    const display = resolveDisplayHardStopSlippage({
      strategy: 'emavwap',
      entry_premium: 0.4,
      trigger_price: 0.39,
      fill_price: 0.38,
      quantity: 1,
      slippage_dollars: -1,
      slippage_pct_of_entry: -0.025,
      escalated: false,
      limit_price: null,
      limit_price_present: true,
    });
    // 0.40 * (1 - 0.0175) = 0.393 → $0.39
    assert.equal(display.trigger_price, 0.39);
    assert.equal(display.slippage_dollars, -1);
  });

  it('leaves poll-path market escalation numbers untouched', () => {
    const slip = {
      strategy: 'orb',
      entry_premium: 0.715,
      trigger_price: 0.7,
      fill_price: 0.55,
      quantity: 1,
      slippage_dollars: -15,
      slippage_pct_of_entry: -0.2098,
      escalated: true,
      limit_price: 0.69,
      limit_price_present: true,
    };
    assert.equal(resolveDisplayHardStopSlippage(slip), slip);
  });
});

describe('formatHardStopSlippageLabel', () => {
  it('formats slipped fill', () => {
    const label = formatHardStopSlippageLabel({
      trigger_price: 0.76,
      fill_price: 0.72,
      slippage_dollars: -4,
      slippage_pct_of_entry: -0.0516,
    });
    assert.equal(label, '$0.76→$0.72 (−$4.00 / −5.16%)');
  });

  it('tags limit vs market vs broker resting stop', () => {
    assert.equal(
      formatHardStopSlippageLabel({
        trigger_price: 0.76,
        fill_price: 0.75,
        slippage_dollars: -1,
        slippage_pct_of_entry: -0.0129,
        escalated: false,
        limit_price: 0.75,
        limit_price_present: true,
      }),
      '$0.76→$0.75 (−$1.00 / −1.29%) · limit'
    );
    assert.equal(
      formatHardStopSlippageLabel({
        trigger_price: 0.76,
        fill_price: 0.72,
        slippage_dollars: -4,
        slippage_pct_of_entry: -0.0516,
        escalated: true,
        limit_price: 0.75,
        limit_price_present: true,
      }),
      '$0.76→$0.72 (−$4.00 / −5.16%) · market'
    );
    assert.equal(
      formatHardStopSlippageLabel({
        strategy: 'orb',
        entry_premium: 1.255,
        trigger_price: 1.23,
        fill_price: 1.17,
        quantity: 1,
        slippage_dollars: -6,
        slippage_pct_of_entry: -0.0478,
        escalated: false,
        limit_price: null,
        limit_price_present: true,
      }),
      '$1.24→$1.17 (−$7.00 / −5.58%) · broker stop'
    );
  });

  it('keeps legacy events without limit_price tagged as limit', () => {
    assert.equal(
      formatHardStopSlippageLabel({
        trigger_price: 0.76,
        fill_price: 0.72,
        slippage_dollars: -4,
        slippage_pct_of_entry: -0.0516,
        escalated: false,
        limit_price: null,
        limit_price_present: false,
      }),
      '$0.76→$0.72 (−$4.00 / −5.16%) · limit'
    );
  });

  it('formats clean fill at trigger', () => {
    const label = formatHardStopSlippageLabel({
      trigger_price: 0.75,
      fill_price: 0.75,
      slippage_dollars: 0,
      slippage_pct_of_entry: 0,
    });
    assert.equal(label, 'Clean @ $0.75');
  });
});
