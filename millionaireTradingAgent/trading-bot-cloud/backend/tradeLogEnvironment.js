/**
 * Read-only snapshot of a strategy's live/paper flag for trade-log tagging.
 *
 * Same SELECT + normalize as getStrategyEnvironment, kept here so trade-log
 * INSERT sites do not import strategyEnvironment.js (that module imports
 * ensure*Schema from the *Db files — a static cycle).
 *
 * A failed read returns null so the close INSERT still succeeds. Null on the
 * row means unknown — same as pre-deploy historical rows (no backfill).
 */
import { getSql } from './sqlClient.js';

const EMAVWAP_SYMBOL = '';
const EMAVWAP_DATE = '';

function normalizeEnvironment(value) {
  return String(value || '').toLowerCase() === 'live' ? 'live' : 'paper';
}

export async function readStrategyEnvironmentForLog(strategy, sql = getSql()) {
  try {
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
        WHERE symbol = ${EMAVWAP_SYMBOL} AND trade_date = ${EMAVWAP_DATE}
      `;
      return normalizeEnvironment(row?.environment);
    }
    return 'paper';
  } catch {
    return null;
  }
}
