import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, 'brokerageConnector.js'), 'utf8');
const otoSrc = readFileSync(join(__dirname, 'ladder/otoEntryStop.js'), 'utf8');

describe('option stop_market TIF', () => {
  it('uses Day for stop_market and keeps GTC only for stop_limit', () => {
    // Guard the shared tastytradeSubmitStopOrderWithCredentials body builder.
    assert.match(
      src,
      /'time-in-force': isStopLimit \? 'GTC' : 'Day'/
    );
    assert.match(src, /tif_no_stop_market_gtc_options/);
    // Must not unconditionally force GTC on all option stops.
    assert.doesNotMatch(
      src,
      /'order-type': isStopLimit \? 'Stop Limit' : 'Stop',\s*'time-in-force': 'GTC'/
    );
  });

  it('OTO child stop uses the same Day-for-stop_market TIF rule', () => {
    assert.match(
      otoSrc,
      /'time-in-force': isStopLimit \? 'GTC' : 'Day'/
    );
    assert.match(otoSrc, /tif_no_stop_market_gtc_options/);
    assert.doesNotMatch(
      otoSrc,
      /'order-type': isStopLimit \? 'Stop Limit' : 'Stop',\s*'time-in-force': 'GTC'/
    );
  });

  it('partial-lock replaceStop uses PUT replace then the same TIF-fixed submitOptionStopOrder', () => {
    const stopOrders = readFileSync(join(__dirname, 'ladder/ladderStopOrders.js'), 'utf8');
    assert.match(stopOrders, /replaceOptionStopOrder/);
    assert.match(stopOrders, /submitOptionStopOrder/);
    assert.match(
      stopOrders,
      /async replaceStop\(position, stopPnlFrac\) \{\s*return replaceLadderBrokerStop/
    );
    assert.match(stopOrders, /const placed = await placeStop\(position,/);
    assert.match(stopOrders, /const result = await submitOptionStopOrder\(position,/);
    assert.match(src, /includeLegs: false/);
    assert.match(src, /method: 'PUT'/);
  });
});
