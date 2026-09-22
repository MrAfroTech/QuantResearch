import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { premarketCloseUpdateClaimed } from './premarketDb.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcFile = readFileSync(join(here, 'premarketDb.js'), 'utf8');

function closePremarketPositionSource() {
  const start = srcFile.indexOf('export async function closePremarketPosition');
  assert.ok(start >= 0, 'closePremarketPosition must exist');
  const next = srcFile.indexOf('\nexport async function', start + 1);
  return srcFile.slice(start, next === -1 ? undefined : next);
}

function closeOnce(store, { reason, exitPremium }) {
  if (store.status === 'CLOSED') return { inserted: false, reason: 'already_closed' };
  const updated = store.status === 'OPEN' ? { count: 1, length: 1 } : { count: 0, length: 0 };
  if (!premarketCloseUpdateClaimed(updated)) return { inserted: false, reason: 'update_missed' };
  store.status = 'CLOSED';
  store.logs.push({ reason, exitPremium });
  return { inserted: true, reason };
}

describe('closePremarketPosition idempotent trade-log write', () => {
  it('claims only when UPDATE affected a row (count or RETURNING)', () => {
    assert.equal(premarketCloseUpdateClaimed({ count: 1, length: 1 }), true);
    assert.equal(premarketCloseUpdateClaimed({ count: 0, length: 0 }), false);
    assert.equal(premarketCloseUpdateClaimed([]), false);
    assert.equal(premarketCloseUpdateClaimed([{ id: 82 }]), true);
  });

  it('second close on an already-CLOSED position is a no-op (no second log)', () => {
    const store = { status: 'OPEN', logs: [] };

    const first = closeOnce(store, { reason: 'broker_already_flat', exitPremium: 1.72 });
    assert.equal(first.inserted, true);
    assert.equal(store.status, 'CLOSED');
    assert.equal(store.logs.length, 1);

    const second = closeOnce(store, { reason: 'broker_already_flat', exitPremium: 1.72 });
    assert.equal(second.inserted, false);
    assert.equal(second.reason, 'already_closed');
    assert.equal(store.logs.length, 1);
    assert.deepEqual(store.logs, [{ reason: 'broker_already_flat', exitPremium: 1.72 }]);
  });

  it('concurrent OPEN readers: only the first successful UPDATE inserts a log', () => {
    const store = { status: 'OPEN', logs: [] };
    const a = closeOnce(store, { reason: 'broker_already_flat', exitPremium: 1.72 });
    const b = closeOnce(store, { reason: 'hard_stop', exitPremium: 1.72 });
    assert.equal(a.inserted, true);
    assert.equal(b.inserted, false);
    assert.equal(store.logs.length, 1);
    assert.equal(store.logs[0].reason, 'broker_already_flat');
  });

  it('gates the insert on UPDATE … AND status = OPEN for every close reason', () => {
    const src = closePremarketPositionSource();
    assert.match(src, /AND status = 'OPEN'/);
    assert.match(src, /RETURNING id/);
    assert.match(src, /premarketCloseUpdateClaimed\(updated\)/);
    assert.match(src, /if \(String\(position\.status \|\| ''\)\.toUpperCase\(\) === 'CLOSED'\) return null;/);
    assert.match(src, /insertPremarketTradeLogLeg/);
    assert.doesNotMatch(
      src,
      /UPDATE premarket_positions\s+SET status = 'CLOSED'\s+WHERE id = \$\{id\}`/
    );
  });
});
