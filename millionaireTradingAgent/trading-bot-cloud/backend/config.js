import { DEFAULT_WATCHLIST } from './defaultWatchlist.js';

const SKIPPED_SYMBOLS = new Set(['VIX', '^VIX']);

const DEFAULT_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3001',
  'https://miami-trader.mauricethefirst.com',
];

const VERCEL_PREVIEW_ORIGIN =
  /^https:\/\/trading-[a-z0-9-]+-maurice-sanders-projects\.vercel\.app$/i;

export function isRailway() {
  return Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_PROJECT_ID ||
      process.env.RAILWAY_SERVICE_ID
  );
}

/** Comma-separated Vercel dashboard URL(s) allowed to call the Railway API. */
export function getCorsOrigins() {
  const fromEnv = process.env.FRONTEND_URL || process.env.CORS_ORIGINS;
  const explicit = fromEnv
    ? fromEnv.split(',').map((o) => o.trim()).filter(Boolean)
    : DEFAULT_CORS_ORIGINS;

  const allowedSet = new Set(explicit);

  return {
    allowed(origin) {
      if (allowedSet.has(origin)) return true;
      return VERCEL_PREVIEW_ORIGIN.test(origin);
    },
    list: explicit,
  };
}

/** WATCHLIST takes precedence; TV_WATCHLIST is a legacy alias. */
export function getWatchlist() {
  const raw = process.env.WATCHLIST || process.env.TV_WATCHLIST;
  const list = raw?.trim()
    ? raw.split(',').map((t) => t.trim()).filter(Boolean)
    : DEFAULT_WATCHLIST;
  return list.filter((symbol) => !SKIPPED_SYMBOLS.has(symbol.trim().toUpperCase()));
}

/** Scheduler runs on Railway by default. Local dev: RUN_SCHEDULER=true. */
export function shouldRunScheduler() {
  const flag = process.env.RUN_SCHEDULER?.trim().toLowerCase();
  if (flag === 'false' || flag === '0') return false;
  if (flag === 'true' || flag === '1') return true;
  return isRailway();
}

/** Public URL for webhooks — Railway host only in production. */
export function getPublicBaseUrl() {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  if (process.env.RAILWAY_STATIC_URL) {
    return process.env.RAILWAY_STATIC_URL.replace(/\/$/, '');
  }
  return process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
}

/** Dashboard mode toggles and other public write controls. Off until auth is implemented. */
export function areDashboardControlsEnabled() {
  const flag = process.env.DASHBOARD_CONTROLS_ENABLED?.trim().toLowerCase();
  return flag === 'true' || flag === '1';
}

export const DASHBOARD_CONTROLS_DISABLED_MESSAGE =
  'Dashboard controls are temporarily disabled pending authentication';

export function validateStartupConfig() {
  const warnings = [];
  const errors = [];

  if (!process.env.SUPABASE_DB_URL) {
    errors.push('SUPABASE_DB_URL is required');
  }

  if (!process.env.TRADIER_API_TOKEN) {
    warnings.push('TRADIER_API_TOKEN is missing — market scans will fail');
  }

  if (!process.env.WATCHLIST && process.env.TV_WATCHLIST) {
    warnings.push(
      'Using TV_WATCHLIST — set WATCHLIST on Railway (TV_WATCHLIST is deprecated)'
    );
  }

  if (getWatchlist().length === 0) {
    warnings.push('Watchlist is empty after filtering — using defaults');
  }

  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    warnings.push('Telegram not configured — trade alerts disabled');
  }

  if (!process.env.TASTYTRADE_USERNAME || !process.env.TASTYTRADE_PASSWORD) {
    warnings.push('Tastytrade credentials missing — live orders will fail');
  }

  if (isRailway() && !shouldRunScheduler()) {
    warnings.push(
      'Scheduler disabled on Railway — remove RUN_SCHEDULER=false or set RUN_SCHEDULER=true'
    );
  }

  if (!isRailway() && !shouldRunScheduler()) {
    warnings.push('Scheduler disabled — set RUN_SCHEDULER=true in .env for local polling');
  }

  if (isRailway() && !process.env.FRONTEND_URL) {
    warnings.push(
      'FRONTEND_URL not set — add your Vercel dashboard URL for explicit CORS allowlist'
    );
  }

  for (const msg of warnings) {
    console.warn(`[Config] ${msg}`);
  }
  for (const msg of errors) {
    console.error(`[Config] ${msg}`);
  }

  return { warnings, errors, ok: errors.length === 0 };
}
