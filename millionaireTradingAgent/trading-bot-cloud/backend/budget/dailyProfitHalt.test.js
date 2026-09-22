import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DAILY_PROFIT_HALT_THRESHOLD_DOLLARS,
  shouldHaltOnDailyProfit,
} from './dailyProfitHalt.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'dailyProfitHalt.js'), 'utf8');

describe('account-wide daily profit halt', () => {
  it('does not halt on $0, a small green day, or a net loss', () => {
    assert.equal(DAILY_PROFIT_HALT_THRESHOLD_DOLLARS, 100);
    assert.equal(shouldHaltOnDailyProfit(0), false);
    assert.equal(shouldHaltOnDailyProfit(0.01), false);
    assert.equal(shouldHaltOnDailyProfit(11), false);
    assert.equal(shouldHaltOnDailyProfit(50.01), false);
    assert.equal(shouldHaltOnDailyProfit(99.99), false);
    assert.equal(shouldHaltOnDailyProfit(-11), false);
    assert.equal(shouldHaltOnDailyProfit(-11 + 11), false);
    assert.equal(shouldHaltOnDailyProfit(-3 + 14 + -4 + -3 + -4), false);
  });

  it('halts when combined realized P&L reaches $100', () => {
    assert.equal(shouldHaltOnDailyProfit(100), true);
    assert.equal(shouldHaltOnDailyProfit(100.01), true);
    assert.equal(shouldHaltOnDailyProfit(60 + 40), true);
  });

  it('getDailyProfitHalt uses account-wide P&L, not a single strategy', () => {
    assert.match(src, /getAccountRealizedPnlToday/);
    assert.match(src, /shouldHaltOnDailyProfit\(realizedPnlToday\)/);
    const haltFn = src.slice(src.indexOf('export async function getDailyProfitHalt'));
    assert.doesNotMatch(
      haltFn,
      /const realizedPnlToday = await getStrategyRealizedPnlToday\(strategy/
    );
  });
});
