import { getQuote, getOptionChain } from '../tradierClient.js';
import {
  STRONG_BREAKOUT_DISTANCE_RATIO,
  STRONG_OTM_STEPS,
  WEAK_OTM_STEPS,
  PREMARKET_STRIKE_STEP,
} from './premarketConfig.js';
import { etDateKey } from '../orb/tradierTimesales.js';

/**
 * Classify breakout strength from distance traveled beyond breakout level vs premarket range width.
 * STRONG_BREAKOUT_DISTANCE_RATIO is UNBACKTESTED — see premarketConfig.js.
 */
export function classifyBreakoutStrength(entrySignal) {
  const rangeWidth = entrySignal.premarket_high - entrySignal.premarket_low;
  if (!Number.isFinite(rangeWidth) || rangeWidth <= 0) {
    return { bucket: 'weak', distanceRatio: 0 };
  }

  const distance = Number(entrySignal.breakout_distance);
  if (!Number.isFinite(distance) || distance < 0) {
    const breakoutBar = entrySignal.breakout_candle;
    const level = entrySignal.breakout_level;
    const dir = entrySignal.direction;
    const computed =
      dir === 'CALL' && breakoutBar
        ? breakoutBar.close - level
        : dir === 'PUT' && breakoutBar
          ? level - breakoutBar.close
          : 0;
    const distanceRatio = computed / rangeWidth;
    const bucket = distanceRatio >= STRONG_BREAKOUT_DISTANCE_RATIO ? 'strong' : 'weak';
    return { bucket, distanceRatio };
  }

  const distanceRatio = distance / rangeWidth;
  const bucket = distanceRatio >= STRONG_BREAKOUT_DISTANCE_RATIO ? 'strong' : 'weak';
  return { bucket, distanceRatio };
}

function getStrikeStep(symbol) {
  return PREMARKET_STRIKE_STEP[symbol] || 1;
}

function pickStrike(spot, direction, step, otmSteps) {
  const atm = Math.round(spot / step) * step;
  if (direction === 'CALL') {
    return atm + step * otmSteps;
  }
  return atm - step * otmSteps;
}

function readGreeks(option) {
  const greeks = option?.greeks;
  if (!greeks) return { iv: null, delta: null };
  const iv = greeks.mid_iv ?? greeks.smv_vol ?? greeks.bid_iv ?? greeks.ask_iv ?? null;
  const delta = greeks.delta ?? null;
  return {
    iv: iv != null ? Number(iv) : null,
    delta: delta != null ? Number(delta) : null,
  };
}

export async function selectPremarketStrike(entrySignal) {
  const symbol = entrySignal.symbol;
  const direction = entrySignal.direction;
  const { bucket } = classifyBreakoutStrength(entrySignal);
  const otmSteps = bucket === 'strong' ? STRONG_OTM_STEPS : WEAK_OTM_STEPS;

  const quote = await getQuote(symbol);
  const spot = Number(quote.last);
  const step = getStrikeStep(symbol);
  const targetStrike = pickStrike(spot, direction, step, otmSteps);
  const expiration = etDateKey();

  const chain = await getOptionChain(symbol, expiration);
  const optionType = direction === 'CALL' ? 'call' : 'put';

  let best = null;
  let bestDiff = Infinity;

  for (const option of chain) {
    if ((option.option_type || '').toLowerCase() !== optionType) continue;
    const diff = Math.abs(option.strike - targetStrike);
    if (diff < bestDiff) {
      best = option;
      bestDiff = diff;
    }
  }

  if (!best) {
    throw new Error(`No 0DTE ${direction} option found for ${symbol} @ ~${targetStrike}`);
  }

  const premium = best.mid ?? best.bid ?? best.ask;
  if (premium == null) {
    throw new Error(`No quote for ${symbol} ${direction} ${best.strike}`);
  }

  const { iv, delta } = readGreeks(best);

  return {
    symbol,
    direction,
    strike: best.strike,
    expiration,
    premium,
    optionSymbol: best.symbol,
    strike_bucket: bucket,
    entry_iv: iv,
    entry_delta: delta,
    target_strike: targetStrike,
    spot,
  };
}
