/**
 * Cross-environment isolation — production stays on public, preprod on preprod.
 * These rules exist to catch silent schema/credential drift before it trades.
 */

export const LIVE_CREDENTIAL_KEYS = Object.freeze([
  'TASTYTRADE_LIVE_USERNAME',
  'TASTYTRADE_LIVE_PASSWORD',
  'TASTYTRADE_LIVE_ACCOUNT_NUMBER',
  'TASTYTRADE_LIVE_ACCOUNT',
  'TASTYTRADE_LIVE_CLIENT_ID',
  'TASTYTRADE_LIVE_CLIENT_SECRET',
  'TASTYTRADE_LIVE_REFRESH_TOKEN',
  'TASTYTRADE_LIVE_TOKEN',
]);

export const DEFAULT_PREPROD_MAX_ORB_TRADES = 40;
export const DEFAULT_PRODUCTION_MIN_ORB_TRADES = 50;
export const DEFAULT_APPROVED_LIVE_PRODUCTION = Object.freeze([
  'orb',
  'premarket',
  'emavwap',
]);

export const ISOLATION_CANARY_CRON = process.env.ISOLATION_CANARY_CRON || '*/20 * * * *';

export function railwayEnvironmentName(env = process.env) {
  return String(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || '')
    .trim()
    .toLowerCase();
}

export function resolveConfiguredSchema(env = process.env) {
  const fromEnv = String(env.SUPABASE_DB_SCHEMA || '').trim();
  if (fromEnv) return fromEnv;
  const url = String(env.SUPABASE_DB_URL || '');
  const m = url.match(/search_path(?:%3D|=)([a-zA-Z_][a-zA-Z0-9_]*)/);
  if (m) return decodeURIComponent(m[1]);
  return 'public';
}

/**
 * @returns {'production'|'preprod'}
 */
export function resolveIsolationMode(env = process.env) {
  const name = railwayEnvironmentName(env);
  if (name === 'preprod') return 'preprod';
  if (name === 'production') return 'production';
  const schema = resolveConfiguredSchema(env);
  return schema === 'preprod' ? 'preprod' : 'production';
}

export function expectedSchemaForMode(mode) {
  return mode === 'preprod' ? 'preprod' : 'public';
}

export function forbiddenSchemasForMode(mode) {
  return mode === 'preprod' ? ['public', 'staging'] : ['preprod'];
}

export function approvedLiveStrategies(mode, env = process.env) {
  if (mode === 'preprod') {
    const raw = String(env.ISOLATION_PREPROD_APPROVED_LIVE || '').trim();
    return raw
      ? raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      : [];
  }
  const raw = String(env.ISOLATION_PRODUCTION_APPROVED_LIVE || '').trim();
  if (raw) {
    return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  return [...DEFAULT_APPROVED_LIVE_PRODUCTION];
}

export function canaryThresholds(env = process.env) {
  return {
    preprodMaxOrbTrades: Number(env.ISOLATION_PREPROD_MAX_ORB_TRADES) || DEFAULT_PREPROD_MAX_ORB_TRADES,
    productionMinOrbTrades:
      Number(env.ISOLATION_PRODUCTION_MIN_ORB_TRADES) || DEFAULT_PRODUCTION_MIN_ORB_TRADES,
  };
}

export function liveCredentialPresence(env = process.env) {
  const present = [];
  const values = {};
  for (const key of LIVE_CREDENTIAL_KEYS) {
    const value = String(env[key] || '').trim();
    values[key] = value;
    if (value) present.push(key);
  }
  const hasAccount = Boolean(
    values.TASTYTRADE_LIVE_ACCOUNT_NUMBER || values.TASTYTRADE_LIVE_ACCOUNT
  );
  const hasOauth = Boolean(
    values.TASTYTRADE_LIVE_CLIENT_SECRET && values.TASTYTRADE_LIVE_REFRESH_TOKEN
  );
  const hasToken = Boolean(values.TASTYTRADE_LIVE_TOKEN);
  const hasPassword = Boolean(
    values.TASTYTRADE_LIVE_USERNAME && values.TASTYTRADE_LIVE_PASSWORD
  );
  return {
    present,
    hasAccount,
    usable: hasAccount && (hasOauth || hasToken || hasPassword),
  };
}

export function shouldRunLiveIsolationGate(env = process.env) {
  const flag = String(env.ISOLATION_GATE || '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'skip') return false;
  if (flag === '1' || flag === 'true') return true;
  return Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID);
}
