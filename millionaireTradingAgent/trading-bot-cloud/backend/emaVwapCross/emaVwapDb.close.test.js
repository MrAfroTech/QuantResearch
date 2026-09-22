import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emaVwapCloseUpdateClaimed } from './emaVwapDb.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcFile = readFileSync(join(here, 'emaVwapDb.js'), 'utf8');

function closeEmaVwapPositionSource() {
  const start = srcFile.indexOf('export async function closeEmaVwapPosition');
  assert.ok(start >= 0, 'closeEmaVwapPosition must exist');
  const next = srcFile.indexOf('\nexport async function', start + 1);
  return srcFile.slice(start, next === -1 ? undefined : next);
}

function closeOnce(store, { reason, exitPremium }) {
  if (store.status === 'CLOSED') return { inserted: false, reason: 'already_closed' };
  const updated = store.status === 'OPEN' ? { count: 1, length: 1 } : { count: 0, length: 0 };
  if (!emaVwapCloseUpdateClaimed(updated)) return { inserted: false, reason: 'update_missed' };
  store.status = 'CLOSED';
  store.logs.push({ reason, exitPremium });
  return { inserted: true, reason };
}

describe('closeEmaVwapPosition idempotent trade-log write', () => {
  it('claims only when UPDATE affected a row (count or RETURNING)', () => {
    assert.equal(emaVwapCloseUpdateClaimed({ count: 1, length: 1 }), true);
    assert.equal(emaVwapCloseUpdateClaimed({ count: 0, length: 0 }), false);
    assert.equal(emaVwapCloseUpdateClaimed([]), false);
    assert.equal(emaVwapCloseUpdateClaimed([{ id: 63 }]), true);
  });

  it('second close on an already-CLOSED position is a no-op (no second log)', () => {
    const store = { status: 'OPEN', logs: [] };

    const first = closeOnce(store, { reason: 'broker_already_flat', exitPremium: 1.0 });
    assert.equal(first.inserted, true);
    assert.equal(store.status, 'CLOSED');
    assert.equal(store.logs.length, 1);

    const second = closeOnce(store, { reason: 'broker_already_flat', exitPremium: 1.0 });
    assert.equal(second.inserted, false);
    assert.equal(store.logs.length, 1);
  });

  it('concurrent OPEN readers: only the first successful UPDATE inserts a log', () => {
    const store = { status: 'OPEN', logs: [] };
    const a = closeOnce(store, { reason: 'broker_already_flat', exitPremium: 1.0 });
    const b = closeOnce(store, { reason: 'hard_stop', exitPremium: 1.0 });
    assert.equal(a.inserted, true);
    assert.equal(b.inserted, false);
    assert.equal(store.logs.length, 1);
  });

  it('gates the insert on UPDATE … AND status = OPEN for every close reason', () => {
    const src = closeEmaVwapPositionSource();
    assert.match(src, /AND status = 'OPEN'/);
    assert.match(src, /RETURNING id/);
    assert.match(src, /emaVwapCloseUpdateClaimed\(updated\)/);
    assert.match(src, /if \(String\(position\.status \|\| ''\)\.toUpperCase\(\) === 'CLOSED'\) return null;/);
    assert.match(src, /insertEmaVwapTradeLogLeg/);
    assert.doesNotMatch(
      src,
      /UPDATE emavwap_positions\s+SET status = 'CLOSED'\s+WHERE id = \$\{id\}`/
    );
  });
});
