import {
  getQuote,
  getHistoricalBars,
  getOptionChain,
  getOptionExpirations,
} from './tradierClient.js';

const WATCHED_TICKERS = ['VIX', 'SOFI', 'C3.AI'];

function toTradierSymbol(ticker) {
  if (ticker === 'C3.AI') return 'AI';
  if (ticker === 'VIX') return 'VIX';
  return ticker;
}

let sessionToken = null;

function isPaperTrading() {
  return process.env.PAPER_TRADING !== 'false';
}

function isTastytradeSandbox() {
  return process.env.TASTYTRADE_SANDBOX !== 'false';
}

function getTastytradeBaseUrl() {
  return isTastytradeSandbox()
    ? 'https://api.cert.tastyworks.com'
    : 'https://api.tastyworks.com';
}

function getStrikeStep(ticker) {
  if (ticker === 'VIX') return 1;
  if (ticker === 'SOFI') return 0.5;
  return 1;
}

function parseNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function computeDte(expirationDate) {
  if (!expirationDate) return null;
  const exp = new Date(`${expirationDate}T16:00:00`);
  const now = new Date();
  return Math.floor((exp - now) / (1000 * 60 * 60 * 24));
}

function normalizeExpirationDate(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

function toTastytradeSymbol(ticker) {
  return toTradierSymbol(ticker);
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return formatDate(d);
}

// --- Tradier market data ---

export async function fetchQuote(ticker) {
  const symbol = toTradierSymbol(ticker);
  const quote = await getQuote(symbol);
  const today = formatDate(new Date());
  const bars = await getHistoricalBars(symbol, 'daily', daysAgo(90), today);
  const closes = bars.map((b) => b.close).filter(Number.isFinite);
  const recent = closes.slice(-20);

  return {
    ticker,
    price: quote.last,
    high20: recent.length ? Math.max(...recent) : quote.last,
    low20: recent.length ? Math.min(...recent) : quote.last,
    closes,
  };
}

function getBaseUrl() {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
}

// --- Tastytrade ---

async function tastytradeLogin() {
  const login = process.env.TASTYTRADE_USERNAME;
  const password = process.env.TASTYTRADE_PASSWORD;
  if (!login || !password) {
    throw new Error('TASTYTRADE_USERNAME and TASTYTRADE_PASSWORD are required for live trading');
  }

  const res = await fetch(`${getTastytradeBaseUrl()}/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ login, password }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('Tastytrade login failed:', errText);
    throw new Error(`Tastytrade login failed: ${res.status}`);
  }

  const json = await res.json();
  const token = json.data?.['session-token'] || json['session-token'];
  if (!token) throw new Error('Tastytrade login failed: no session token in response');
  sessionToken = token;
  return sessionToken;
}

async function tastytradeRequest(path, options = {}, retried = false) {
  if (!sessionToken) await tastytradeLogin();

  const res = await fetch(`${getTastytradeBaseUrl()}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${sessionToken}`,
      ...(options.headers || {}),
    },
  });

  if (res.status === 401 && !retried) {
    sessionToken = null;
    await tastytradeLogin();
    return tastytradeRequest(path, options, true);
  }

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Tastytrade API error ${options.method || 'GET'} ${path}:`, errText);
    throw new Error(`Tastytrade ${path} failed: ${res.status} ${errText}`);
  }

  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

async function tastytradeGetAccount() {
  if (process.env.TASTYTRADE_ACCOUNT_NUMBER) {
    return process.env.TASTYTRADE_ACCOUNT_NUMBER;
  }

  const json = await tastytradeRequest('/customers/me/accounts');
  const accounts = json?.data?.items || [];
  if (!accounts.length) throw new Error('No Tastytrade accounts found');

  const account = accounts[0];
  return account['account-number'] || account.account_number;
}

async function tastytradeFetchNestedChain(ticker) {
  const symbol = toTastytradeSymbol(ticker);
  return tastytradeRequest(`/option-chains/${encodeURIComponent(symbol)}/nested`);
}

function extractExpirations(chainJson) {
  const root = chainJson?.data?.items?.[0] || chainJson?.data || chainJson;
  return root?.expirations || [];
}

function extractStrikes(expiration) {
  return expiration?.strikes || [];
}

function readLegQuotes(strikeEntry, direction) {
  const side = direction === 'CALL' ? 'call' : 'put';
  const sideData = strikeEntry?.[side] || strikeEntry;

  const bid = parseNumber(
    sideData?.['bid-price'] ??
      sideData?.bid ??
      strikeEntry?.[`${side}-bid`] ??
      strikeEntry?.[`${side}-bid-price`]
  );
  const ask = parseNumber(
    sideData?.['ask-price'] ??
      sideData?.ask ??
      strikeEntry?.[`${side}-ask`] ??
      strikeEntry?.[`${side}-ask-price`]
  );
  const optionSymbol =
    sideData?.symbol ||
    strikeEntry?.[`${side}-symbol`] ||
    strikeEntry?.[`${side}-streamer-symbol`] ||
    strikeEntry?.symbol;

  const mid =
    bid != null && ask != null
      ? (bid + ask) / 2
      : parseNumber(sideData?.mid ?? sideData?.['mark-price'] ?? sideData?.mark);

  return { bid, ask, mid, optionSymbol };
}

function pickExpirationEntry(expirations, minDte = 21) {
  const enriched = expirations
    .map((exp) => {
      const expiration =
        normalizeExpirationDate(exp['expiration-date'] || exp.expiration_date || exp.expiration);
      const dte = parseNumber(exp['days-to-expiration'] ?? exp.days_to_expiration) ?? computeDte(expiration);
      return { exp, expiration, dte };
    })
    .filter((entry) => entry.expiration && (entry.dte == null || entry.dte >= minDte))
    .sort((a, b) => (a.dte ?? 9999) - (b.dte ?? 9999));

  return enriched[0] || null;
}

function findStrikeEntry(expirationEntry, targetStrike, direction) {
  const strikes = extractStrikes(expirationEntry.exp);
  let best = null;
  let bestDiff = Infinity;

  for (const strikeEntry of strikes) {
    const strike = parseNumber(strikeEntry['strike-price'] ?? strikeEntry.strike_price ?? strikeEntry.strike);
    if (strike == null) continue;

    const diff = Math.abs(strike - targetStrike);
    if (diff < bestDiff) {
      const quotes = readLegQuotes(strikeEntry, direction);
      if (quotes.optionSymbol || quotes.mid != null || quotes.bid != null) {
        best = { strikeEntry, strike, ...quotes };
        bestDiff = diff;
      }
    }
  }

  return best;
}

async function tastytradeGetOptionChain(ticker, direction, spotPrice) {
  const price = spotPrice ?? (await fetchQuote(ticker)).price;
  const step = getStrikeStep(ticker);
  const atm = Math.round(price / step) * step;
  const targetStrike = direction === 'CALL' ? atm + step : atm - step;

  const chainJson = await tastytradeFetchNestedChain(ticker);
  const expirations = extractExpirations(chainJson);
  const expirationEntry = pickExpirationEntry(expirations);
  if (!expirationEntry) throw new Error(`No Tastytrade expiration with DTE >= 21 for ${ticker}`);

  const strikeMatch = findStrikeEntry(expirationEntry, targetStrike, direction);
  if (!strikeMatch?.optionSymbol) {
    throw new Error(`No Tastytrade option found for ${ticker} ${direction} @ ${targetStrike}`);
  }

  const premium = strikeMatch.mid ?? strikeMatch.bid ?? strikeMatch.ask;
  if (premium == null) throw new Error(`No quote for ${ticker} ${direction} option`);

  return {
    symbol: toTastytradeSymbol(ticker),
    expiration: expirationEntry.expiration,
    strike: strikeMatch.strike,
    optionSymbol: strikeMatch.optionSymbol,
    bid: strikeMatch.bid,
    ask: strikeMatch.ask,
    mid: premium,
  };
}

async function tastytradeFindOption(ticker, direction, strike, expiration) {
  const chainJson = await tastytradeFetchNestedChain(ticker);
  const expirations = extractExpirations(chainJson);
  const targetExp = normalizeExpirationDate(expiration);

  const expirationEntry = expirations
    .map((exp) => ({
      exp,
      expiration: normalizeExpirationDate(exp['expiration-date'] || exp.expiration_date || exp.expiration),
    }))
    .find((entry) => entry.expiration === targetExp);

  if (!expirationEntry) return null;

  const strikeMatch = findStrikeEntry(
    { exp: expirationEntry.exp, expiration: expirationEntry.expiration },
    strike,
    direction
  );
  if (!strikeMatch) return null;

  const premium = strikeMatch.mid ?? strikeMatch.bid ?? strikeMatch.ask;
  return {
    symbol: toTastytradeSymbol(ticker),
    expiration: expirationEntry.expiration,
    strike: strikeMatch.strike,
    optionSymbol: strikeMatch.optionSymbol,
    bid: strikeMatch.bid,
    ask: strikeMatch.ask,
    mid: premium,
  };
}

async function tastytradeSubmitOrder({ accountNumber, optionSymbol, quantity, price, action }) {
  const body = {
    'order-type': 'Limit',
    'time-in-force': 'Day',
    price: String(price),
    'price-effect': action.includes('Buy') ? 'Debit' : 'Credit',
    legs: [
      {
        'instrument-type': 'Equity Option',
        symbol: optionSymbol,
        quantity,
        action,
      },
    ],
  };

  const json = await tastytradeRequest(`/accounts/${accountNumber}/orders`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const order = json?.data?.order || json?.data || json;
  const orderId = order?.id || order?.['order-id'] || order?.order_id;
  if (!orderId) throw new Error('Tastytrade order submitted but no order ID returned');
  return String(orderId);
}

async function tastytradeClosePosition(position, exitPremium) {
  const accountNumber = await tastytradeGetAccount();
  const option =
    (await tastytradeFindOption(
      position.ticker,
      position.direction,
      position.strike,
      position.expiration
    )) || (await tastytradeGetOptionChain(position.ticker, position.direction));

  const price = exitPremium ?? option.mid;
  if (price == null) throw new Error('No exit price available for close order');

  const orderId = await tastytradeSubmitOrder({
    accountNumber,
    optionSymbol: option.optionSymbol,
    quantity: position.quantity,
    price,
    action: 'Sell to Close',
  });

  return { orderId, paper: false };
}

export async function tastytradeGetPositions() {
  const accountNumber = await tastytradeGetAccount();
  const json = await tastytradeRequest(`/accounts/${accountNumber}/positions`);
  const items = json?.data?.items || [];

  return items
    .filter((p) => (p['instrument-type'] || p.instrument_type || '').includes('Option'))
    .map((p) => ({
      symbol: p.symbol,
      quantity: parseNumber(p.quantity),
      'average-open-price': parseNumber(p['average-open-price'] ?? p.average_open_price),
      'cost-basis': parseNumber(p['cost-basis'] ?? p.cost_basis),
      'instrument-type': p['instrument-type'] || p.instrument_type,
    }));
}

// --- Schwab [DISABLED] ---

// import { getOAuthToken, saveOAuthToken } from './db.js';

// [SCHWAB DISABLED]
export function getSchwabAuthUrl() {
  throw new Error('Schwab OAuth disabled — using Tastytrade');
}

// [SCHWAB DISABLED]
export async function exchangeSchwabCode() {
  throw new Error('Schwab OAuth disabled — using Tastytrade');
}

// [SCHWAB DISABLED]
// async function getSchwabAccessToken() { ... }
// async function refreshSchwabToken(refreshToken) { ... }
// async function placeSchwabOrder(order) { ... }

export function getEtradeAuthUrl() {
  const callback = encodeURIComponent(
    process.env.ETRADE_REDIRECT_URI || `${getBaseUrl()}/auth/etrade/callback`
  );
  return `https://us.etrade.com/e/t/etws/authorize?key=${process.env.ETRADE_CONSUMER_KEY}&token=REQUEST_TOKEN&callback=${callback}`;
}

async function tradierPickExpiration(ticker, minDte = 21) {
  const symbol = toTradierSymbol(ticker);
  const expirations = await getOptionExpirations(symbol);
  const now = new Date();

  const valid = expirations
    .map((expiration) => {
      const exp = new Date(`${expiration}T16:00:00`);
      const dte = Math.floor((exp - now) / (1000 * 60 * 60 * 24));
      return { expiration, dte };
    })
    .filter((entry) => entry.dte >= minDte)
    .sort((a, b) => a.dte - b.dte);

  return valid[0]?.expiration || null;
}

async function tradierGetOptionChain(ticker, direction, spotPrice) {
  const symbol = toTradierSymbol(ticker);
  const price = spotPrice ?? (await fetchQuote(ticker)).price;
  const step = getStrikeStep(ticker);
  const atm = Math.round(price / step) * step;
  const targetStrike = direction === 'CALL' ? atm + step : atm - step;
  const expiration = await tradierPickExpiration(ticker);
  if (!expiration) throw new Error(`No Tradier expiration with DTE >= 21 for ${ticker}`);

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

  if (!best) throw new Error(`No Tradier option found for ${ticker} ${direction} @ ${targetStrike}`);

  const premium = best.mid ?? best.bid ?? best.ask;
  if (premium == null) throw new Error(`No Tradier quote for ${ticker} ${direction} option`);

  return {
    symbol,
    expiration,
    strike: best.strike,
    optionSymbol: best.symbol,
    bid: best.bid,
    ask: best.ask,
    mid: premium,
  };
}

async function tradierFindOption(ticker, direction, strike, expiration) {
  const symbol = toTradierSymbol(ticker);
  const chain = await getOptionChain(symbol, expiration);
  const optionType = direction === 'CALL' ? 'call' : 'put';

  const match = chain.find(
    (option) =>
      (option.option_type || '').toLowerCase() === optionType &&
      Math.abs(option.strike - strike) < 0.01
  );

  if (!match) return null;

  const premium = match.mid ?? match.bid ?? match.ask;
  return {
    symbol,
    expiration,
    strike: match.strike,
    optionSymbol: match.symbol,
    bid: match.bid,
    ask: match.ask,
    mid: premium,
  };
}

// --- Options pricing ---

export async function fetchOptionChain(ticker) {
  try {
    const quote = await fetchQuote(ticker);
    const callChain = await tastytradeGetOptionChain(ticker, 'CALL', quote.price);
    const putChain = await tastytradeGetOptionChain(ticker, 'PUT', quote.price);
    return [
      {
        ticker,
        direction: 'CALL',
        strike: callChain.strike,
        expiration: callChain.expiration,
        premium: callChain.mid,
      },
      {
        ticker,
        direction: 'PUT',
        strike: putChain.strike,
        expiration: putChain.expiration,
        premium: putChain.mid,
      },
    ];
  } catch (err) {
    console.warn(`[brokerageConnector] Tastytrade chain unavailable for ${ticker}, using Tradier:`, err.message);
    const quote = await fetchQuote(ticker);
    const callChain = await tradierGetOptionChain(ticker, 'CALL', quote.price);
    const putChain = await tradierGetOptionChain(ticker, 'PUT', quote.price);
    return [
      {
        ticker,
        direction: 'CALL',
        strike: callChain.strike,
        expiration: callChain.expiration,
        premium: callChain.mid,
      },
      {
        ticker,
        direction: 'PUT',
        strike: putChain.strike,
        expiration: putChain.expiration,
        premium: putChain.mid,
      },
    ];
  }
}

export async function findMonthlyExpiration(ticker) {
  const expiration = await tradierPickExpiration(ticker);
  if (expiration) return expiration;

  const now = new Date();
  const minDate = new Date(now);
  minDate.setDate(now.getDate() + 21);

  for (let monthsAhead = 0; monthsAhead <= 3; monthsAhead++) {
    const target = new Date(now.getFullYear(), now.getMonth() + monthsAhead + 1, 0);
    if (target >= minDate) {
      return target.toISOString().slice(0, 10);
    }
  }

  const fallback = new Date(now);
  fallback.setDate(fallback.getDate() + 30);
  return fallback.toISOString().slice(0, 10);
}

export async function getOptionPremium(ticker, direction, strike, expiration) {
  if (!isPaperTrading() && process.env.TASTYTRADE_USERNAME) {
    try {
      const option = await tastytradeFindOption(ticker, direction, strike, expiration);
      if (option?.mid != null) return option.mid;
      if (option?.bid != null && option?.ask != null) return (option.bid + option.ask) / 2;
    } catch (err) {
      console.warn(`[brokerageConnector] Live premium lookup failed for ${ticker}:`, err.message);
    }
  }

  try {
    const option = await tradierFindOption(ticker, direction, strike, expiration);
    if (option?.mid != null) return option.mid;
    if (option?.bid != null && option?.ask != null) return (option.bid + option.ask) / 2;
  } catch (err) {
    console.warn(`[brokerageConnector] Tradier premium lookup failed for ${ticker}:`, err.message);
  }

  try {
    const chain = await fetchOptionChain(ticker);
    const match = chain.find(
      (o) =>
        o.direction === direction &&
        Math.abs(o.strike - strike) < 0.01 &&
        o.expiration === expiration
    );
    if (match) return match.premium;
  } catch {
    // fall through
  }

  const quote = await fetchQuote(ticker);
  return estimatePremium(ticker, direction, strike, quote.price);
}

function estimatePremium(ticker, direction, strike, spotPrice) {
  const base = ticker === 'VIX' ? 3.5 : ticker === 'SOFI' ? 1.2 : 2.0;
  const itm = direction === 'CALL' ? spotPrice > strike : spotPrice < strike;
  const otmDistance = Math.abs(spotPrice - strike) / spotPrice;
  return Math.max(0.15, base * (itm ? 1.2 : 1.0) * (1 + otmDistance));
}

function buildOccSymbol(symbol, expiration, direction, strike) {
  const exp = expiration.replace(/-/g, '').slice(2);
  const type = direction === 'CALL' ? 'C' : 'P';
  const strikeStr = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${symbol}${exp}${type}${strikeStr}`;
}

export async function placeOptionOrder({ ticker, direction, strike, expiration, quantity, premium, broker = 'tastytrade' }) {
  const order = {
    symbol: toTastytradeSymbol(ticker),
    direction,
    strike,
    expiration,
    quantity,
    premium,
    broker,
    totalCost: premium * quantity * 100,
  };

  if (isPaperTrading()) {
    console.log('[PAPER] Order would be placed:', order);
    return { orderId: `PAPER-${Date.now()}`, paper: true, status: 'paper', ...order };
  }

  const accountNumber = await tastytradeGetAccount();
  let option = await tastytradeFindOption(ticker, direction, strike, expiration);

  if (!option?.optionSymbol) {
    try {
      const quote = await fetchQuote(ticker);
      option = await tastytradeGetOptionChain(ticker, direction, quote.price);
    } catch (err) {
      console.warn(`[brokerageConnector] Chain lookup failed for order, using OCC fallback:`, err.message);
      option = {
        optionSymbol: buildOccSymbol(order.symbol, expiration, direction, strike),
        mid: premium,
      };
    }
  }

  const limitPrice = option.mid ?? premium;
  const orderId = await tastytradeSubmitOrder({
    accountNumber,
    optionSymbol: option.optionSymbol,
    quantity,
    price: limitPrice,
    action: 'Buy to Open',
  });

  return { orderId, paper: false, broker: 'tastytrade', ...order, premium: limitPrice };
}

async function placeEtradeOrder() {
  throw new Error('E*Trade live order placement requires full OAuth 1.0a signing — use Tastytrade or paper mode');
}

export async function closeOptionOrder(position, exitPremium) {
  if (isPaperTrading()) {
    console.log(`[PAPER] Close position #${position.id} @ $${exitPremium}`);
    return { orderId: `PAPER-CLOSE-${Date.now()}`, paper: true, status: 'paper' };
  }

  return tastytradeClosePosition(position, exitPremium);
}

export { WATCHED_TICKERS, isPaperTrading };
