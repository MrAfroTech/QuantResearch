import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCrossContaminationCanary,
  evaluateLiveCredentials,
  evaluateNegativePermissions,
  evaluateSchemaIdentity,
  evaluateStrategyEnvironments,
} from './isolationChecks.js';
import {
  LIVE_CREDENTIAL_KEYS,
  expectedSchemaForMode,
  forbiddenSchemasForMode,
  resolveIsolationMode,
  shouldRunLiveIsolationGate,
} from './isolationConfig.js';

const saved = {};
function setEnv(key, value) {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete saved[key];
  }
});

describe('schema identity', () => {
  it('passes when current_schema matches the environment', () => {
    assert.equal(evaluateSchemaIdentity({ currentSchema: 'public', expectedSchema: 'public' }).ok, true);
    assert.equal(evaluateSchemaIdentity({ currentSchema: 'preprod', expectedSchema: 'preprod' }).ok, true);
  });

  it('fails on tonight-style silent public fallback', () => {
    const result = evaluateSchemaIdentity({ currentSchema: 'public', expectedSchema: 'preprod' });
    assert.equal(result.ok, false);
    assert.match(result.detail, /current_schema=public expected=preprod/);
  });
});

describe('negative permission', () => {
  it('passes only on a real 42501 / permission denied', () => {
    const result = evaluateNegativePermissions([
      { schema: 'public', ok: false, code: '42501', message: 'permission denied for table orb_trade_log' },
      { schema: 'staging', ok: false, code: '42501', message: 'permission denied for schema staging' },
    ]);
    assert.equal(result.ok, true);
  });

  it('treats a successful foreign-schema read as a critical failure', () => {
    const result = evaluateNegativePermissions([
      { schema: 'public', ok: true },
    ]);
    assert.equal(result.ok, false);
    assert.match(result.detail, /READ SUCCEEDED on forbidden schema/);
  });

  it('does not accept a non-permission error as isolation', () => {
    const result = evaluateNegativePermissions([
      { schema: 'public', ok: false, code: '42P01', message: 'relation does not exist' },
    ]);
    assert.equal(result.ok, false);
    assert.match(result.detail, /wrong reason/);
  });
});

describe('live credentials', () => {
  it('fails preprod when any TASTYTRADE_LIVE_* is set', () => {
    const env = { TASTYTRADE_LIVE_ACCOUNT_NUMBER: '5WI91741' };
    const result = evaluateLiveCredentials({ mode: 'preprod', env });
    assert.equal(result.ok, false);
    assert.match(result.detail, /must not have TASTYTRADE_LIVE_/);
  });

  it('passes preprod when every live key is absent', () => {
    const env = Object.fromEntries(LIVE_CREDENTIAL_KEYS.map((k) => [k, '']));
    const result = evaluateLiveCredentials({ mode: 'preprod', env });
    assert.equal(result.ok, true);
  });

  it('fails production when live credentials are missing', () => {
    const result = evaluateLiveCredentials({ mode: 'production', env: {} });
    assert.equal(result.ok, false);
  });

  it('passes production with account + OAuth pair', () => {
    const result = evaluateLiveCredentials({
      mode: 'production',
      env: {
        TASTYTRADE_LIVE_ACCOUNT_NUMBER: '5WI91741',
        TASTYTRADE_LIVE_CLIENT_SECRET: 'secret',
        TASTYTRADE_LIVE_REFRESH_TOKEN: 'refresh',
      },
    });
    assert.equal(result.ok, true);
  });
});

describe('strategy environments', () => {
  it('fails preprod if any strategy is live', () => {
    const result = evaluateStrategyEnvironments({
      mode: 'preprod',
      environments: { swing: 'paper', orb: 'live', premarket: 'paper', emavwap: 'paper' },
      env: {},
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /orb/);
  });

  it('passes preprod when every strategy is paper', () => {
    const result = evaluateStrategyEnvironments({
      mode: 'preprod',
      environments: { swing: 'paper', orb: 'paper', premarket: 'paper', emavwap: 'paper', pdhl: 'paper' },
      env: {},
    });
    assert.equal(result.ok, true);
  });

  it('passes production with the approved live set and swing paper', () => {
    const result = evaluateStrategyEnvironments({
      mode: 'production',
      environments: { swing: 'paper', orb: 'live', premarket: 'live', emavwap: 'live' },
      env: {},
    });
    assert.equal(result.ok, true);
  });

  it('fails production if swing is live without an explicit approval', () => {
    const result = evaluateStrategyEnvironments({
      mode: 'production',
      environments: { swing: 'live', orb: 'live', premarket: 'live', emavwap: 'live' },
      env: {},
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /swing/);
  });
});

describe('cross-contamination canary', () => {
  it('fails preprod when orb_trade_log looks like production (tonight)', () => {
    const result = evaluateCrossContaminationCanary({
      mode: 'preprod',
      orbTradeCount: 100,
      pdhlTableCount: 0,
      env: {},
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /looks like production/);
  });

  it('passes preprod on a small paper book with PDHL tables', () => {
    const result = evaluateCrossContaminationCanary({
      mode: 'preprod',
      orbTradeCount: 13,
      pdhlTableCount: 5,
      env: {},
    });
    assert.equal(result.ok, true);
  });

  it('fails production when the book looks like preprod', () => {
    const result = evaluateCrossContaminationCanary({
      mode: 'production',
      orbTradeCount: 13,
      pdhlTableCount: 5,
      pdhlColumns: ['pdhl_environment'],
      env: {},
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /looks like preprod/);
  });

  it('fails production when PDHL artifacts exist on public', () => {
    const result = evaluateCrossContaminationCanary({
      mode: 'production',
      orbTradeCount: 100,
      pdhlTableCount: 5,
      pdhlColumns: ['pdhl_mode'],
      env: {},
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /PDHL/);
  });

  it('passes production on a large book with no PDHL', () => {
    const result = evaluateCrossContaminationCanary({
      mode: 'production',
      orbTradeCount: 100,
      pdhlTableCount: 0,
      pdhlColumns: [],
      env: {},
    });
    assert.equal(result.ok, true);
  });
});

describe('runtime mode helpers', () => {
  it('maps Railway env names to the expected schema and forbidden list', () => {
    assert.equal(expectedSchemaForMode('production'), 'public');
    assert.equal(expectedSchemaForMode('preprod'), 'preprod');
    assert.deepEqual(forbiddenSchemasForMode('production'), ['preprod']);
    assert.deepEqual(forbiddenSchemasForMode('preprod'), ['public', 'staging']);
  });

  it('resolves mode from Railway first, then search_path', () => {
    assert.equal(resolveIsolationMode({ RAILWAY_ENVIRONMENT: 'preprod' }), 'preprod');
    assert.equal(resolveIsolationMode({ RAILWAY_ENVIRONMENT: 'production' }), 'production');
    assert.equal(resolveIsolationMode({ SUPABASE_DB_SCHEMA: 'preprod' }), 'preprod');
  });

  it('runs the live gate on Railway and skips when ISOLATION_GATE=skip', () => {
    setEnv('RAILWAY_ENVIRONMENT', 'production');
    setEnv('ISOLATION_GATE', undefined);
    assert.equal(shouldRunLiveIsolationGate(process.env), true);
    setEnv('ISOLATION_GATE', 'skip');
    assert.equal(shouldRunLiveIsolationGate(process.env), false);
  });
});
