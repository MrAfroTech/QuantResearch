/**
 * Favorable-price selection for the 0DTE ratchet.
 *
 * A long option is sold at the bid. The bid is the MFE price when the quote
 * is a real market. Tradier `bid_date` / `ask_date` are last-change times, not
 * heartbeats: an unchanged bid keeps an old timestamp while trades continue.
 * That is not staleness.
 *
 * The quote is stale only when BOTH the bid and the ask timestamps lag the
 * last-sale `trade_date` by more than one 0DTE monitor poll
 * (`ZERO_DTE_POSITION_MONITOR_CRON` default is every 10 seconds). A newer last
 * sale may then advance MFE. A higher last does not override a quote that is
 * still updating.
 */

import { computeStopTriggerPrice } from './ladderConfig.js';
import { trailFloorFromPeak } from './partialLockTrailRungs.js';

/** One default 0DTE monitor tick. The scheduler cron fires every 10 seconds on weekdays. */
export const MFE_QUOTE_STALE_AFTER_MS = 10_000;

const failureByPosition = new Map();

function positivePrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function epochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Tradier quote dates are unix milliseconds. Accept seconds if a feed sends them.
  if (n < 1e12) return Math.round(n * 1000);
  return n;
}

export function selectMfePrice(quote, { pollIntervalMs = MFE_QUOTE_STALE_AFTER_MS } = {}) {
  const bid = positivePrice(quote?.bid);
  const ask = positivePrice(quote?.ask);
  const last = positivePrice(quote?.last);
  const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
  const bidDate = epochMs(quote?.bidDate ?? quote?.bid_date);
  const askDate = epochMs(quote?.askDate ?? quote?.ask_date);
  const tradeDate = epochMs(quote?.tradeDate ?? quote?.trade_date);
  const interval = Number(pollIntervalMs);
  const staleAfter = Number.isFinite(interval) && interval > 0 ? interval : MFE_QUOTE_STALE_AFTER_MS;

  const base = {
    bid,
    ask,
    mid,
    last,
    bidDate,
    askDate,
    tradeDate,
    selectedPrice: null,
    reason: 'no_price',
    freshness: 'unknown',
  };

  const bidLagsTrade = bidDate != null && tradeDate != null && tradeDate - bidDate > staleAfter;
  const askLagsTrade = askDate != null && tradeDate != null && tradeDate - askDate > staleAfter;
  const quoteStale = bidLagsTrade && askLagsTrade;

  if (quoteStale && last != null) {
    return { ...base, selectedPrice: last, reason: 'stale_quote_newer_last', freshness: 'stale' };
  }

  if (bid != null && bidDate != null && tradeDate != null && !quoteStale) {
    const bidChangedRecently = !bidLagsTrade;
    return {
      ...base,
      selectedPrice: bid,
      reason: 'executable_bid',
      freshness: bidChangedRecently ? 'fresh' : 'bid_unchanged',
    };
  }

  if (bid != null && quoteStale) {
    return { ...base, selectedPrice: bid, reason: 'stale_quote_no_newer_last', freshness: 'stale' };
  }

  if (bid != null) {
    return { ...base, selectedPrice: bid, reason: 'freshness_unknown_bid', freshness: 'unknown' };
  }

  if (last != null) {
    return {
      ...base,
      selectedPrice: last,
      reason: 'no_bid_last',
      freshness: tradeDate != null ? 'trade_only' : 'unknown',
    };
  }

  return base;
}

/**
 * Split one observation into the loss-side mark and the ratchet price.
 * The ladder keeps the midpoint. The ratchet uses the selected price,
 * or the mark when the chain did not yield a selectable price.
 */
export function resolveMonitorPremiums(observation) {
  const mark = Number(observation?.mark);
  const selected = Number(observation?.selectedPrice);
  const markOk = Number.isFinite(mark);
  const selectedOk = Number.isFinite(selected);
  const ladderPremium = markOk ? mark : null;
  const ratchetPremium = selectedOk ? selected : (markOk ? mark : null);
  return {
    ladderPremium,
    ratchetPremium,
    quoteMissing: !selectedOk,
  };
}

export function buildMfeAdvanceEvent({
  observedAt = new Date().toISOString(),
  selection,
  entry,
  mfeFrac,
  priorMfe = null,
  floor = null,
  priorFloor = null,
  brokerStopTrigger = null,
}) {
  return {
    type: 'mfe_advance',
    observed_at: observedAt,
    bid: selection?.bid ?? null,
    ask: selection?.ask ?? null,
    midpoint: selection?.mid ?? null,
    last: selection?.last ?? null,
    selected_mfe_price: selection?.selectedPrice ?? null,
    selection_reason: selection?.reason ?? null,
    freshness: selection?.freshness ?? null,
    bid_date: selection?.bidDate ?? null,
    ask_date: selection?.askDate ?? null,
    trade_date: selection?.tradeDate ?? null,
    mfe_pct: mfeFrac,
    prior_mfe_pct: priorMfe,
    ratchet_floor: floor,
    prior_ratchet_floor: priorFloor,
    broker_stop_trigger: brokerStopTrigger,
    entry_premium: entry,
  };
}

/**
 * Upward-only MFE from the selected favorable price.
 * MAE tracks the midpoint mark so a higher last cannot hide a worse quote.
 * Returns an advance event only when MFE strictly increases.
 */
export function planExcursionUpdate(position, {
  ratchetPremium,
  markPremium = null,
  selection = null,
  observedAt = new Date().toISOString(),
} = {}) {
  const entry = Number(position?.entry_premium);
  const px = Number(ratchetPremium);
  if (!(entry > 0) || !Number.isFinite(px)) return null;

  const priorMfe = Number(position?.mfe_pct) || 0;
  const priorMae = Number(position?.mae_pct) || 0;
  const pnlFrac = (px - entry) / entry;
  const mark = Number(markPremium);
  const maePnl = Number.isFinite(mark) && mark > 0 ? (mark - entry) / entry : pnlFrac;
  const mfeFrac = Math.max(priorMfe, pnlFrac);
  const maeFrac = Math.min(priorMae, maePnl);
  const mfeAdvanced = mfeFrac > priorMfe + 1e-12;
  const floor = trailFloorFromPeak(mfeFrac);
  const priorFloor = trailFloorFromPeak(priorMfe);
  const brokerStopTrigger = floor != null
    ? computeStopTriggerPrice(entry, floor)
    : (position?.broker_stop_trigger_price ?? null);

  const eventSelection = selection
    ? {
        ...selection,
        selectedPrice: selection.selectedPrice ?? px,
      }
    : {
        bid: null,
        ask: null,
        mid: Number.isFinite(mark) ? mark : null,
        last: null,
        selectedPrice: px,
        reason: 'mark_fallback',
        freshness: 'unknown',
        bidDate: null,
        askDate: null,
        tradeDate: null,
      };

  return {
    pnlFrac,
    mfeFrac,
    maeFrac,
    changed: mfeFrac !== priorMfe || maeFrac !== priorMae,
    mfeAdvanced,
    floor,
    advanceEvent: mfeAdvanced
      ? buildMfeAdvanceEvent({
          observedAt,
          selection: eventSelection,
          entry,
          mfeFrac,
          priorMfe,
          floor,
          priorFloor,
          brokerStopTrigger,
        })
      : null,
  };
}

/** First failure for a position (or a new reason) is recorded. Repeats are not. */
export function takeMfeFailureEvent(positionId, reason, observedAt = new Date().toISOString()) {
  const key = String(positionId);
  const token = String(reason || 'unknown');
  if (failureByPosition.get(key) === token) return null;
  failureByPosition.set(key, token);
  return {
    type: 'mfe_observation_failed',
    observed_at: observedAt,
    reason: token,
    position_id: positionId,
  };
}

export function clearMfeFailure(positionId) {
  failureByPosition.delete(String(positionId));
}
