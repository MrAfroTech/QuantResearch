import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  FIND_OPTION_MISS_REASON,
  EXPIRATION_MISMATCH_BLOCKED_REASON,
  expirationFromOccSymbol,
  describeEntryExpirationMatch,
} from './brokerageConnector.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'brokerageConnector.js'), 'utf8');

describe('entry expiration OCC guard', () => {
  it('parses space-padded OCC and streamer symbols', () => {
    assert.equal(expirationFromOccSymbol('IWM   260925P00291000'), '2026-09-25');
    assert.equal(expirationFromOccSymbol('SPY   260901C00650000'), '2026-09-01');
    assert.equal(expirationFromOccSymbol('.IWM260925P291'), '2026-09-25');
    assert.equal(expirationFromOccSymbol('QQQ   260918P00480000'), '2026-09-18');
    assert.equal(expirationFromOccSymbol(''), null);
    assert.equal(expirationFromOccSymbol('SPY'), null);
  });

  it('passes when OCC expiration matches the requested date', () => {
    const check = describeEntryExpirationMatch('2026-09-01', {
      optionSymbol: 'SPY   260901C00650000',
    });
    assert.equal(check.mismatch, false);
    assert.equal(check.requested_expiration, '2026-09-01');
    assert.equal(check.resolved_expiration, '2026-09-01');
    assert.equal(check.reason, null);
  });

  it('fails closed on the 2026-09-01 DTE>=21 mismatch and on unparseable OCC', () => {
    const mismatch = describeEntryExpirationMatch('2026-09-01', {
      optionSymbol: 'IWM   260925P00291000',
    });
    assert.equal(mismatch.mismatch, true);
    assert.equal(mismatch.requested_expiration, '2026-09-01');
    assert.equal(mismatch.resolved_expiration, '2026-09-25');
    assert.equal(mismatch.reason, EXPIRATION_MISMATCH_BLOCKED_REASON);

    const unparseable = describeEntryExpirationMatch('2026-09-01', {
      optionSymbol: 'NOT-AN-OCC',
    });
    assert.equal(unparseable.mismatch, true);
    assert.equal(unparseable.resolved_expiration, null);
  });

  it('placeOptionOrder logs the FindOption miss before fallback and blocks submit on mismatch', () => {
    const placeFn = src.slice(src.indexOf('export async function placeOptionOrder'));
    const missIdx = placeFn.indexOf('FIND_OPTION_MISS_REASON');
    const fallbackIdx = placeFn.indexOf('tastytradeGetOptionChain');
    const guardIdx = placeFn.indexOf('EXPIRATION_MISMATCH_BLOCKED_REASON');
    const otoIdx = placeFn.indexOf('tastytradeSubmitOtoEntryStopWithCredentials');
    const submitIdx = placeFn.indexOf('tastytradeSubmitOrderWithCredentials');
    assert.ok(missIdx > 0 && missIdx < fallbackIdx, 'miss log must run before GetOptionChain fallback');
    assert.ok(guardIdx > fallbackIdx, 'mismatch guard must run after resolution/fallback');
    assert.ok(guardIdx < otoIdx && guardIdx < submitIdx, 'mismatch guard must run before any broker submit');
    assert.match(src, /eventType,\s*FIND_OPTION_MISS_REASON|FIND_OPTION_MISS_REASON,/);
    assert.equal(FIND_OPTION_MISS_REASON, 'find_option_expiration_miss');
    assert.equal(EXPIRATION_MISMATCH_BLOCKED_REASON, 'expiration_mismatch_blocked');
  });

  it('does not add a DTE>=21 chain fallback to the close-with-credentials path', () => {
    const start = src.indexOf('async function tastytradeClosePositionWithCredentials');
    const end = src.indexOf('async function tastytradeListLiveOrdersWithCredentials', start);
    const closeBody = src.slice(start, end);
    assert.ok(closeBody.length > 0);
    assert.doesNotMatch(closeBody, /tastytradeGetOptionChain/);
    assert.match(closeBody, /Close option lookup failed/);
  });
});
