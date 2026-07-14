import { callTvTool } from './tvMcpClient.js';
import { logSignal } from './db.js';

const DEFAULT_WATCHLIST = ['SOFI', 'AI', '^VIX'];

// Yahoo/Google-style watchlist tickers -> TradingView chart symbols (EXCHANGE:SYMBOL)
const TV_SYMBOL_OVERRIDES = {
  '^VIX': 'CBOE:VIX',
  VIX: 'CBOE:VIX',
  '^GSPC': 'CBOE:SPX',
  '^DJI': 'TVC:DJI',
  '^IXIC': 'NASDAQ:NDX',
};
// Alternate TV feed when primary override symbol returns 0 bars or MCP load error
const TV_SYMBOL_FALLBACKS = {
  'CBOE:VIX': 'TVC:VIX',
};
const CALL_REASON =
  'Uptrend confirmed (D+W) — breakout above 20-day high and premarket high';
const PUT_REASON =
  'Downtrend confirmed (D+W) — lower highs and lower lows on daily and weekly';
const NEUTRAL_REASON = 'No confirmed trend — skipping';

let lastScanResults = [];

export function getLastScanResults() {
  return lastScanResults;
}

function getWatchlist() {
  const raw = process.env.TV_WATCHLIST;
  if (!raw?.trim()) return DEFAULT_WATCHLIST;
  return raw.split(',').map((t) => t.trim()).filter(Boolean);
}

function toBrokerTicker(tvTicker) {
  if (tvTicker === 'AI') return 'C3.AI';
  if (tvTicker === '^VIX' || tvTicker === 'VIX') return 'VIX';
  return tvTicker;
}

function toTvSymbol(tvTicker) {
  return TV_SYMBOL_OVERRIDES[tvTicker] ?? tvTicker;
}

function hasTvSymbolOverride(tvTicker) {
  return Object.prototype.hasOwnProperty.call(TV_SYMBOL_OVERRIDES, tvTicker);
}

function getOverrideSymbolCandidates(tvTicker) {
  const primary = toTvSymbol(tvTicker);
  if (!hasTvSymbolOverride(tvTicker)) return [primary];

  const fallback = TV_SYMBOL_FALLBACKS[primary];
  return fallback && fallback !== primary ? [primary, fallback] : [primary];
}

function isOverrideRetryableFailure(payload) {
  const bars = normalizeBars(payload);
  if (bars.length === 0) return true;

  const summary = summarizeRawResponse(payload);
  if (summary.success !== false) return false;

  const err = String(summary.error ?? '');
  return (
    err.includes('chart may still be loading') ||
    err.includes('Could not extract OHLCV')
  );
}

async function loadDailyForSymbol(symbol) {
  await callTvTool('chart_set_symbol', { symbol });
  await callTvTool('chart_set_timeframe', { timeframe: 'D' });
  return callTvTool('data_get_ohlcv', { count: 250 });
}

async function loadIntradayBars() {
  await callTvTool('chart_set_timeframe', { timeframe: '1' });
  return callTvTool('data_get_ohlcv', { count: 400 });
}

async function resolveTvSymbolAndDaily(tvTicker) {
  const candidates = getOverrideSymbolCandidates(tvTicker);
  const attempts = [];

  for (let i = 0; i < candidates.length; i++) {
    const symbol = candidates[i];
    const dailyData = await loadDailyForSymbol(symbol);
    const daily = computeDailyMetrics(dailyData, tvTicker);
    const rawBars = normalizeBars(dailyData);
    const retryable = isOverrideRetryableFailure(dailyData);

    attempts.push({
      symbol,
      barsReturned: rawBars.length,
      completedBarsReturned: daily.barCount,
      retryableFailure: retryable,
      rawResponse: summarizeRawResponse(dailyData),
    });

    if (!daily.abort) {
      if (symbol !== candidates[0]) {
        console.log(
          `[tvScanner] ${tvTicker}: daily bars OK on fallback symbol ${symbol} (primary ${candidates[0]} failed)`
        );
      }
      return {
        tvSymbol: symbol,
        dailyData,
        daily,
        symbolResolution: { succeeded: symbol, attempts },
      };
    }

    if (retryable && i < candidates.length - 1) {
      console.warn(
        `[tvScanner] ${tvTicker}: ${symbol} daily fetch failed (retryable) — trying ${candidates[i + 1]}`
      );
      continue;
    }

    return {
      tvSymbol: symbol,
      dailyData,
      daily,
      symbolResolution: { succeeded: null, attempts },
    };
  }
}

function isVixTicker(tvTicker) {
  return tvTicker === '^VIX' || tvTicker === 'VIX';
}

function getEtDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hours: Number(get('hour')),
    minutes: Number(get('minute')),
  };
}

function barTimeMs(bar) {
  const t = bar.time ?? bar.t ?? bar.timestamp;
  if (t == null) return null;
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  const parsed = Date.parse(t);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeBars(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.bars)) return payload.bars;
  if (Array.isArray(payload.ohlcv)) return payload.ohlcv;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

const DAILY_MIN_COMPLETED_BARS = 10;
const INTRADAY_MIN_TODAY_BARS = 2;

function diagnosticTimestamp() {
  return new Date().toISOString();
}

function summarizeRawResponse(payload) {
  if (payload == null) return { empty: true };
  if (typeof payload !== 'object') return { type: typeof payload, value: payload };

  const bars = normalizeBars(payload);
  return {
    success: payload.success ?? (bars.length > 0 ? true : null),
    error: payload.error ?? null,
    hint: payload.hint ?? null,
    barCount: bars.length,
    keys: Object.keys(payload),
  };
}

function logBarFailureDiagnostic(details) {
  console.warn(`[tvScanner:diagnostic] ${JSON.stringify(details)}`);
}

function countTodayIntradayBars(intradayBars, now = new Date()) {
  const bars = normalizeBars(intradayBars);
  const et = getEtDateParts(now);
  return bars.filter((bar) => {
    const ms = barTimeMs(bar);
    return ms != null && isSameEtDay(ms, et);
  }).length;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function extractHighsLows(bars, count = 5) {
  const completed = bars.slice(0, -1);
  const slice = completed.slice(-count);
  return {
    highs: slice.map((b) => Number(b.high ?? b.h)).filter(Number.isFinite),
    lows: slice.map((b) => Number(b.low ?? b.l)).filter(Number.isFinite),
  };
}

function classifyTrend(highs, lows) {
  if (highs.length < 3 || lows.length < 3) return 'NEUTRAL';

  const h = highs.slice(-3);
  const l = lows.slice(-3);
  const upHighs = h[0] < h[1] && h[1] < h[2];
  const upLows = l[0] < l[1] && l[1] < l[2];
  const downHighs = h[0] > h[1] && h[1] > h[2];
  const downLows = l[0] > l[1] && l[1] > l[2];

  if (upHighs && upLows) return 'UPTREND';
  if (downHighs && downLows) return 'DOWNTREND';
  return 'NEUTRAL';
}

function computeRsi14(closes) {
  if (closes.length < 15) return null;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= 14; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= 14;
  avgLoss /= 14;

  for (let i = 15; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * 13 + gain) / 14;
    avgLoss = (avgLoss * 13 + loss) / 14;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function computeDailyMetrics(dailyBars, tvTicker) {
  const bars = normalizeBars(dailyBars);
  const completed = bars.slice(0, -1);

  if (completed.length < 10) {
    return { abort: true, barCount: completed.length };
  }

  const lastCompleted = completed[completed.length - 1];
  const prevDailyHigh = Number(lastCompleted.high ?? lastCompleted.h);
  const prevDailyLow = Number(lastCompleted.low ?? lastCompleted.l);
  const prevDailyClose = Number(lastCompleted.close ?? lastCompleted.c);

  const allCloses = completed
    .map((b) => Number(b.close ?? b.c))
    .filter((n) => Number.isFinite(n));

  let sma200 = null;
  let smaAvailable = false;

  if (allCloses.length >= 200) {
    sma200 = mean(allCloses.slice(-200));
    smaAvailable = true;
  } else if (allCloses.length >= 50) {
    sma200 = mean(allCloses);
    smaAvailable = false;
    console.warn(
      `[tvScanner] ${tvTicker}: only ${completed.length} daily bars returned — SMA gate skipped, continuing scan`
    );
  } else {
    smaAvailable = false;
    console.warn(
      `[tvScanner] ${tvTicker}: only ${completed.length} daily bars returned — SMA gate skipped, continuing scan`
    );
  }

  const rsiCloses = allCloses;
  const rsi14 = computeRsi14(rsiCloses);

  const volumes = completed
    .slice(-20)
    .map((b) => Number(b.volume ?? b.v))
    .filter((n) => Number.isFinite(n));
  const avgVolume20 = volumes.length ? mean(volumes) : 0;
  const currentVolume = Number(lastCompleted.volume ?? lastCompleted.v) || 0;

  const { highs: dailyHighs, lows: dailyLows } = extractHighsLows(bars, 5);
  const dailyTrend = classifyTrend(dailyHighs, dailyLows);

  return {
    prevDailyHigh,
    prevDailyLow,
    prevDailyClose,
    sma200,
    smaAvailable,
    dailyHighs,
    dailyLows,
    dailyTrend,
    rsi14,
    rsiOverbought: rsi14 != null && rsi14 > 70,
    rsiOversold: rsi14 != null && rsi14 < 30,
    currentVolume,
    avgVolume20,
    volumeConfirmed: avgVolume20 > 0 && currentVolume > avgVolume20,
  };
}

function computeWowMomentum(weeklyBars) {
  const completed = normalizeBars(weeklyBars).slice(0, -1);
  if (completed.length < 2) return 'flat';

  const thisWeek = completed[completed.length - 1];
  const lastWeek = completed[completed.length - 2];
  const thisRange =
    Number(thisWeek.high ?? thisWeek.h) - Number(thisWeek.low ?? thisWeek.l);
  const lastRange =
    Number(lastWeek.high ?? lastWeek.h) - Number(lastWeek.low ?? lastWeek.l);

  if (!Number.isFinite(thisRange) || !Number.isFinite(lastRange) || lastRange === 0) {
    return 'flat';
  }

  const ratio = thisRange / lastRange;
  if (ratio > 1.05) return 'expanding';
  if (ratio < 0.95) return 'contracting';
  return 'flat';
}

function isSameEtDay(barMs, et) {
  const barEt = getEtDateParts(new Date(barMs));
  return barEt.year === et.year && barEt.month === et.month && barEt.day === et.day;
}

function computeIntradayMetrics(intradayBars, now = new Date()) {
  const bars = normalizeBars(intradayBars);
  const et = getEtDateParts(now);
  const todayBars = bars.filter((bar) => {
    const ms = barTimeMs(bar);
    return ms != null && isSameEtDay(ms, et);
  });

  if (todayBars.length < 2) {
    throw new Error('Insufficient intraday bars for today');
  }

  const completed = todayBars.slice(0, -1);
  let pmh = -Infinity;
  let todayHod = -Infinity;

  for (const bar of completed) {
    const ms = barTimeMs(bar);
    const high = Number(bar.high ?? bar.h);
    if (!Number.isFinite(high) || ms == null) continue;

    const { hours, minutes } = getEtDateParts(new Date(ms));
    const timeDecimal = hours + minutes / 60;

    if (timeDecimal >= 4 && timeDecimal < 9.5) {
      pmh = Math.max(pmh, high);
    }
    if (timeDecimal >= 9.5) {
      todayHod = Math.max(todayHod, high);
    }
  }

  if (!Number.isFinite(pmh)) pmh = 0;
  if (!Number.isFinite(todayHod)) todayHod = 0;

  return { pmh, todayHod };
}

function extractQuotePrice(quote) {
  if (quote == null) return null;
  if (typeof quote === 'number') return quote;
  const candidates = [
    quote.price,
    quote.last,
    quote.close,
    quote.curr_px,
    quote.lp,
    quote.bid,
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function evaluateBreakout(currPx, prevDailyHigh, prevDailyClose, sma200, pmh, todayHod, smaAvailable = true) {
  const smaGateOk = !smaAvailable || sma200 == null || prevDailyClose > sma200;
  const dailyBreakout = currPx > prevDailyHigh && smaGateOk;
  const intradayBreakout = currPx > pmh && currPx > todayHod;
  return { dailyBreakout, intradayBreakout };
}

function resolveCombinedTrend(dailyTrend, weeklyTrend) {
  if (dailyTrend === 'UPTREND' && weeklyTrend === 'UPTREND') return 'UPTREND';
  if (dailyTrend === 'DOWNTREND' && weeklyTrend === 'DOWNTREND') return 'DOWNTREND';
  return 'NEUTRAL';
}

function evaluateSignal(scan) {
  const {
    trend,
    dailyBreakout,
    intradayBreakout,
    rsi14,
    rsiOverbought,
  } = scan;

  if (trend === 'DOWNTREND') {
    return {
      fires: true,
      direction: 'PUT',
      signalType: 'tv_trend',
      confidence: 'HIGH',
      result: 'PASS',
      reason: PUT_REASON,
      signal: 'PUT',
    };
  }

  if (trend === 'UPTREND') {
    if (!dailyBreakout || !intradayBreakout) {
      return {
        fires: false,
        direction: null,
        signalType: 'tv_breakout',
        confidence: null,
        result: !dailyBreakout ? 'fail_daily' : 'fail_intraday',
        reason: NEUTRAL_REASON,
        signal: '—',
      };
    }

    if (rsiOverbought) {
      return {
        fires: false,
        direction: null,
        signalType: 'tv_breakout',
        confidence: null,
        result: 'skipped_overbought',
        reason: `Uptrend confirmed but RSI overbought (${rsi14?.toFixed(1)}) — skipping`,
        signal: '—',
      };
    }

    return {
      fires: true,
      direction: 'CALL',
      signalType: 'tv_breakout',
      confidence: 'HIGH',
      result: 'PASS',
      reason: CALL_REASON,
      signal: 'CALL',
    };
  }

  return {
    fires: false,
    direction: null,
    signalType: 'tv_breakout',
    confidence: null,
    result: 'neutral',
    reason: NEUTRAL_REASON,
    signal: '—',
  };
}

function buildScanRecord(scan, evaluation) {
  return {
    ticker: scan.brokerTicker,
    tv_ticker: scan.tvTicker,
    signalType: evaluation.signalType,
    direction: evaluation.direction,
    confidence: evaluation.confidence,
    reason: evaluation.reason,
    result: evaluation.result,
    signal: evaluation.signal,

    curr_px: scan.currPx,
    prev_daily_high: scan.prevDailyHigh,
    prev_daily_low: scan.prevDailyLow,
    sma200: scan.sma200,
    pmh: scan.pmh,
    today_hod: scan.todayHod,

    trend: scan.trend,
    daily_trend: scan.dailyTrend,
    weekly_trend: scan.weeklyTrend,
    daily_highs: scan.dailyHighs,
    daily_lows: scan.dailyLows,
    weekly_highs: scan.weeklyHighs,
    weekly_lows: scan.weeklyLows,

    wow_momentum: scan.wowMomentum,

    rsi14: scan.rsi14,
    rsi_overbought: scan.rsiOverbought,
    rsi_oversold: scan.rsiOversold,

    current_volume: scan.currentVolume,
    avg_volume_20: scan.avgVolume20,
    volume_confirmed: scan.volumeConfirmed,

    isVix: scan.isVix,
  };
}

async function scanTicker(tvTicker) {
  const {
    tvSymbol,
    daily,
    symbolResolution,
  } = await resolveTvSymbolAndDaily(tvTicker);

  if (daily.abort) {
    const lastAttempt = symbolResolution.attempts[symbolResolution.attempts.length - 1];
    logBarFailureDiagnostic({
      failure: 'insufficient_daily_bars',
      timestamp: diagnosticTimestamp(),
      ticker: tvTicker,
      symbolSent: lastAttempt?.symbol ?? tvSymbol,
      symbolResolution,
      barsReturned: lastAttempt?.barsReturned ?? 0,
      completedBarsReturned: daily.barCount,
      barsRequired: DAILY_MIN_COMPLETED_BARS,
      timeframe: 'D',
      lookback: { count: 250 },
      rawResponse: lastAttempt?.rawResponse ?? null,
    });
    console.warn(
      `[tvScanner] ${tvTicker}: only ${daily.barCount} daily bars returned — skipping ticker`
    );
    return { skipped: true, barCount: daily.barCount };
  }

  let weeklyHighs = [];
  let weeklyLows = [];
  let weeklyTrend = 'NEUTRAL';
  let wowMomentum = 'flat';

  try {
    await callTvTool('chart_set_timeframe', { timeframe: 'W' });
    const weeklyData = await callTvTool('data_get_ohlcv', { count: 10 });
    const weeklyBars = normalizeBars(weeklyData);
    const completedWeekly = weeklyBars.slice(0, -1);

    if (completedWeekly.length < 3) {
      console.warn(
        `[tvScanner] ${tvTicker}: only ${completedWeekly.length} weekly bars returned — weekly trend set to NEUTRAL`
      );
      weeklyTrend = 'NEUTRAL';
    } else {
      const weekly = extractHighsLows(weeklyBars, 5);
      weeklyHighs = weekly.highs;
      weeklyLows = weekly.lows;
      weeklyTrend = classifyTrend(weeklyHighs, weeklyLows);
      wowMomentum = computeWowMomentum(weeklyBars);
    }
  } catch (err) {
    console.warn(`[tvScanner] Weekly fetch failed for ${tvTicker}:`, err.message);
  }

  const quote = await callTvTool('quote_get', { symbol: tvSymbol });
  const currPx = extractQuotePrice(quote);
  if (currPx == null) {
    throw new Error('quote_get returned no price');
  }

  let activeSymbol = tvSymbol;
  let intradayData = await loadIntradayBars();
  let pmh;
  let todayHod;
  let intradaySymbolResolution = { succeeded: activeSymbol, attempts: [] };

  const logIntradayFailure = (data, resolution) => {
    const rawBars = normalizeBars(data);
    logBarFailureDiagnostic({
      failure: 'insufficient_intraday_bars',
      timestamp: diagnosticTimestamp(),
      ticker: tvTicker,
      symbolSent: activeSymbol,
      symbolResolution: resolution,
      barsReturned: rawBars.length,
      todayBarsReturned: countTodayIntradayBars(data),
      barsRequired: INTRADAY_MIN_TODAY_BARS,
      timeframe: '1',
      lookback: { count: 400 },
      rawResponse: summarizeRawResponse(data),
    });
  };

  try {
    ({ pmh, todayHod } = computeIntradayMetrics(intradayData));
    intradaySymbolResolution.attempts.push({
      symbol: activeSymbol,
      barsReturned: normalizeBars(intradayData).length,
      todayBarsReturned: countTodayIntradayBars(intradayData),
      succeeded: true,
    });
  } catch (err) {
    if (err.message !== 'Insufficient intraday bars for today') throw err;

    const primary = toTvSymbol(tvTicker);
    const fallback = TV_SYMBOL_FALLBACKS[primary];
    const retryable = isOverrideRetryableFailure(intradayData);

    intradaySymbolResolution.attempts.push({
      symbol: activeSymbol,
      barsReturned: normalizeBars(intradayData).length,
      todayBarsReturned: countTodayIntradayBars(intradayData),
      retryableFailure: retryable,
      rawResponse: summarizeRawResponse(intradayData),
    });

    if (
      hasTvSymbolOverride(tvTicker) &&
      activeSymbol === primary &&
      fallback &&
      retryable
    ) {
      console.warn(
        `[tvScanner] ${tvTicker}: ${activeSymbol} intraday fetch failed (retryable) — trying ${fallback}`
      );
      activeSymbol = fallback;
      await callTvTool('chart_set_symbol', { symbol: fallback });
      intradayData = await loadIntradayBars();

      try {
        ({ pmh, todayHod } = computeIntradayMetrics(intradayData));
        intradaySymbolResolution.succeeded = fallback;
        intradaySymbolResolution.attempts.push({
          symbol: fallback,
          barsReturned: normalizeBars(intradayData).length,
          todayBarsReturned: countTodayIntradayBars(intradayData),
          succeeded: true,
        });
        console.log(
          `[tvScanner] ${tvTicker}: intraday bars OK on fallback symbol ${fallback}`
        );
      } catch (retryErr) {
        if (retryErr.message !== 'Insufficient intraday bars for today') throw retryErr;

        intradaySymbolResolution.succeeded = null;
        intradaySymbolResolution.attempts.push({
          symbol: fallback,
          barsReturned: normalizeBars(intradayData).length,
          todayBarsReturned: countTodayIntradayBars(intradayData),
          retryableFailure: isOverrideRetryableFailure(intradayData),
          rawResponse: summarizeRawResponse(intradayData),
        });
        logIntradayFailure(intradayData, {
          daily: symbolResolution,
          intraday: intradaySymbolResolution,
        });
        throw retryErr;
      }
    } else {
      intradaySymbolResolution.succeeded = null;
      logIntradayFailure(intradayData, {
        daily: symbolResolution,
        intraday: intradaySymbolResolution,
      });
      throw err;
    }
  }

  const { dailyBreakout, intradayBreakout } = evaluateBreakout(
    currPx,
    daily.prevDailyHigh,
    daily.prevDailyClose,
    daily.sma200,
    pmh,
    todayHod,
    daily.smaAvailable
  );

  const trend = resolveCombinedTrend(daily.dailyTrend, weeklyTrend);

  const scan = {
    tvTicker,
    brokerTicker: toBrokerTicker(tvTicker),
    isVix: isVixTicker(tvTicker),
    currPx,
    prevDailyHigh: daily.prevDailyHigh,
    prevDailyLow: daily.prevDailyLow,
    sma200: daily.sma200,
    pmh,
    todayHod,
    dailyBreakout,
    intradayBreakout,
    dailyHighs: daily.dailyHighs,
    dailyLows: daily.dailyLows,
    dailyTrend: daily.dailyTrend,
    weeklyHighs,
    weeklyLows,
    weeklyTrend,
    wowMomentum,
    rsi14: daily.rsi14,
    rsiOverbought: daily.rsiOverbought,
    rsiOversold: daily.rsiOversold,
    currentVolume: daily.currentVolume,
    avgVolume20: daily.avgVolume20,
    volumeConfirmed: daily.volumeConfirmed,
    trend,
  };

  const evaluation = evaluateSignal(scan);
  return { scan, evaluation };
}

export async function runScan() {
  let health;
  try {
    health = await callTvTool('tv_health_check', {});
  } catch (err) {
    console.error('[tvScanner] Health check error:', err.message);
    console.log('TradingView not connected — skipping scan');
    return { signals: [], offline: true, scanResults: lastScanResults };
  }

  if (
    health?.success === false ||
    health?.cdp_connected === false ||
    health?.api_available === false
  ) {
    const reason = health?.error || health?.hint || 'TradingView not connected';
    console.log(`[tvScanner] ${reason} — skipping scan`);
    return { signals: [], offline: true, scanResults: lastScanResults };
  }

  const watchlist = getWatchlist();
  const signals = [];
  const scanResults = [];

  for (const tvTicker of watchlist) {
    try {
      const tickerResult = await scanTicker(tvTicker);

      if (tickerResult?.skipped) {
        await logSignal({
          ticker: toBrokerTicker(tvTicker),
          signalType: 'tv_breakout',
          result: 'insufficient_bars',
          executed: false,
        });
        continue;
      }

      const { scan, evaluation } = tickerResult;
      const record = buildScanRecord(scan, evaluation);
      scanResults.push(record);

      await logSignal({
        ticker: scan.brokerTicker,
        signalType: evaluation.signalType,
        result: evaluation.result,
        direction: evaluation.direction,
        confidence: evaluation.confidence,
        executed: false,
      });

      if (evaluation.fires) {
        signals.push(record);
      }
    } catch (err) {
      console.error(`[tvScanner] Scan failed for ${tvTicker}:`, err.message);
      try {
        await logSignal({
          ticker: toBrokerTicker(tvTicker),
          signalType: 'tv_breakout',
          result: 'scan_error',
          executed: false,
        });
      } catch (logErr) {
        console.error(`[tvScanner] Failed to log signal for ${tvTicker}:`, logErr.message);
      }
    }
  }

  lastScanResults = scanResults;
  return { signals, offline: false, scanResults };
}
