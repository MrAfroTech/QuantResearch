import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyFreshCashToDashboardBudgets } from './budgetAllocations.js';
import { computeLiveBudgetMax } from './liveBudget.js';

function card(overrides) {
  return {
    budget_mode: 'live',
    max: 304.27275,
    total_allocated: 304.27275,
    spent: 0,
    remaining: 304.27275,
    live_account_cash: 405.697,
    live_deployed_by_strategy: { orb: 0, emavwap: 0 },
    ...overrides,
  };
}

describe('dashboard live budget display', () => {
  it('replaces stale live max and remaining with 75% of the fresh Tastytrade cash', () => {
    const cash = 471;
    const budgets = applyFreshCashToDashboardBudgets({
      swing_budget: {
        budget_mode: 'paper',
        max: 2995,
        remaining: 2995,
        spent: 0,
      },
      orb_budget: card({ live_deployed_by_strategy: { orb: 0, emavwap: 50 } }),
      premarket_budget: {
        budget_mode: 'paper',
        max: 11381,
        remaining: 11381,
        spent: 0,
      },
      emavwap_budget: card({ live_deployed_by_strategy: { orb: 0, emavwap: 50 } }),
    }, cash);

    const max = computeLiveBudgetMax(cash);
    assert.equal(max, 353.25);
    assert.equal(budgets.orb_budget.max, max);
    assert.equal(budgets.emavwap_budget.max, max);
    assert.equal(budgets.orb_budget.remaining, max - 50);
    assert.equal(budgets.emavwap_budget.remaining, max - 50);
    assert.equal(budgets.orb_budget.live_account_cash, cash);
    assert.equal(budgets.orb_budget.spent, 0);
    assert.equal(budgets.swing_budget.max, 2995);
    assert.equal(budgets.premarket_budget.max, 11381);
  });

  it('leaves the cached cards in place when the cash read is not a number', () => {
    const original = {
      orb_budget: card(),
      emavwap_budget: card(),
    };
    assert.equal(applyFreshCashToDashboardBudgets(original, Number.NaN), original);
    assert.equal(applyFreshCashToDashboardBudgets(original, undefined), original);
  });
});
