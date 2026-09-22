import { getSql } from './sqlClient.js';
import { ensureOrbSchema } from './orb/orbDb.js';
import { ensurePremarketSchema } from './premarketBreakout/premarketDb.js';
import { ensureEmaVwapSchema } from './emaVwapCross/emaVwapDb.js';

const BOT_SYMBOL = '';
const BOT_DATE = '';

let schemaReady;

function normalizeEnvironment(value) {
  return String(value || '').toLowerCase() === 'live' ? 'live' : 'paper';
}

export async function ensureStrategyEnvironmentSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await ensureOrbSchema();
    await ensurePremarketSchema();
    await ensureEmaVwapSchema();
    const sql = getSql();
    await sql`ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS swing_environment TEXT DEFAULT 'paper'`;
    await sql`ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS orb_environment TEXT DEFAULT 'paper'`;
    await sql`ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS premarket_environment TEXT DEFAULT 'paper'`;
    await sql`ALTER TABLE emavwap_state ADD COLUMN IF NOT EXISTS environment TEXT DEFAULT 'paper'`;
  })();
  return schemaReady;
}

export async function getStrategyEnvironment(strategy) {
  await ensureStrategyEnvironmentSchema();
  const sql = getSql();

  if (strategy === 'swing') {
    const [row] = await sql`SELECT swing_environment FROM bot_state WHERE id = 1`;
    return normalizeEnvironment(row?.swing_environment);
  }
  if (strategy === 'orb') {
    const [row] = await sql`SELECT orb_environment FROM bot_state WHERE id = 1`;
    return normalizeEnvironment(row?.orb_environment);
  }
  if (strategy === 'premarket') {
    const [row] = await sql`SELECT premarket_environment FROM bot_state WHERE id = 1`;
    return normalizeEnvironment(row?.premarket_environment);
  }
  if (strategy === 'emavwap') {
    const [row] = await sql`
      SELECT environment FROM emavwap_state
      WHERE symbol = ${BOT_SYMBOL} AND trade_date = ${BOT_DATE}
    `;
    return normalizeEnvironment(row?.environment);
  }

  return 'paper';
}

export async function setStrategyEnvironment(strategy, environment) {
  const env = normalizeEnvironment(environment);
  if (!['paper', 'live'].includes(env)) {
    throw new Error('Environment must be paper or live');
  }
  if (!['swing', 'orb', 'premarket', 'emavwap'].includes(strategy)) {
    throw new Error('Strategy must be swing, orb, premarket, or emavwap');
  }

  await ensureStrategyEnvironmentSchema();
  const sql = getSql();

  if (strategy === 'swing') {
    await sql`
      UPDATE bot_state
      SET swing_environment = ${env}, updated_at = NOW()::text
      WHERE id = 1
    `;
  } else if (strategy === 'orb') {
    await sql`
      UPDATE bot_state
      SET orb_environment = ${env}, updated_at = NOW()::text
      WHERE id = 1
    `;
  } else if (strategy === 'premarket') {
    await sql`
      UPDATE bot_state
      SET premarket_environment = ${env}, updated_at = NOW()::text
      WHERE id = 1
    `;
  } else {
    await sql`
      UPDATE emavwap_state
      SET environment = ${env}, updated_at = NOW()::text
      WHERE symbol = ${BOT_SYMBOL} AND trade_date = ${BOT_DATE}
    `;
  }

  return env;
}

/** Railway production environment only — staging stays paper-executable and unfiltered. */
export function isProductionRuntime() {
  const envName = String(
    process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || ''
  ).toLowerCase();
  return envName === 'production';
}

/** Close/exit alerts for already-open positions must still fire in paper mode. */
export function isCloseOrExitAlertType(alertType) {
  const t = String(alertType || '').toLowerCase();
  return (
    t.includes('trade_closed') ||
    t.includes('close_order') ||
    t.includes('unprotected_broker_stop') ||
    t.includes('oto_stop_align') ||
    t.includes('partial_fill')
  );
}

/**
 * Production: suppress non-exit Telegram for any currently-paper strategy.
 * Staging: never suppress. Live strategies: never suppress.
 */
export async function shouldSuppressNonExitTelegram(strategy) {
  if (!isProductionRuntime()) return false;
  if (!strategy) return false;
  const env = await getStrategyEnvironment(strategy);
  return env !== 'live';
}

export async function getAllStrategyEnvironments() {
  const strategies = ['swing', 'orb', 'premarket', 'emavwap'];
  const environments = {};
  for (const strategy of strategies) {
    environments[strategy] = await getStrategyEnvironment(strategy);
  }
  return environments;
}
