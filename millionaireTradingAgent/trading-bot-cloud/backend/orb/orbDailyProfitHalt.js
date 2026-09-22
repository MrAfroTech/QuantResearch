/**
 * @deprecated Prefer getDailyProfitHalt('orb') from ../budget/dailyProfitHalt.js.
 * Thin ORB wrapper kept so existing imports keep working.
 */

import {
  DAILY_PROFIT_HALT_REASON,
  getStrategyRealizedPnlToday,
  getDailyProfitHalt,
} from '../budget/dailyProfitHalt.js';
import { etDateKey } from './tradierTimesales.js';

export { DAILY_PROFIT_HALT_REASON };

export async function getOrbRealizedPnlToday(tradeDate = etDateKey()) {
  return getStrategyRealizedPnlToday('orb', tradeDate);
}

export async function getOrbDailyProfitHalt(tradeDate = etDateKey()) {
  return getDailyProfitHalt('orb', tradeDate);
}
