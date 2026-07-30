import { getQuote, getOptionChain } from '../tradierClient.js';
import {
  STRONG_BREAKOUT_BODY_RATIO,
  STRONG_OTM_STEPS,
  WEAK_OTM_STEPS,
  ORB_STRIKE_STEP,
} from './orbConfig.js';
import { candleBody, etDateKey } from './tradierTimesales.js';

/**
 * Classify breakout strength from breakout candle body vs opening range width.
 * STRONG_BREAKOUT_BODY_RATIO is UNBACKTESTED — see orbConfig.js.
 */
export function classifyBreakoutStrength(entrySignal) {
  const orWidth = entrySignal.opening_range_high - entrySignal.opening_range_low;
  if (!Number.isFinite(orWidth) || orWidth <= 0) {
    return { bucket: 'weak', bodyRatio: 0 };
  }

  const breakoutBar = entrySignal.breakout_candle;
  const body = breakoutBar?.body ?? candleBody(breakoutBar || {});
  const bodyRatio = body / orWidth;

  const bucket = bodyRatio >= STRONG_BREAKOUT_BODY_RATIO ? 'strong' : 'weak';
  return { bucket, bodyRatio };
}

function getStrikeStep(symbol) {
  return ORB_STRIKE_STEP[symbol] || 1;
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

export async function selectOrbStrike(entrySignal) {
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
