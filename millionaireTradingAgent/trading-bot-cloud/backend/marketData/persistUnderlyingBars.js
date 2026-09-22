import { upsertUnderlyingBars, TIMEFRAME_5MIN } from './underlyingBarsDb.js';

/**
 * Persist bars fetched during a scan. Never throws into the trading path.
 */
export async function persistUnderlyingBarsSafe(ticker, bars, options = {}) {
  const upsert = options.upsertImpl || upsertUnderlyingBars;
  try {
    const result = await upsert(ticker, bars, {
      timeframe: options.timeframe || TIMEFRAME_5MIN,
      source: options.source || 'scan',
    });
    return { ok: true, ...result };
  } catch (err) {
    console.warn(
      `[underlyingBars] persist failed for ${ticker}:`,
      err?.message || err
    );
    return { ok: false, attempted: 0, upserted: 0, error: err?.message || String(err) };
  }
}

/** Kick persist without awaiting the scan. Rejections are swallowed inside Safe. */
export function persistUnderlyingBarsInBackground(ticker, bars, options = {}) {
  void persistUnderlyingBarsSafe(ticker, bars, options);
}
