import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLiveSharedRemaining,
  computeLiveBudgetMax,
  computeLivePerStrategyBudget,
  applyLivePerTradeCap,
  resolveLiveSizingBudget,
  updateLiveBudgetCache,
  clearLiveBudgetCache,
  getLiveBudgetCacheMeta,
  LIVE_PER_TRADE_CAP_FRAC,
  livePerTradeCapFracFor,
} from './liveBudget.js';
import { ladderPositionSize } from '../ladder/ladderSizing.js';

describe('cross-strategy live FCFS shared pool', () => {
  it('subtracts deployed cost from ANY live strategy, not only the requester', () => {
    const liveStrategies = ['orb', 'premarket'];
    const cash = 140;
    const deployedByStrategy = { premarket: 40, orb: 0 };

    const orbRemaining = resolveLiveSizingBudget({
      cashBalance: cash,
      deployedByStrategy,
      liveStrategies,
      requestingStrategy: 'orb',
      perTradeCapFrac: livePerTradeCapFracFor('orb'),
    });
    const premarketRemaining = resolveLiveSizingBudget({
      cashBalance: cash,
      deployedByStrategy,
      liveStrategies,
      requestingStrategy: 'premarket',
      perTradeCapFrac: livePerTradeCapFracFor('premarket'),
    });
    const emaRemaining = resolveLiveSizingBudget({
      cashBalance: cash,
      deployedByStrategy: { ...deployedByStrategy, emavwap: 0 },
      liveStrategies: ['orb', 'premarket', 'emavwap'],
      requestingStrategy: 'emavwap',
      perTradeCapFrac: livePerTradeCapFracFor('emavwap'),
    });

    // Shared remaining = 140 - 40 = 100; account-wide 80% per-trade cap → 80.
    assert.equal(computeLiveSharedRemaining(cash, 40), 100);
    assert.equal(LIVE_PER_TRADE_CAP_FRAC, 0.8);
    assert.equal(livePerTradeCapFracFor('orb'), 0.8);
    assert.equal(livePerTradeCapFracFor('premarket'), 0.8);
    assert.equal(livePerTradeCapFracFor('emavwap'), 0.8);
    assert.equal(orbRemaining, 80);
    assert.equal(premarketRemaining, 80);
    assert.equal(emaRemaining, 80);
    assert.notEqual(orbRemaining, 50);
    assert.notEqual(orbRemaining, 140);
  });

  it('clamps a large signal via per-trade cap before ladder sizing', () => {
    const sharedRemaining = 140;
    const capped = applyLivePerTradeCap(sharedRemaining);
    assert.equal(LIVE_PER_TRADE_CAP_FRAC, 0.8);
    assert.equal(capped, 112);

    const bigCash = 10_000;
    const sizingBudget = resolveLiveSizingBudget({
      cashBalance: bigCash,
      deployedByStrategy: { orb: 0, premarket: 0 },
      liveStrategies: ['orb', 'premarket'],
      requestingStrategy: 'orb',
      perTradeCapFrac: livePerTradeCapFracFor('orb'),
    });
    // 80% of 10000 = 8000 — not the full shared pool
    assert.equal(sizingBudget, 8000);
    assert.ok(sizingBudget < bigCash);

    const premium = 1.0; // $100/contract
    const sizing = ladderPositionSize(sizingBudget, premium);
    assert.equal(sizing.affordable, true);
    assert.ok(sizing.totalCost <= sizingBudget);
    assert.ok(sizingBudget === applyLivePerTradeCap(bigCash, livePerTradeCapFracFor('orb')));
  });

  it('returns 0 for a paper/non-live requesting strategy', () => {
    const budget = resolveLiveSizingBudget({
      cashBalance: 140,
      deployedByStrategy: { orb: 0, premarket: 0 },
      liveStrategies: ['orb', 'premarket'],
      requestingStrategy: 'swing',
    });
    assert.equal(budget, 0);
  });

  it('caches full shared cash (no equal split) in updateLiveBudgetCache', () => {
    clearLiveBudgetCache();
    updateLiveBudgetCache({
      cashBalance: 140.524,
      liveStrategies: ['orb', 'premarket'],
    });
    const meta = getLiveBudgetCacheMeta();
    assert.equal(meta.cashBalance, 140.524);
    assert.equal(meta.liveCount, 2);
    assert.equal(meta.liveStrategies.length, 2);
  });

  it('live max is 70% of capital for every live strategy, not a 50/50 split', () => {
    const cash = 200;
    assert.equal(computeLiveBudgetMax(cash), 140);
    assert.equal(computeLivePerStrategyBudget(cash, 2), 140);
    assert.equal(computeLivePerStrategyBudget(cash, 1), 140);
    assert.notEqual(computeLivePerStrategyBudget(cash, 2), cash / 2);

    clearLiveBudgetCache();
    const cached = updateLiveBudgetCache({
      cashBalance: cash,
      liveStrategies: ['premarket', 'emavwap'],
    });
    assert.equal(cached.perStrategyBudget.premarket, 140);
    assert.equal(cached.perStrategyBudget.emavwap, 140);
  });
});

describe('paper path remains allocation-based (pure invariant)', () => {
  it('does not use live shared remaining helpers for paper totals', () => {
    const paperLike = resolveLiveSizingBudget({
      cashBalance: 140,
      deployedByStrategy: { swing: 0 },
      liveStrategies: [],
      requestingStrategy: 'swing',
    });
    assert.equal(paperLike, 0);
  });
});
