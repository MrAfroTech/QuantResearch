import { getQuote, getOptionChain } from '../tradierClient.js';
import {
  STRONG_CROSS_GAP_PCT,
  STRONG_OTM_STEPS,
  WEAK_OTM_STEPS,
  EMA_VWAP_STRIKE_STEP,
} from './emaVwapConfig.js';
import { etDateKey } from '../orb/tradierTimesales.js';

/**
 * Strong cross: |9EMA − VWAP| >= STRONG_CROSS_GAP_PCT × underlying price.
 * STRONG_CROSS_GAP_PCT is UNBACKTESTED — see emaVwapConfig.js.
 */
export function classifyCrossStrength(entrySignal) {
  const price = Number(entrySignal.underlying_price);
  const gap = Number(entrySignal.ema_vwap_gap);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(gap)) {
    return { bucket: 'weak', gapPct: 0 };
  }
  const gapPct = gap / price;
  const bucket = gapPct >= STRONG_CROSS_GAP_PCT ? 'strong' : 'weak';
  return { bucket, gapPct };
}

function getStrikeStep(symbol) {
  return EMA_VWAP_STRIKE_STEP[symbol] || 1;
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

export async function selectEmaVwapStrike(entrySignal) {
  const symbol = entrySignal.symbol;
  const direction = entrySignal.direction;
  const { bucket } = classifyCrossStrength(entrySignal);
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
