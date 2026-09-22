/**
 * Isolation assertions. Pure functions are safe for CI; live runners hit the
 * environment's real connection and must fail closed.
 */
import postgres from 'postgres';
import {
  approvedLiveStrategies,
  canaryThresholds,
  expectedSchemaForMode,
  forbiddenSchemasForMode,
  liveCredentialPresence,
  resolveConfiguredSchema,
  resolveIsolationMode,
} from './isolationConfig.js';

export function evaluateSchemaIdentity({ currentSchema, expectedSchema }) {
  const current = String(currentSchema || '');
  const expected = String(expectedSchema || '');
  if (!expected) {
    return { ok: false, name: 'schema_identity', detail: 'expected schema missing' };
  }
  if (current !== expected) {
    return {
      ok: false,
      name: 'schema_identity',
      detail: `current_schema=${current} expected=${expected}`,
    };
  }
  return { ok: true, name: 'schema_identity', detail: current };
}

/**
 * A successful SELECT on a foreign schema is a critical failure.
 * @param {{ schema: string, ok: boolean, code?: string, message?: string }[]} attempts
 */
export function evaluateNegativePermissions(attempts) {
  const leaks = attempts.filter((a) => a.ok);
  if (leaks.length) {
    return {
      ok: false,
      name: 'negative_permission',
      detail: `READ SUCCEEDED on forbidden schema(s): ${leaks.map((a) => a.schema).join(', ')}`,
    };
  }
  const weak = attempts.filter(
    (a) => !a.ok && a.code !== '42501' && !/permission denied/i.test(String(a.message || ''))
  );
  if (weak.length) {
    return {
      ok: false,
      name: 'negative_permission',
      detail: `foreign-schema read failed for the wrong reason: ${weak
        .map((a) => `${a.schema}:${a.code || a.message}`)
        .join('; ')}`,
    };
  }
  return {
    ok: true,
    name: 'negative_permission',
    detail: attempts.map((a) => `${a.schema}:denied`).join(', '),
  };
}

export function evaluateLiveCredentials({ mode, env = process.env }) {
  const creds = liveCredentialPresence(env);
  if (mode === 'preprod') {
    if (creds.present.length) {
      return {
        ok: false,
        name: 'live_credentials',
        detail: `preprod must not have TASTYTRADE_LIVE_* set (${creds.present.join(', ')})`,
      };
    }
    return { ok: true, name: 'live_credentials', detail: 'preprod has no live Tastytrade credentials' };
  }
  if (!creds.usable) {
    return {
      ok: false,
      name: 'live_credentials',
      detail:
        'production requires TASTYTRADE_LIVE_ACCOUNT_NUMBER (or _ACCOUNT) plus OAuth/token/password',
    };
  }
  return { ok: true, name: 'live_credentials', detail: `present ${creds.present.join(',')}` };
}

export function evaluateStrategyEnvironments({ mode, environments, env = process.env }) {
  const approved = new Set(approvedLiveStrategies(mode, env));
  const live = Object.entries(environments || {})
    .filter(([, value]) => String(value || '').toLowerCase() === 'live')
    .map(([key]) => key);
  const unexpected = live.filter((key) => !approved.has(key));
  if (unexpected.length) {
    return {
      ok: false,
      name: 'strategy_environments',
      detail: `live flags not approved for ${mode}: ${unexpected.join(', ')}`,
    };
  }
  return {
    ok: true,
    name: 'strategy_environments',
    detail: `live=[${live.join(',') || 'none'}] approved=[${[...approved].join(',') || 'none'}]`,
  };
}

export function evaluateCrossContaminationCanary({
  mode,
  orbTradeCount,
  pdhlTableCount,
  pdhlColumns = [],
  env = process.env,
}) {
  const { preprodMaxOrbTrades, productionMinOrbTrades } = canaryThresholds(env);
  const orb = Number(orbTradeCount);
  const pdhlTables = Number(pdhlTableCount) || 0;
  const pdhlCols = pdhlColumns.filter(Boolean);

  if (mode === 'preprod') {
    if (!Number.isFinite(orb) || orb > preprodMaxOrbTrades) {
      return {
        ok: false,
        name: 'cross_contamination_canary',
        detail: `preprod orb_trade_log count=${orb} exceeds max ${preprodMaxOrbTrades} — looks like production`,
      };
    }
    if (pdhlTables < 1) {
      return {
        ok: false,
        name: 'cross_contamination_canary',
        detail: 'preprod is missing pdhl_* tables (preprod-exclusive artifact)',
      };
    }
    return {
      ok: true,
      name: 'cross_contamination_canary',
      detail: `preprod orb=${orb} pdhl_tables=${pdhlTables}`,
    };
  }

  if (!Number.isFinite(orb) || orb < productionMinOrbTrades) {
    return {
      ok: false,
      name: 'cross_contamination_canary',
      detail: `production orb_trade_log count=${orb} below min ${productionMinOrbTrades} — looks like preprod`,
    };
  }
  if (pdhlTables > 0 || pdhlCols.length) {
    return {
      ok: false,
      name: 'cross_contamination_canary',
      detail: `production has preprod-exclusive PDHL artifacts tables=${pdhlTables} columns=${pdhlCols.join(',')}`,
    };
  }
  return {
    ok: true,
    name: 'cross_contamination_canary',
    detail: `production orb=${orb} pdhl_tables=0`,
  };
}

export function summarizeIsolationResults(results) {
  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    failed: failed.map((r) => r.name),
    results,
    detail: failed.map((r) => `${r.name}: ${r.detail}`).join(' | '),
  };
}

async function probeForbiddenSchema(sql, schema) {
  try {
    await sql.unsafe(`SELECT 1 FROM ${schema}.orb_trade_log LIMIT 1`);
    return { schema, ok: true };
  } catch (err) {
    return {
      schema,
      ok: false,
      code: err.code || null,
      message: String(err.message || err),
    };
  }
}

async function loadLiveSnapshot(sql) {
  const [schemaRow] = await sql`SELECT current_schema()::text AS schema`;
  const [orb] = await sql`SELECT COUNT(*)::int AS n FROM orb_trade_log`;
  const [pdhl] = await sql`
    SELECT COUNT(*)::int AS n
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name LIKE 'pdhl_%'
  `;
  const pdhlCols = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'bot_state'
      AND column_name IN ('pdhl_mode', 'pdhl_environment')
  `;

  let environments = {};
  try {
    const [bot] = await sql`
      SELECT swing_environment, orb_environment, premarket_environment
      FROM bot_state WHERE id = 1
    `;
    environments = {
      swing: bot?.swing_environment || 'paper',
      orb: bot?.orb_environment || 'paper',
      premarket: bot?.premarket_environment || 'paper',
    };
  } catch {
    environments = { swing: 'paper', orb: 'paper', premarket: 'paper' };
  }
  try {
    const [ema] = await sql`
      SELECT environment FROM emavwap_state
      WHERE symbol = '' AND trade_date = ''
    `;
    environments.emavwap = ema?.environment || 'paper';
  } catch {
    environments.emavwap = 'paper';
  }
  if (Number(pdhl.n) > 0) {
    try {
      const [pdhlEnv] = await sql`SELECT pdhl_environment FROM bot_state WHERE id = 1`;
      environments.pdhl = pdhlEnv?.pdhl_environment || 'paper';
    } catch {
      environments.pdhl = 'paper';
    }
  }

  return {
    currentSchema: schemaRow?.schema || null,
    orbTradeCount: orb?.n,
    pdhlTableCount: pdhl?.n,
    pdhlColumns: pdhlCols.map((r) => r.column_name),
    environments,
  };
}

/**
 * Full live isolation suite against this process's SUPABASE_DB_URL.
 */
export async function runLiveIsolationChecks(env = process.env) {
  const mode = resolveIsolationMode(env);
  const expectedSchema = expectedSchemaForMode(mode);
  const configured = resolveConfiguredSchema(env);
  const url = env.SUPABASE_DB_URL;
  if (!url) {
    return summarizeIsolationResults([
      { ok: false, name: 'schema_identity', detail: 'SUPABASE_DB_URL is required' },
    ]);
  }

  const sql = postgres(url, {
    max: 1,
    connection: { search_path: configured || expectedSchema },
  });

  try {
    const snapshot = await loadLiveSnapshot(sql);
    const attempts = [];
    for (const schema of forbiddenSchemasForMode(mode)) {
      attempts.push(await probeForbiddenSchema(sql, schema));
    }

    const results = [
      evaluateSchemaIdentity({
        currentSchema: snapshot.currentSchema,
        expectedSchema,
      }),
      evaluateNegativePermissions(attempts),
      evaluateLiveCredentials({ mode, env }),
      evaluateStrategyEnvironments({ mode, environments: snapshot.environments, env }),
      evaluateCrossContaminationCanary({
        mode,
        orbTradeCount: snapshot.orbTradeCount,
        pdhlTableCount: snapshot.pdhlTableCount,
        pdhlColumns: snapshot.pdhlColumns,
        env,
      }),
    ];
    return {
      ...summarizeIsolationResults(results),
      mode,
      expectedSchema,
      currentSchema: snapshot.currentSchema,
      snapshot,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function assertEnvironmentIsolation(env = process.env) {
  const report = await runLiveIsolationChecks(env);
  if (!report.ok) {
    throw new Error(`[isolation] REFUSING: ${report.detail}`);
  }
  return report;
}
