import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOccSymbol,
  classifyBrokerFillLogStatus,
  collectUnloggedBrokerFills,
  compareFillPremium,
  compareOpenBooks,
  occKey,
  RECON_MISMATCH,
} from './positionMatch.js';
import {
  assertReconIsolation,
  getReconRuntimeConfig,
  mutedUnderlyings,
} from './reconConfig.js';

describe('positionMatch', () => {
  it('buildOccSymbol pads root and encodes strike', () => {
    const occ = buildOccSymbol('SPY', '2026-08-21', 'PUT', 709);
    assert.match(occ, /^SPY {3}260821P00709000$/);
  });

  it('flags db orphan and matches books', () => {
    const broker = [
      {
        symbol: buildOccSymbol('SPY', '2026-08-21', 'PUT', 700),
        quantity: 1,
        averageOpenPrice: 1.1,
      },
    ];
    const db = [
      {
        strategy: 'orb',
        id: 1,
        ticker: 'SPY',
        direction: 'PUT',
        strike: 700,
        expiration: '2026-08-21',
        entry_premium: 1.1,
        quantity: 1,
      },
      {
        strategy: 'orb',
        id: 2,
        ticker: 'QQQ',
        direction: 'PUT',
        strike: 500,
        expiration: '2026-08-21',
        entry_premium: 0.9,
        quantity: 1,
      },
    ];
    const result = compareOpenBooks(broker, db);
    assert.equal(result.actionable.length, 1);
    assert.equal(result.actionable[0].type, RECON_MISMATCH.DB_ORPHAN);
    assert.match(result.actionable[0].detail, /QQQ/);
  });

  it('mutes VIX broker orphans without suppressing other orphans', () => {
    const broker = [
      {
        symbol: buildOccSymbol('VIX', '2026-09-18', 'CALL', 20),
        quantity: 2,
        averageOpenPrice: 3.5,
      },
      {
        symbol: buildOccSymbol('IWM', '2026-08-21', 'PUT', 220),
        quantity: 1,
        averageOpenPrice: 0.8,
      },
    ];
    const result = compareOpenBooks(broker, [], {
      mutedUnderlyings: new Set(['VIX']),
    });
    assert.equal(result.muted.length, 1);
    assert.equal(result.muted[0].type, RECON_MISMATCH.BROKER_ORPHAN);
    assert.equal(result.muted[0].muted, true);
    assert.equal(result.actionable.length, 1);
    assert.match(result.actionable[0].detail, /IWM/);
  });

  it('flags qty and premium mismatches', () => {
    const occ = buildOccSymbol('SPY', '2026-08-21', 'CALL', 600);
    const result = compareOpenBooks(
      [{ symbol: occ, quantity: 2, averageOpenPrice: 1.5 }],
      [
        {
          strategy: 'swing',
          id: 9,
          ticker: 'SPY',
          direction: 'CALL',
          strike: 600,
          expiration: '2026-08-21',
          entry_premium: 1.0,
          quantity: 1,
        },
      ]
    );
    const types = result.actionable.map((m) => m.type).sort();
    assert.deepEqual(types, [RECON_MISMATCH.PREMIUM_MISMATCH, RECON_MISMATCH.QTY_MISMATCH].sort());
  });

  it('compareFillPremium respects tolerance', () => {
    assert.equal(compareFillPremium(1.0, 1.04).ok, true);
    assert.equal(compareFillPremium(1.0, 1.1).ok, false);
  });
});

describe('reconConfig isolation', () => {
  it('production config expects live account and public schema', () => {
    const prev = {
      name: process.env.RAILWAY_ENVIRONMENT_NAME,
      schema: process.env.SUPABASE_DB_SCHEMA,
      live: process.env.TASTYTRADE_LIVE_ACCOUNT_NUMBER,
    };
    process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
    delete process.env.SUPABASE_DB_SCHEMA;
    process.env.TASTYTRADE_LIVE_ACCOUNT_NUMBER = '5WI91741';
    try {
      const cfg = getReconRuntimeConfig();
      assert.equal(cfg.mode, 'production');
      assert.equal(cfg.orderEnvironment, 'live');
      assert.equal(cfg.expectedAccount, '5WI91741');
      assert.equal(cfg.expectedSchema, 'public');
      assert.equal(cfg.notifyTelegram, true);
      assert.doesNotThrow(() =>
        assertReconIsolation(cfg, { schema: 'public', accountNumber: '5WI91741' })
      );
      assert.throws(() => assertReconIsolation(cfg, { schema: 'preprod', accountNumber: '5WI91741' }));
      assert.throws(() => assertReconIsolation(cfg, { schema: 'public', accountNumber: '5PB20043' }));
    } finally {
      if (prev.name === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME;
      else process.env.RAILWAY_ENVIRONMENT_NAME = prev.name;
      if (prev.schema === undefined) delete process.env.SUPABASE_DB_SCHEMA;
      else process.env.SUPABASE_DB_SCHEMA = prev.schema;
      if (prev.live === undefined) delete process.env.TASTYTRADE_LIVE_ACCOUNT_NUMBER;
      else process.env.TASTYTRADE_LIVE_ACCOUNT_NUMBER = prev.live;
    }
  });

  it('preprod config expects paper account and preprod schema', () => {
    const prev = {
      name: process.env.RAILWAY_ENVIRONMENT_NAME,
      schema: process.env.SUPABASE_DB_SCHEMA,
    };
    process.env.RAILWAY_ENVIRONMENT_NAME = 'preprod';
    process.env.SUPABASE_DB_SCHEMA = 'preprod';
    try {
      const cfg = getReconRuntimeConfig();
      assert.equal(cfg.mode, 'preprod');
      assert.equal(cfg.orderEnvironment, 'paper');
      assert.equal(cfg.expectedAccount, '5PB20043');
      assert.equal(cfg.notifyTelegram, false);
      assert.equal(cfg.logToEventLog, true);
      assert.throws(() => assertReconIsolation(cfg, { schema: 'public', accountNumber: '5PB20043' }));
      assert.throws(() => assertReconIsolation(cfg, { schema: 'preprod', accountNumber: '5WI91741' }));
    } finally {
      if (prev.name === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME;
      else process.env.RAILWAY_ENVIRONMENT_NAME = prev.name;
      if (prev.schema === undefined) delete process.env.SUPABASE_DB_SCHEMA;
      else process.env.SUPABASE_DB_SCHEMA = prev.schema;
    }
  });

  it('defaults muted underlyings to VIX', () => {
    const prev = process.env.RECON_MUTED_UNDERLYINGS;
    delete process.env.RECON_MUTED_UNDERLYINGS;
    try {
      assert.equal(mutedUnderlyings().has('VIX'), true);
    } finally {
      if (prev === undefined) delete process.env.RECON_MUTED_UNDERLYINGS;
      else process.env.RECON_MUTED_UNDERLYINGS = prev;
    }
  });
});

describe('classifyBrokerFillLogStatus', () => {
  const occ = buildOccSymbol('SPY', '2026-08-31', 'PUT', 765);
  const key = occKey(occ);

  it('does not treat a DB OPEN row as a logged Sell-to-Close (#88)', () => {
    const tx = { symbol: occ, action: 'Sell to Close', price: 1.03 };
    assert.equal(
      classifyBrokerFillLogStatus(tx, {
        openOccKeys: new Set([key]),
        closedOccKeys: new Set(),
      }),
      'unlogged_close'
    );
    const fills = collectUnloggedBrokerFills([tx], {
      openOccKeys: new Set([key]),
      closedOccKeys: new Set(),
    });
    assert.equal(fills.length, 1);
    assert.equal(fills[0].type, RECON_MISMATCH.BROKER_FILL_UNLOGGED);
    assert.match(fills[0].detail, /STC/);
  });

  it('treats BTO as logged while the position is still OPEN', () => {
    const tx = { symbol: occ, action: 'Buy to Open', price: 1.11 };
    assert.equal(
      classifyBrokerFillLogStatus(tx, {
        openOccKeys: new Set([key]),
        closedOccKeys: new Set(),
      }),
      'logged'
    );
    assert.equal(
      collectUnloggedBrokerFills([tx], {
        openOccKeys: new Set([key]),
        closedOccKeys: new Set(),
      }).length,
      0
    );
  });

  it('suppresses STC only when a closed trade_log row exists', () => {
    const tx = { symbol: occ, action: 'Sell to Close', price: 1.03 };
    assert.equal(
      classifyBrokerFillLogStatus(tx, {
        openOccKeys: new Set(),
        closedOccKeys: new Set([key]),
      }),
      'logged'
    );
  });
});
