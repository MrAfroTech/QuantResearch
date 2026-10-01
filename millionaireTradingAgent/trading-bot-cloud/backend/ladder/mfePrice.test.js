import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optionQuoteFields } from '../tradierClient.js';
import { computeStopTriggerPrice } from './ladderConfig.js';
import {
  MFE_QUOTE_STALE_AFTER_MS,
  clearMfeFailure,
  planExcursionUpdate,
  selectMfePrice,
  takeMfeFailureEvent,
} from './mfePrice.js';
import { trailFloorFromPeak } from './partialLockTrailRungs.js';
import { PREMARKET_HARD_STOP_TRIGGER, PREMARKET_STOP_LOSS_PCT } from '../premarketBreakout/premarketConfig.js';
import { ORB_HARD_STOP_PCT, ORB_STOP_LOSS_PCT } from '../orb/orbConfig.js';
import { EMA_VWAP_HARD_STOP_PCT, EMA_VWAP_STOP_LOSS_PCT } from '../emaVwapCross/emaVwapConfig.js';

const here = dirname(fileURLToPath(import.meta.url));
const BID_AT = 1_700_000_000_000;
const POLL = MFE_QUOTE_STALE_AFTER_MS;

function position120Quote({ last, bidDate, askDate, tradeDate }) {
  return {
    bid: 1.02,
    ask: 1.05,
    last,
    bidDate,
    askDate,
    tradeDate,
  };
}

describe('Tradier option quote fields', () => {
  it('keeps last and quote timestamps that normalizeOption used to drop', () => {
    const fields = optionQuoteFields({
      bid: 1.02,
      ask: 1.05,
      last: 1.4,
      bid_date: BID_AT,
      ask_date: BID_AT,
      trade_date: BID_AT + 60_000,
    });
    assert.equal(fields.last, 1.4);
    assert.equal(fields.bid, 1.02);
    assert.equal(fields.ask, 1.05);
    assert.ok(Math.abs(fields.mid - 1.035) < 1e-12);
    assert.equal(fields.bid_date, BID_AT);
    assert.equal(fields.ask_date, BID_AT);
    assert.equal(fields.trade_date, BID_AT + 60_000);
  });
});

describe('selectMfePrice', () => {
  it('uses a newer last when both bid and ask lag the sale by more than one poll', () => {
    const selected = selectMfePrice(position120Quote({
      last: 1.4,
      bidDate: BID_AT,
      askDate: BID_AT,
      tradeDate: BID_AT + POLL + 1,
    }));
    assert.equal(selected.reason, 'stale_quote_newer_last');
    assert.equal(selected.freshness, 'stale');
    assert.ok(Math.abs(selected.mid - 1.035) < 1e-12);
    assert.equal(selected.selectedPrice, 1.4);
    assert.ok(selected.selectedPrice > selected.mid);
  });

  it('does not let a higher last replace a bid while the quote is still current', () => {
    const selected = selectMfePrice(position120Quote({
      last: 1.4,
      bidDate: BID_AT,
      askDate: BID_AT,
      tradeDate: BID_AT + POLL,
    }));
    assert.equal(selected.reason, 'executable_bid');
    assert.equal(selected.freshness, 'fresh');
    assert.equal(selected.selectedPrice, 1.02);
  });

  it('keeps an unchanged bid when the ask is still updating', () => {
    const selected = selectMfePrice(position120Quote({
      last: 1.4,
      bidDate: BID_AT,
      askDate: BID_AT + 120_000,
      tradeDate: BID_AT + 120_000,
    }));
    assert.equal(selected.reason, 'executable_bid');
    assert.equal(selected.freshness, 'bid_unchanged');
    assert.equal(selected.selectedPrice, 1.02);
  });

  it('ignores an older last that is above the current bid', () => {
    const selected = selectMfePrice({
      bid: 59.88,
      ask: 60.11,
      last: 63.73,
      bidDate: BID_AT,
      askDate: BID_AT,
      tradeDate: BID_AT - 91_553_521,
    });
    assert.equal(selected.selectedPrice, 59.88);
    assert.equal(selected.reason, 'executable_bid');
  });

  it('does not invent a timeout when timestamps are missing', () => {
    const selected = selectMfePrice({ bid: 1.02, ask: 1.05, last: 1.4 });
    assert.equal(selected.reason, 'freshness_unknown_bid');
    assert.equal(selected.freshness, 'unknown');
    assert.equal(selected.selectedPrice, 1.02);
  });

  it('does not select the ask', () => {
    const selected = selectMfePrice({ ask: 1.4, last: null, bid: 0 });
    assert.equal(selected.selectedPrice, null);
    assert.notEqual(selected.selectedPrice, 1.4);
  });

  it('ties the stale gap to the 10-second monitor poll', () => {
    const scheduler = readFileSync(join(here, '../scheduler.js'), 'utf8');
    assert.match(scheduler, /ZERO_DTE_POSITION_MONITOR_CRON[\s\S]*'\*\/10 \* \* \* \* 1-5'/);
    assert.equal(MFE_QUOTE_STALE_AFTER_MS, 10_000);
  });
});

describe('MFE advance from the selected price', () => {
  const entry = 0.99;
  const stored = {
    entry_premium: entry,
    mfe_pct: 0.0454545454545456,
    mae_pct: 0,
    broker_stop_trigger_price: 0.79,
  };

  it('lets a stale-quote last above the midpoint advance MFE through +18%', () => {
    const selection = selectMfePrice(position120Quote({
      last: 1.4,
      bidDate: BID_AT,
      askDate: BID_AT,
      tradeDate: BID_AT + 60_000,
    }));
    const planned = planExcursionUpdate(stored, {
      ratchetPremium: selection.selectedPrice,
      markPremium: selection.mid,
      selection,
      observedAt: '2026-09-29T16:45:00.000Z',
    });
    assert.equal(selection.selectedPrice, 1.4);
    assert.ok(planned.mfeFrac > stored.mfe_pct);
    assert.ok(Math.abs(planned.mfeFrac - (1.4 - entry) / entry) < 1e-12);
    assert.equal(planned.floor, 0.275);
    assert.equal(trailFloorFromPeak(0.18), 0.135);
    const at18 = planExcursionUpdate(
      { ...stored, mfe_pct: 0 },
      {
        ratchetPremium: entry * 1.18,
        markPremium: selection.mid,
        selection: { ...selection, selectedPrice: entry * 1.18 },
      }
    );
    assert.equal(at18.floor, 0.135);
    assert.deepEqual(
      [0.135, 0.275].filter((rung) => rung <= at18.floor + 1e-12),
      [0.135]
    );
    assert.equal(planned.advanceEvent.type, 'mfe_advance');
    assert.equal(planned.advanceEvent.selected_mfe_price, 1.4);
    assert.equal(planned.advanceEvent.bid, 1.02);
    assert.equal(planned.advanceEvent.ask, 1.05);
    assert.ok(Math.abs(planned.advanceEvent.midpoint - 1.035) < 1e-12);
    assert.equal(planned.advanceEvent.last, 1.4);
    assert.equal(planned.advanceEvent.observed_at, '2026-09-29T16:45:00.000Z');
    assert.equal(planned.advanceEvent.mfe_pct, planned.mfeFrac);
    assert.equal(planned.advanceEvent.ratchet_floor, 0.275);
    assert.equal(planned.advanceEvent.broker_stop_trigger, computeStopTriggerPrice(entry, 0.275));
  });

  it('does not decrease MFE when a later observation is lower', () => {
    const high = planExcursionUpdate(stored, {
      ratchetPremium: 1.4,
      markPremium: 1.035,
      selection: selectMfePrice(position120Quote({
        last: 1.4,
        bidDate: BID_AT,
        askDate: BID_AT,
        tradeDate: BID_AT + 60_000,
      })),
    });
    const lower = planExcursionUpdate(
      { ...stored, mfe_pct: high.mfeFrac },
      {
        ratchetPremium: 1.02,
        markPremium: 1.035,
        selection: selectMfePrice(position120Quote({
          last: 1.02,
          bidDate: BID_AT + 120_000,
          askDate: BID_AT + 120_000,
          tradeDate: BID_AT + 120_000,
        })),
      }
    );
    assert.equal(lower.mfeFrac, high.mfeFrac);
    assert.equal(lower.mfeAdvanced, false);
    assert.equal(lower.advanceEvent, null);
    assert.equal(lower.floor, high.floor);
  });

  it('records one failure and suppresses the same failure on the next poll', () => {
    clearMfeFailure(120);
    const first = takeMfeFailureEvent(120, 'quote_fields_unavailable', '2026-09-29T16:45:00.000Z');
    const repeat = takeMfeFailureEvent(120, 'quote_fields_unavailable', '2026-09-29T16:45:10.000Z');
    const changed = takeMfeFailureEvent(120, 'no_mfe_price', '2026-09-29T16:45:20.000Z');
    assert.equal(first.type, 'mfe_observation_failed');
    assert.equal(first.reason, 'quote_fields_unavailable');
    assert.equal(repeat, null);
    assert.equal(changed.reason, 'no_mfe_price');
    clearMfeFailure(120);
  });
});

describe('approved stop distances stay in place', () => {
  it('keeps the 8% initial stop and 13.5% hard stop', () => {
    assert.equal(PREMARKET_STOP_LOSS_PCT, 0.08);
    assert.equal(PREMARKET_HARD_STOP_TRIGGER, 0.135);
    assert.equal(ORB_STOP_LOSS_PCT, 0.08);
    assert.equal(ORB_HARD_STOP_PCT, 0.135);
    assert.equal(EMA_VWAP_STOP_LOSS_PCT, 0.08);
    assert.equal(EMA_VWAP_HARD_STOP_PCT, 0.135);
    assert.equal(computeStopTriggerPrice(0.99, -0.08), 0.91);
    assert.equal(computeStopTriggerPrice(0.99, -0.135), 0.86);
  });
});
