import {
  getQuote,
  getHistoricalBars,
  getMarketStatus,
} from './tradierClient.js';
import { logSignal } from './db.js';
import { getWatchlist } from './config.js';

const CALL_REASON =
  'Uptrend confirmed (D+W) — breakout above prev daily high';
const PUT_REASON =
  'Downtrend confirmed (D+W) — lower highs and lower lows on daily and weekly';
const NEUTRAL_REASON = 'No confirmed trend — skipping';

let lastScanResults = [];

export function getLastScanResults() {
  return lastScanResults;
}

function isSkippedScanSymbol(symbol) {
  const upper = symbol.trim().toUpperCase();
  return upper === 'VIX' || upper === '^VIX';
}

function toBrokerTicker(symbol) {
  if (symbol === 'AI') return 'C3.AI';
  if (symbol === '^VIX' || symbol === 'VIX') return 'VIX';
  return symbol;
}

function toTradierSymbol(symbol) {
  if (symbol === 'C3.AI' || symbol === 'AI') return 'AI';
  if (symbol === '^VIX' || symbol === 'VIX') return 'VIX';
  return symbol;
}

function isVixTicker(symbol) {
  return symbol === '^VIX' || symbol === 'VIX';
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

function formatEtDate(date = new Date()) {
  const { year, month, day } = getEtDateParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shiftEtCalendarDate(date, deltaDays) {
  const { year, month, day } = getEtDateParts(date);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + deltaDays);
  return utc.toISOString().slice(0, 10);
}

function daysAgo(n, from = new Date()) {
  return shiftEtCalendarDate(from, -n);
}

function weeksAgo(n, from = new Date()) {
  return shiftEtCalendarDate(from, -(n * 7));
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function extractHighsLows(bars, count = 5) {
  const completed = bars.slice(0, -1);
  const slice = completed.slice(-count);
  return {
    highs: slice.map((b) => Number(b.high)).filter(Number.isFinite),
    lows: slice.map((b) => Number(b.low)).filter(Number.isFinite),
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

function computeDailyMetrics(dailyBars, symbol) {
  const bars = [...dailyBars].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const completed = bars.slice(0, -1);

  if (completed.length < 10) {
    return { abort: true, barCount: completed.length };
  }

  const lastCompleted = completed[completed.length - 1];
  const prevDailyHigh = Number(lastCompleted.high);
  const prevDailyLow = Number(lastCompleted.low);
  const prevDailyClose = Number(lastCompleted.close);

  const allCloses = completed.map((b) => Number(b.close)).filter(Number.isFinite);

  let sma200 = null;
  let smaAvailable = false;

  if (allCloses.length >= 200) {
    sma200 = mean(allCloses.slice(-200));
    smaAvailable = true;
  } else if (allCloses.length >= 50) {
    sma200 = mean(allCloses);
    smaAvailable = false;
    console.warn(
      `[cloudScanner] ${symbol}: only ${completed.length} daily bars returned — SMA gate skipped, continuing scan`
    );
  } else {
    smaAvailable = false;
    console.warn(
      `[cloudScanner] ${symbol}: only ${completed.length} daily bars returned — SMA gate skipped, continuing scan`
    );
  }

  const rsi14 = computeRsi14(allCloses);

  const volumes = completed
    .slice(-20)
    .map((b) => Number(b.volume))
    .filter((n) => Number.isFinite(n));
  const avgVolume20 = volumes.length ? mean(volumes) : 0;
  const currentVolume = Number(lastCompleted.volume) || 0;

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
  const bars = [...weeklyBars].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const completed = bars.slice(0, -1);
  if (completed.length < 2) return 'flat';

  const thisWeek = completed[completed.length - 1];
  const lastWeek = completed[completed.length - 2];
  const thisRange = Number(thisWeek.high) - Number(thisWeek.low);
  const lastRange = Number(lastWeek.high) - Number(lastWeek.low);

  if (!Number.isFinite(thisRange) || !Number.isFinite(lastRange) || lastRange === 0) {
    return 'flat';
  }

  const ratio = thisRange / lastRange;
  if (ratio > 1.05) return 'expanding';
  if (ratio < 0.95) return 'contracting';
  return 'flat';
}

function evaluateDailyBreakout(currPx, prevDailyHigh, prevDailyClose, sma200, smaAvailable = true) {
  const smaGateOk = !smaAvailable || sma200 == null || prevDailyClose > sma200;
  return currPx > prevDailyHigh && smaGateOk;
}

function resolveCombinedTrend(dailyTrend, weeklyTrend) {
  if (dailyTrend === 'UPTREND' && weeklyTrend === 'UPTREND') return 'UPTREND';
  if (dailyTrend === 'DOWNTREND' && weeklyTrend === 'DOWNTREND') return 'DOWNTREND';
  return 'NEUTRAL';
}

function evaluateSignal(scan) {
  const { trend, dailyBreakout, rsi14, rsiOverbought } = scan;

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
    if (!dailyBreakout) {
      return {
        fires: false,
        direction: null,
        signalType: 'tv_breakout',
        confidence: null,
        result: 'fail_daily',
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
    tv_ticker: scan.symbol,
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
    pmh: null,
    today_hod: null,

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

async function scanTicker(symbol) {
  const tradierSymbol = toTradierSymbol(symbol);
  const today = formatEtDate();

  const dailyBars = await getHistoricalBars(
    tradierSymbol,
    'daily',
    daysAgo(320),
    today
  );
  const daily = computeDailyMetrics(dailyBars, symbol);

  if (daily.abort) {
    console.warn(
      `[cloudScanner] ${symbol}: only ${daily.barCount} daily bars returned — skipping ticker`
    );
    return { skipped: true, barCount: daily.barCount };
  }

  let weeklyHighs = [];
  let weeklyLows = [];
  let weeklyTrend = 'NEUTRAL';
  let wowMomentum = 'flat';

  try {
    const weeklyBars = await getHistoricalBars(
      tradierSymbol,
      'weekly',
      weeksAgo(10),
      today
    );
    const completedWeekly = [...weeklyBars]
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(0, -1);

    if (completedWeekly.length < 3) {
      console.warn(
        `[cloudScanner] ${symbol}: only ${completedWeekly.length} weekly bars returned — weekly trend set to NEUTRAL`
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
    console.warn(`[cloudScanner] Weekly fetch failed for ${symbol}:`, err.message);
  }

  const quote = await getQuote(tradierSymbol);
  const currPx = Number(quote.last);
  if (!Number.isFinite(currPx)) {
    throw new Error('Tradier quote returned no price');
  }

  const currentVolume = Number.isFinite(quote.volume) ? quote.volume : daily.currentVolume;
  const volumeConfirmed =
    daily.avgVolume20 > 0 && currentVolume > daily.avgVolume20;

  const dailyBreakout = evaluateDailyBreakout(
    currPx,
    daily.prevDailyHigh,
    daily.prevDailyClose,
    daily.sma200,
    daily.smaAvailable
  );

  const trend = resolveCombinedTrend(daily.dailyTrend, weeklyTrend);

  const scan = {
    symbol,
    brokerTicker: toBrokerTicker(symbol),
    isVix: isVixTicker(symbol),
    currPx,
    prevDailyHigh: daily.prevDailyHigh,
    prevDailyLow: daily.prevDailyLow,
    sma200: daily.sma200,
    dailyBreakout,
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
    currentVolume,
    avgVolume20: daily.avgVolume20,
    volumeConfirmed,
    trend,
  };

  const evaluation = evaluateSignal(scan);
  return { scan, evaluation };
}

export async function runScan() {
  let status;
  try {
    status = await getMarketStatus();
  } catch (err) {
    console.error('[cloudScanner] Market status error:', err.message);
    return { signals: [], offline: true, scanResults: lastScanResults };
  }

  if (status.state !== 'open') {
    console.log('[cloudScanner] Market closed — skipping scan');
    return { signals: [], offline: false, scanResults: lastScanResults, marketClosed: true };
  }

  const watchlist = getWatchlist();
  const signals = [];
  const scanResults = [];

  for (const symbol of watchlist) {
    try {
      const tickerResult = await scanTicker(symbol);

      if (tickerResult?.skipped) {
        await logSignal({
          ticker: toBrokerTicker(symbol),
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
      console.warn(`[cloudScanner] Scan failed for ${symbol}:`, err.message);
      try {
        await logSignal({
          ticker: toBrokerTicker(symbol),
          signalType: 'tv_breakout',
          result: 'scan_error',
          executed: false,
        });
      } catch (logErr) {
        console.error(`[cloudScanner] Failed to log signal for ${symbol}:`, logErr.message);
      }
    }
  }

  lastScanResults = scanResults;
  return { signals, offline: false, scanResults };
}
