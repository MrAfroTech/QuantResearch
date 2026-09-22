import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OTO_COMPLEX_TYPE,
  buildOtoEntryStopBody,
  parsePlacedComplexOrder,
} from './otoEntryStop.js';

describe('buildOtoEntryStopBody', () => {
  it('builds an OTO trigger BTO + Day stop_market STC for a single-leg option', () => {
    const body = buildOtoEntryStopBody({
      optionSymbol: 'IWM   260821P00299000',
      quantity: 1,
      entryPrice: 0.81,
      stopTrigger: 0.79,
      stopOrderType: 'stop_market',
    });
    assert.equal(body.type, OTO_COMPLEX_TYPE);
    assert.equal(body['trigger-order']['order-type'], 'Limit');
    assert.equal(body['trigger-order']['time-in-force'], 'Day');
    assert.equal(body['trigger-order']['price-effect'], 'Debit');
    assert.equal(body['trigger-order'].legs[0].action, 'Buy to Open');
    assert.equal(body.orders.length, 1);
    assert.equal(body.orders[0]['order-type'], 'Stop');
    // Tastytrade forbids GTC on Stop Market equity options (tif_no_stop_market_gtc_options).
    assert.equal(body.orders[0]['time-in-force'], 'Day');
    assert.equal(body.orders[0]['stop-trigger'], '0.79');
    assert.equal(body.orders[0].legs[0].action, 'Sell to Close');
    assert.equal(body.orders[0].price, undefined);
  });

  it('keeps GTC on Stop Limit OTO children', () => {
    const body = buildOtoEntryStopBody({
      optionSymbol: 'SPY   260831P00765000',
      quantity: 1,
      entryPrice: 0.5,
      stopTrigger: 0.49,
      stopOrderType: 'stop_limit',
      stopLimitPrice: 0.47,
    });
    assert.equal(body.orders[0]['order-type'], 'Stop Limit');
    assert.equal(body.orders[0]['time-in-force'], 'GTC');
  });

  it('does not attach a take-profit child (ladder owns profit exits)', () => {
    const body = buildOtoEntryStopBody({
      optionSymbol: 'QQQ   260821P00709000',
      quantity: 1,
      entryPrice: 1.2,
      stopTrigger: 1.17,
      stopOrderType: 'stop_market',
    });
    assert.equal(body.orders.length, 1);
    assert.ok(body.orders.every((o) => String(o['order-type']).startsWith('Stop')));
  });
});

describe('parsePlacedComplexOrder', () => {
  it('reads kebab-case Tastytrade complex-order ids', () => {
    const parsed = parsePlacedComplexOrder({
      data: {
        'complex-order': {
          id: 9001,
          type: 'OTO',
          'trigger-order': { id: 498097304, 'order-type': 'Limit' },
          orders: [{ id: 498097919, 'order-type': 'Stop', 'stop-trigger': '0.79' }],
        },
      },
    });
    assert.equal(parsed.complexOrderId, '9001');
    assert.equal(parsed.triggerOrderId, '498097304');
    assert.equal(parsed.stopOrderId, '498097919');
  });

  it('picks the stop child when extra orders are present', () => {
    const parsed = parsePlacedComplexOrder({
      data: {
        complex_order: {
          id: 2,
          trigger_order: { id: 10 },
          orders: [
            { id: 11, 'order-type': 'Limit' },
            { id: 12, 'order-type': 'Stop' },
          ],
        },
      },
    });
    assert.equal(parsed.stopOrderId, '12');
    assert.equal(parsed.triggerOrderId, '10');
  });
});
