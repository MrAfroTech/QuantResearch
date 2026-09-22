import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { persistUnderlyingBarsSafe } from './persistUnderlyingBars.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('persistUnderlyingBarsSafe', () => {
  it('upserts fetched bars and does not throw', async () => {
    const calls = [];
    const result = await persistUnderlyingBarsSafe(
      'QQQ',
      [{ time: '2026-09-15T10:15:00', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
      {
        source: 'orb-scan',
        upsertImpl: async (ticker, bars, options) => {
          calls.push({ ticker, bars, options });
          return { attempted: 1, upserted: 1 };
        },
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.upserted, 1);
    assert.equal(calls[0].ticker, 'QQQ');
    assert.equal(calls[0].options.source, 'orb-scan');
  });

  it('logs and returns ok=false when upsert fails', async () => {
    const result = await persistUnderlyingBarsSafe('SPY', [{ time: 't' }], {
      upsertImpl: async () => {
        throw new Error('db down');
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /db down/);
  });

  it('dedupes on (ticker, timeframe, bar_time) in the shared upsert SQL', () => {
    const src = readFileSync(join(here, 'underlyingBarsDb.js'), 'utf8');
    assert.match(src, /PRIMARY KEY \(ticker, timeframe, bar_time\)/);
    assert.match(src, /ON CONFLICT \(ticker, timeframe, bar_time\) DO UPDATE SET/);
  });

  it('skips CREATE INDEX when underlying_bars already exists', () => {
    const src = readFileSync(join(here, 'underlyingBarsDb.js'), 'utf8');
    const probe = src.indexOf("table_name = 'underlying_bars'");
    const createIdx = src.indexOf('CREATE INDEX IF NOT EXISTS');
    assert.ok(probe > 0, 'must probe for existing table');
    assert.ok(createIdx > probe, 'DDL only after existence probe');
    assert.match(src, /if \(existing\.length > 0\) return/);
  });
});
