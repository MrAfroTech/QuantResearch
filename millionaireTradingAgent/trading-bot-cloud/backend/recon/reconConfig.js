/**
 * THE3-2 reconciliation environment isolation.
 * Production job must never touch preprod schema/account; preprod never touches public/live.
 */

function envName() {
  return String(
    process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || ''
  ).toLowerCase();
}

/**
 * Resolve active Postgres schema without requiring sqlClient schema awareness on older builds.
 * Prefer SUPABASE_DB_SCHEMA; else parse search_path from SUPABASE_DB_URL options; else public.
 */
export function resolveActiveDbSchema() {
  const fromEnv = String(process.env.SUPABASE_DB_SCHEMA || '').trim();
  if (fromEnv) return fromEnv;
  const url = String(process.env.SUPABASE_DB_URL || '');
  const m = url.match(/search_path(?:%3D|=)([a-zA-Z_][a-zA-Z0-9_]*)/);
  if (m) return decodeURIComponent(m[1]);
  return 'public';
}

/** Manual underlyings that may exist at the broker without a bot DB row. */
export function mutedUnderlyings() {
  const raw = process.env.RECON_MUTED_UNDERLYINGS || 'VIX';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );
}

/**
 * @returns {{
 *   mode: 'production'|'preprod',
 *   orderEnvironment: 'live'|'paper',
 *   expectedAccount: string,
 *   expectedSchema: string,
 *   notifyTelegram: boolean,
 *   logToEventLog: boolean,
 * }}
 */
export function getReconRuntimeConfig() {
  const schema = resolveActiveDbSchema();
  const name = envName();
  const isPreprod = name === 'preprod' || schema === 'preprod';

  if (isPreprod) {
    return {
      mode: 'preprod',
      orderEnvironment: 'paper',
      expectedAccount: String(process.env.RECON_EXPECTED_ACCOUNT || '5PB20043').trim(),
      expectedSchema: 'preprod',
      notifyTelegram: false,
      logToEventLog: true,
    };
  }

  return {
    mode: 'production',
    orderEnvironment: 'live',
    expectedAccount: String(
      process.env.RECON_EXPECTED_ACCOUNT ||
        process.env.TASTYTRADE_LIVE_ACCOUNT_NUMBER ||
        '5WI91741'
    ).trim(),
    expectedSchema: 'public',
    notifyTelegram: true,
    logToEventLog: false,
  };
}

/**
 * Refuse to run if schema/account wiring looks cross-contaminated.
 */
export function assertReconIsolation(config, { accountNumber, schema } = {}) {
  if (!config) throw new Error('recon config required');
  if (schema && schema !== config.expectedSchema) {
    throw new Error(
      `[THE3-2] REFUSING: schema=${schema} but recon mode=${config.mode} expects ${config.expectedSchema}`
    );
  }
  if (config.mode === 'production' && schema === 'preprod') {
    throw new Error('[THE3-2] REFUSING: production recon cannot use preprod schema');
  }
  if (config.mode === 'preprod' && (schema === 'public' || schema == null)) {
    // schema null only if we couldn't resolve — still require expectedSchema match when known
  }
  if (config.mode === 'preprod' && schema === 'public') {
    throw new Error('[THE3-2] REFUSING: preprod recon cannot use public schema');
  }
  if (accountNumber && config.expectedAccount && accountNumber !== config.expectedAccount) {
    throw new Error(
      `[THE3-2] REFUSING: broker account=${accountNumber} but recon expects ${config.expectedAccount}`
    );
  }
  if (config.mode === 'production' && accountNumber === '5PB20043') {
    throw new Error('[THE3-2] REFUSING: production recon cannot use paper account 5PB20043');
  }
  if (config.mode === 'preprod' && accountNumber === '5WI91741') {
    throw new Error('[THE3-2] REFUSING: preprod recon cannot use live account 5WI91741');
  }
}
