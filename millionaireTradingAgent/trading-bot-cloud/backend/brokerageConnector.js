import {
  getQuote,
  getHistoricalBars,
  getOptionChain,
  getOptionExpirations,
} from './tradierClient.js';
import { getPublicBaseUrl } from './config.js';
import {
  formatOptionPriceForApi,
  optionPriceIncrement,
  underlyingFromOptionSymbol,
} from './optionPriceIncrement.js';
import { computeTradableCashBalance } from './budget/tradableCash.js';
import { isLadderBrokerStopEnabledForStrategy } from './ladder/ladderConfig.js';
import {
  buildOtoEntryStopBody,
  parsePlacedComplexOrder,
  otoFallbackReason,
} from './ladder/otoEntryStop.js';
import {
  bookedEntryQuantity,
  entryHasBrokerLong,
  fillPollShouldReturn,
  hasConfirmedFillPrice,
  isBrokerOrderGoneError,
  isCancelConfirmed,
  isConfirmedCancelledStatus,
  isConfirmedRestingStop,
  normalizeOrderStatus,
  stopQuantityFromStatus,
} from './ladder/orderFillStatus.js';
import {
  fillBasedStopParams,
  finalizeOtoPartialFill,
  restingStopIdAfterAlign,
} from './ladder/otoStopQuantity.js';
import {
  brokerQtyForOcc,
  latestSellToCloseFromTransactions,
  occForDbPosition,
} from './recon/positionMatch.js';
import { etDateKey } from './orb/tradierTimesales.js';

const WATCHED_TICKERS = ['VIX', 'SOFI', 'C3.AI'];

/** Exact-expiration nested-chain miss in placeOptionOrder — fallback may still run. */
export const FIND_OPTION_MISS_REASON = 'find_option_expiration_miss';
/** Resolved OCC expiration ≠ requested expiration — entry must not be submitted. */
export const EXPIRATION_MISMATCH_BLOCKED_REASON = 'expiration_mismatch_blocked';

function toTradierSymbol(ticker) {
  if (ticker === 'C3.AI') return 'AI';
  if (ticker === 'VIX') return 'VIX';
  return ticker;
}

// Legacy module-level token unused — sandbox/live use paperSessionToken/liveSessionToken.
const liveSessionToken = { value: null, expiresAt: null };
const paperSessionToken = { value: null, expiresAt: null };

const DEFAULT_TASTYTRADE_OAUTH_SCOPES = 'read trade';
const OAUTH_TOKEN_EXPIRY_BUFFER_MS = 30_000;
// Tastytrade docs: missing/malformed User-Agent (<product>/<version>) can yield 401.
const TASTYTRADE_USER_AGENT = 'trading-bot-cloud/1.0';

function usesOAuth(credentials) {
  const clientSecret = String(credentials?.clientSecret || '').trim();
  const refreshToken = String(credentials?.refreshToken || '').trim();
  return !!(clientSecret && refreshToken);
}

function isAccessTokenExpired(sessionRef) {
  if (!sessionRef?.value) return true;
  if (!sessionRef.expiresAt) return false;
  return Date.now() >= sessionRef.expiresAt;
}

function clearSessionRef(sessionRef) {
  sessionRef.value = null;
  sessionRef.expiresAt = null;
}

function normalizeOrderEnvironment(environment) {
  return String(environment || '').toLowerCase() === 'live' ? 'live' : 'paper';
}

function getPaperBrokerCredentials() {
  return {
    username: process.env.TASTYTRADE_USERNAME,
    password: process.env.TASTYTRADE_PASSWORD,
    accountNumber: process.env.TASTYTRADE_ACCOUNT_NUMBER,
    clientId: process.env.TASTYTRADE_SANDBOX_CLIENT_ID,
    clientSecret: process.env.TASTYTRADE_SANDBOX_CLIENT_SECRET,
    refreshToken: process.env.TASTYTRADE_SANDBOX_REFRESH_TOKEN,
    oauthScopes: process.env.TASTYTRADE_OAUTH_SCOPES || DEFAULT_TASTYTRADE_OAUTH_SCOPES,
    token: null,
    sandbox: process.env.TASTYTRADE_SANDBOX !== 'false',
  };
}

function getLiveBrokerCredentials() {
  return {
    username: process.env.TASTYTRADE_LIVE_USERNAME,
    password: process.env.TASTYTRADE_LIVE_PASSWORD,
    accountNumber:
      process.env.TASTYTRADE_LIVE_ACCOUNT_NUMBER || process.env.TASTYTRADE_LIVE_ACCOUNT,
    // Live OAuth (preferred — same scheme as sandbox / Tastytrade SDK)
    clientId: process.env.TASTYTRADE_LIVE_CLIENT_ID,
    clientSecret: process.env.TASTYTRADE_LIVE_CLIENT_SECRET,
    refreshToken: process.env.TASTYTRADE_LIVE_REFRESH_TOKEN,
    oauthScopes: process.env.TASTYTRADE_OAUTH_SCOPES || DEFAULT_TASTYTRADE_OAUTH_SCOPES,
    // Legacy fallbacks (session token or username/password)
    token: process.env.TASTYTRADE_LIVE_TOKEN,
    sandbox: false,
  };
}

export function hasLiveCredentialsConfigured() {
  const creds = getLiveBrokerCredentials();
  const account = String(creds.accountNumber || '').trim();
  if (!account) return false;
  const token = String(creds.token || '').trim();
  const username = String(creds.username || '').trim();
  const password = String(creds.password || '').trim();
  return !!(usesOAuth(creds) || token || (username && password));
}

function assertLiveCredentialsForStrategy(strategy) {
  if (hasLiveCredentialsConfigured()) return;
  const label = strategy || 'unknown';
  const message =
    `[BrokerageConnector] LIVE order blocked: no live credentials configured for ${label}. ` +
    'Set TASTYTRADE_LIVE_ACCOUNT_NUMBER plus OAuth ' +
    '(TASTYTRADE_LIVE_CLIENT_SECRET + TASTYTRADE_LIVE_REFRESH_TOKEN), ' +
    'or TASTYTRADE_LIVE_TOKEN, or TASTYTRADE_LIVE_USERNAME/PASSWORD.';
  console.error(message);
  throw new Error(message);
}

function getTastytradeBaseUrlForCredentials(credentials) {
  return credentials.sandbox
    ? 'https://api.cert.tastyworks.com'
    : 'https://api.tastyworks.com';
}

async function tastytradeOAuthRefreshWithCredentials(credentials, sessionRef) {
  const refreshToken = String(credentials.refreshToken || '').trim();
  const clientSecret = String(credentials.clientSecret || '').trim();
  const clientId = String(credentials.clientId || '').trim();
  if (!refreshToken || !clientSecret) {
    throw new Error('Tastytrade OAuth requires client secret and refresh token');
  }

  const isLive = credentials.sandbox === false;
  const url = `${getTastytradeBaseUrlForCredentials(credentials)}/oauth/token`;
  // Tastytrade docs: missing/malformed User-Agent (<product>/<version>) can yield 401.
  const headers = {
    Accept: 'application/json',
    'User-Agent': TASTYTRADE_USER_AGENT,
  };
  let body;

  if (isLive) {
    // Production: RFC 6749 expects application/x-www-form-urlencoded (not JSON).
    // Variant controlled by TASTYTRADE_LIVE_OAUTH_BASIC_AUTH=true|false (default: body credentials only).
    if (!clientId) {
      throw new Error('Tastytrade live OAuth requires TASTYTRADE_LIVE_CLIENT_ID');
    }
    const scope = String(credentials.oauthScopes || DEFAULT_TASTYTRADE_OAUTH_SCOPES).trim();
    const useBasicAuth = process.env.TASTYTRADE_LIVE_OAUTH_BASIC_AUTH === 'true';
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const form = new URLSearchParams();
    form.set('grant_type', 'refresh_token');
    form.set('refresh_token', refreshToken);
    form.set('scope', scope);
    if (useBasicAuth) {
      // Variant 2: form body + HTTP Basic Auth (client_id/secret in header, not body)
      headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
    } else {
      // Variant 1 (default): client credentials in the form body
      form.set('client_id', clientId);
      form.set('client_secret', clientSecret);
    }
    body = form.toString();
  } else {
    // Sandbox/cert: unchanged — client credentials in JSON body (known-working).
    headers['Content-Type'] = 'application/json';
    const jsonBody = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_secret: clientSecret,
      scope: String(credentials.oauthScopes || DEFAULT_TASTYTRADE_OAUTH_SCOPES).trim(),
    };
    if (clientId) {
      jsonBody.client_id = clientId;
    }
    body = JSON.stringify(jsonBody);
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body,
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('Tastytrade OAuth token refresh failed:', errText);
    throw new Error(`Tastytrade OAuth token refresh failed: ${res.status} ${errText}`);
  }

  const json = await res.json();
  const data = json.data || json;
  const accessToken = data.access_token || data['access-token'];
  const expiresIn = Number(data.expires_in ?? data['expires-in'] ?? 900);
  if (!accessToken) {
    throw new Error('Tastytrade OAuth token refresh failed: no access_token in response');
  }

  sessionRef.value = accessToken;
  sessionRef.expiresAt = Date.now() + Math.max(0, expiresIn * 1000 - OAUTH_TOKEN_EXPIRY_BUFFER_MS);
  return sessionRef.value;
}

async function tastytradeLoginWithCredentials(credentials, sessionRef) {
  // Auth preference:
  // 1) OAuth refresh (preferred — matches sandbox / Tastytrade SDK; access tokens expire)
  // 2) Username/password session login (legacy live fallback)
  // 3) Static TASTYTRADE_LIVE_TOKEN last (often a short-lived access token that goes stale)
  if (usesOAuth(credentials)) {
    return tastytradeOAuthRefreshWithCredentials(credentials, sessionRef);
  }

  if (credentials.sandbox) {
    throw new Error(
      'Tastytrade sandbox requires OAuth2 (TASTYTRADE_SANDBOX_CLIENT_SECRET + TASTYTRADE_SANDBOX_REFRESH_TOKEN). See https://developer.tastytrade.com/oauth/'
    );
  }

  const login = credentials.username;
  const password = credentials.password;
  if (login && password) {
    const res = await fetch(`${getTastytradeBaseUrlForCredentials(credentials)}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': TASTYTRADE_USER_AGENT,
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
    sessionRef.value = token;
    sessionRef.expiresAt = null;
    return sessionRef.value;
  }

  if (credentials.token) {
    sessionRef.value = credentials.token;
    sessionRef.expiresAt = null;
    return sessionRef.value;
  }

  throw new Error(
    'Tastytrade credentials are required (OAuth client secret + refresh token, or username/password)'
  );
}

async function ensureTastytradeSession(credentials, sessionRef) {
  if (!sessionRef.value || (usesOAuth(credentials) && isAccessTokenExpired(sessionRef))) {
    await tastytradeLoginWithCredentials(credentials, sessionRef);
  }
  return sessionRef.value;
}

async function tastytradeRequestWithCredentials(credentials, sessionRef, path, options = {}, retried = false) {
  await ensureTastytradeSession(credentials, sessionRef);

  const mergedHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': TASTYTRADE_USER_AGENT,
    Authorization: `Bearer ${sessionRef.value}`,
    ...(options.headers || {}),
  };

  // SAFETY: X-Tastyworks-Validate-Only on POST /orders does NOT prevent real placement
  // (verified live — created resting order 488245407). Refuse rather than trust it.
  const validateOnlyHeader =
    mergedHeaders['X-Tastyworks-Validate-Only'] ??
    mergedHeaders['x-tastyworks-validate-only'];
  if (validateOnlyHeader != null && validateOnlyHeader !== '') {
    throw new Error(
      'REFUSED: X-Tastyworks-Validate-Only is unsafe and must not be used. ' +
        'Use POST /accounts/{account}/orders/dry-run for dry-runs.'
    );
  }

  const res = await fetch(`${getTastytradeBaseUrlForCredentials(credentials)}${path}`, {
    ...options,
    headers: mergedHeaders,
  });

  if (res.status === 401 && !retried) {
    clearSessionRef(sessionRef);
    await tastytradeLoginWithCredentials(credentials, sessionRef);
    return tastytradeRequestWithCredentials(credentials, sessionRef, path, options, true);
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

async function tastytradeGetAccountWithCredentials(credentials, sessionRef) {
  if (credentials.accountNumber) {
    return credentials.accountNumber;
  }

  const json = await tastytradeRequestWithCredentials(credentials, sessionRef, '/customers/me/accounts');
  const accounts = json?.data?.items || [];
  if (!accounts.length) throw new Error('No Tastytrade accounts found');

  const account = accounts[0];
  return account['account-number'] || account.account_number;
}

function getCredentialsForOrderEnvironment(environment) {
  const orderEnvironment = normalizeOrderEnvironment(environment);
  if (orderEnvironment === 'live') {
    return { credentials: getLiveBrokerCredentials(), sessionRef: liveSessionToken };
  }
  return { credentials: getPaperBrokerCredentials(), sessionRef: paperSessionToken };
}

function hasCredentialsForEnvironment(environment) {
  const { credentials } = getCredentialsForOrderEnvironment(environment);
  const token = String(credentials.token || '').trim();
  const username = String(credentials.username || '').trim();
  const password = String(credentials.password || '').trim();
  return !!(token || usesOAuth(credentials) || (username && password));
}

function extractOrderId(orderJson) {
  const order = orderJson?.data?.order || orderJson?.data || orderJson;
  const orderId = order?.id || order?.['order-id'] || order?.order_id;
  return orderId ? String(orderId) : null;
}


function buildStopOrderBody({
  optionSymbol,
  quantity,
  stopTrigger,
  limitPrice,
  orderType,
  includeLegs = true,
}) {
  const isStopLimit = orderType === 'stop_limit';
  const underlying = underlyingFromOptionSymbol(optionSymbol);
  const roundedTrigger = formatOptionPriceForApi(stopTrigger, { underlying });
  if (roundedTrigger == null) {
    throw new Error(`Invalid stop trigger after increment rounding: ${stopTrigger}`);
  }
  const body = {
    'order-type': isStopLimit ? 'Stop Limit' : 'Stop',
    // Stop Market equity options reject GTC/GTD on Tastytrade
    // (preflight tif_no_stop_market_gtc_options). Day is the valid TIF.
    // Stop Limit keeps GTC (not covered by that rejection code).
    'time-in-force': isStopLimit ? 'GTC' : 'Day',
    'stop-trigger': roundedTrigger,
    'price-effect': 'Credit',
  };

  if (includeLegs) {
    body.legs = [
      {
        'instrument-type': 'Equity Option',
        symbol: optionSymbol,
        quantity,
        action: 'Sell to Close',
      },
    ];
  }

  if (isStopLimit) {
    const rawLimit = limitPrice ?? stopTrigger;
    const roundedLimit = formatOptionPriceForApi(rawLimit, { underlying });
    if (roundedLimit == null) {
      throw new Error(`Invalid stop-limit price after increment rounding: ${rawLimit}`);
    }
    body.price = roundedLimit;
  }

  return body;
}

async function tastytradeSubmitStopOrderWithCredentials(
  credentials,
  sessionRef,
  { accountNumber, optionSymbol, quantity, stopTrigger, limitPrice, orderType, dryRun = false }
) {
  const body = buildStopOrderBody({
    optionSymbol,
    quantity,
    stopTrigger,
    limitPrice,
    orderType,
    includeLegs: true,
  });

  const path = dryRun
    ? `/accounts/${accountNumber}/orders/dry-run`
    : `/accounts/${accountNumber}/orders`;
  const json = await tastytradeRequestWithCredentials(
    credentials,
    sessionRef,
    path,
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  );

  if (dryRun) {
    return { dryRun: true, valid: true, body, response: json };
  }

  const orderId = extractOrderId(json);
  if (!orderId) throw new Error('Tastytrade stop order submitted but no order ID returned');
  return { orderId, body };
}

/**
 * Atomic live-order replace (Tastytrade PUT /accounts/{id}/orders/{orderId}).
 * Official tastyware SDK exclude={"legs"} — same contract, new trigger.
 * A fill on the original order aborts the replacement.
 */
async function tastytradeReplaceStopOrderWithCredentials(
  credentials,
  sessionRef,
  { accountNumber, existingOrderId, optionSymbol, quantity, stopTrigger, limitPrice, orderType }
) {
  if (!existingOrderId) throw new Error('replace stop requires existingOrderId');
  const body = buildStopOrderBody({
    optionSymbol,
    quantity,
    stopTrigger,
    limitPrice,
    orderType,
    includeLegs: false,
  });
  const json = await tastytradeRequestWithCredentials(
    credentials,
    sessionRef,
    `/accounts/${accountNumber}/orders/${existingOrderId}`,
    {
      method: 'PUT',
      body: JSON.stringify(body),
    }
  );
  const orderId = extractOrderId(json) || String(existingOrderId);
  return {
    orderId,
    replacesOrderId: String(existingOrderId),
    body,
    raw: json,
  };
}

async function tastytradeSubmitOtoEntryStopWithCredentials(
  credentials,
  sessionRef,
  {
    accountNumber,
    optionSymbol,
    quantity,
    entryPrice,
    stopTrigger,
    stopLimitPrice,
    stopOrderType,
    dryRun = false,
  }
) {
  const underlying = underlyingFromOptionSymbol(optionSymbol);
  const roundedEntry = formatOptionPriceForApi(entryPrice, { underlying });
  const roundedTrigger = formatOptionPriceForApi(stopTrigger, { underlying });
  if (roundedEntry == null) throw new Error(`Invalid OTO entry price after rounding: ${entryPrice}`);
  if (roundedTrigger == null) throw new Error(`Invalid OTO stop trigger after rounding: ${stopTrigger}`);

  let roundedStopLimit = stopLimitPrice;
  if (stopLimitPrice != null) {
    roundedStopLimit = formatOptionPriceForApi(stopLimitPrice, { underlying });
  }

  const body = buildOtoEntryStopBody({
    optionSymbol,
    quantity,
    entryPrice: roundedEntry,
    stopTrigger: roundedTrigger,
    stopOrderType,
    stopLimitPrice: roundedStopLimit,
  });

  const path = dryRun
    ? `/accounts/${accountNumber}/complex-orders/dry-run`
    : `/accounts/${accountNumber}/complex-orders`;
  const json = await tastytradeRequestWithCredentials(
    credentials,
    sessionRef,
    path,
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  );

  if (dryRun) {
    return { dryRun: true, valid: true, body, response: json, parsed: parsePlacedComplexOrder(json) };
  }

  const parsed = parsePlacedComplexOrder(json);
  if (!parsed.triggerOrderId) {
    throw new Error('Tastytrade OTO submitted but no trigger order ID returned');
  }
  if (!parsed.stopOrderId) {
    throw new Error('Tastytrade OTO submitted but no stop child order ID returned');
  }
  return { ...parsed, body };
}

async function waitForBrokerOrderCancelled(credentials, sessionRef, accountNumber, orderId, {
  timeoutMs = 8_000,
  pollMs = 400,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await tastytradeGetOrderStatusWithCredentials(
        credentials,
        sessionRef,
        accountNumber,
        orderId
      );
      if (isConfirmedCancelledStatus(last) || last?.isFilled || last?.isTerminal) {
        return last;
      }
    } catch (err) {
      if (isBrokerOrderGoneError(err)) {
        return { status: 'cancelled', isTerminal: true, isFilled: false, gone: true };
      }
      throw err;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return last;
}

async function tastytradeCancelOrderWithCredentials(credentials, sessionRef, accountNumber, orderId) {
  try {
    await tastytradeRequestWithCredentials(
      credentials,
      sessionRef,
      `/accounts/${accountNumber}/orders/${orderId}`,
      { method: 'DELETE' }
    );
  } catch (err) {
    if (isBrokerOrderGoneError(err)) {
      return { cancelled: true, orderId, gone: true, status: 'cancelled' };
    }
    throw err;
  }

  let status = null;
  try {
    status = await waitForBrokerOrderCancelled(credentials, sessionRef, accountNumber, orderId);
  } catch (err) {
    if (isBrokerOrderGoneError(err)) {
      return { cancelled: true, orderId, gone: true, status: 'cancelled' };
    }
    console.warn(`[brokerageConnector] Cancel confirm GET failed for ${orderId}:`, err.message);
    return { cancelled: false, orderId, reason: 'cancel_confirm_failed', error: err.message };
  }

  if (status?.gone || isConfirmedCancelledStatus(status)) {
    return { cancelled: true, orderId, status: status.status, gone: Boolean(status.gone) };
  }
  if (status?.isFilled) {
    return { cancelled: false, orderId, reason: 'filled', filled: true, status: status.status };
  }
  return {
    cancelled: false,
    orderId,
    reason: 'cancel_unconfirmed',
    status: status?.status || 'unknown',
  };
}

async function tastytradeGetOrderStatusWithCredentials(credentials, sessionRef, accountNumber, orderId) {
  const json = await tastytradeRequestWithCredentials(
    credentials,
    sessionRef,
    `/accounts/${accountNumber}/orders/${orderId}`
  );
  return normalizeOrderStatus(json);
}

async function resolveOptionSymbolForPosition(position) {
  const option =
    (await tastytradeFindOption(
      position.ticker,
      position.direction,
      position.strike,
      position.expiration
    )) || null;

  if (option?.optionSymbol) return option.optionSymbol;

  return buildOccSymbol(
    toTastytradeSymbol(position.ticker),
    position.expiration,
    position.direction,
    position.strike
  );
}

async function tastytradeSubmitOrderWithCredentials(credentials, sessionRef, { accountNumber, optionSymbol, quantity, price, action }) {
  const underlying = underlyingFromOptionSymbol(optionSymbol);
  const roundedPrice = formatOptionPriceForApi(price, { underlying });
  if (roundedPrice == null) {
    throw new Error(`Invalid limit price after increment rounding: ${price}`);
  }
  if (Number(price) !== Number(roundedPrice)) {
    console.log(
      `[BrokerageConnector] Rounded limit ${price} → ${roundedPrice} ` +
        `(${underlying || '?'} tick=$${optionPriceIncrement(Number(roundedPrice), underlying).toFixed(2)})`
    );
  }
  const body = {
    'order-type': 'Limit',
    'time-in-force': 'Day',
    price: roundedPrice,
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

  const json = await tastytradeRequestWithCredentials(
    credentials,
    sessionRef,
    `/accounts/${accountNumber}/orders`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  );

  const order = json?.data?.order || json?.data || json;
  const orderId = order?.id || order?.['order-id'] || order?.order_id;
  if (!orderId) throw new Error('Tastytrade order submitted but no order ID returned');
  return String(orderId);
}

async function tastytradeClosePositionWithCredentials(credentials, sessionRef, position, exitPremium) {
  const accountNumber = await tastytradeGetAccountWithCredentials(credentials, sessionRef);

  // Prefer exact contract for this position — never fall back to DTE>=21 chain pick
  // (that caused closes to target a different OCC symbol than the intended 0DTE).
  let option = null;
  try {
    option = await tastytradeFindOption(
      position.ticker,
      position.direction,
      position.strike,
      position.expiration
    );
  } catch (err) {
    console.warn(`[brokerageConnector] Close option lookup failed:`, err.message);
  }
  if (!option?.optionSymbol) {
    option = {
      optionSymbol: buildOccSymbol(
        toTastytradeSymbol(position.ticker),
        position.expiration,
        position.direction,
        position.strike
      ),
      mid: exitPremium,
    };
  }

  const price = exitPremium ?? option.mid;
  if (price == null) throw new Error('No exit price available for close order');

  const orderId = await tastytradeSubmitOrderWithCredentials(credentials, sessionRef, {
    accountNumber,
    optionSymbol: option.optionSymbol,
    quantity: position.quantity,
    price,
    action: 'Sell to Close',
  });

  return { orderId, optionSymbol: option.optionSymbol, paper: false };
}

async function tastytradeListLiveOrdersWithCredentials(credentials, sessionRef, accountNumber) {
  const json = await tastytradeRequestWithCredentials(
    credentials,
    sessionRef,
    `/accounts/${accountNumber}/orders/live`
  );
  const items = json?.data?.items || json?.data || [];
  return Array.isArray(items) ? items : [];
}

function orderLegSymbol(order) {
  const legs = order?.legs || order?.['order-legs'] || [];
  const leg = Array.isArray(legs) ? legs[0] : null;
  return leg?.symbol || order?.symbol || null;
}

function isWorkingOrderStatus(status) {
  const s = String(status || '').toLowerCase();
  if (!s) return false;
  return !['filled', 'cancelled', 'canceled', 'expired', 'rejected'].includes(s);
}

/**
 * Cancel live/working orders that share optionSymbol (and optionally match entry order id).
 * Used before Sell-to-Close so opposing resting BTOs do not trigger illegal_buy_and_sell.
 */
async function cancelConflictingLiveOrdersWithCredentials(
  credentials,
  sessionRef,
  accountNumber,
  { optionSymbol, preferOrderIds = [] } = {}
) {
  const cancelled = [];
  const prefer = new Set(preferOrderIds.filter(Boolean).map(String));

  for (const orderId of prefer) {
    try {
      const status = await tastytradeGetOrderStatusWithCredentials(
        credentials,
        sessionRef,
        accountNumber,
        orderId
      );
      if (isWorkingOrderStatus(status.status) && !entryHasBrokerLong(status) && !status.isFilled) {
        const cancelResult = await tastytradeCancelOrderWithCredentials(
          credentials,
          sessionRef,
          accountNumber,
          orderId
        );
        if (isCancelConfirmed(cancelResult)) {
          cancelled.push({ orderId, reason: 'entry_or_known_id', status: status.status });
        } else {
          console.warn(
            `[brokerageConnector] Conflict cancel ${orderId} not confirmed ` +
              `reason=${cancelResult?.reason || 'n/a'}`
          );
        }
      }
    } catch (err) {
      console.warn(`[brokerageConnector] Cancel known order ${orderId} failed:`, err.message);
    }
  }

  let live = [];
  try {
    live = await tastytradeListLiveOrdersWithCredentials(credentials, sessionRef, accountNumber);
  } catch (err) {
    console.warn(`[brokerageConnector] List live orders failed:`, err.message);
    return cancelled;
  }

  const target = optionSymbol ? String(optionSymbol).replace(/\s+/g, ' ') : null;
  for (const order of live) {
    const id = String(order?.id || order?.['order-id'] || '');
    if (!id || prefer.has(id)) continue;
    const sym = orderLegSymbol(order);
    if (!target || !sym) continue;
    const norm = String(sym).replace(/\s+/g, ' ');
    if (norm !== target && norm.replace(/\s/g, '') !== target.replace(/\s/g, '')) continue;
    if (!isWorkingOrderStatus(order?.status)) continue;
    try {
      const cancelResult = await tastytradeCancelOrderWithCredentials(
        credentials,
        sessionRef,
        accountNumber,
        id
      );
      if (isCancelConfirmed(cancelResult)) {
        cancelled.push({ orderId: id, reason: 'live_same_symbol', status: order.status, symbol: sym });
      } else {
        console.warn(
          `[brokerageConnector] Cancel live order ${id} not confirmed ` +
            `reason=${cancelResult?.reason || 'n/a'}`
        );
      }
    } catch (err) {
      console.warn(`[brokerageConnector] Cancel live order ${id} failed:`, err.message);
    }
  }

  return cancelled;
}

function isIllegalBuySellConflictError(err) {
  const msg = String(err?.message || err || '');
  return /illegal_buy_and_sell_on_same_symbol/i.test(msg);
}

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

/**
 * OCC / Tastytrade option symbol → YYYY-MM-DD.
 * Accepts space-padded OCC (`IWM   260925P00291000`) and streamer (`.IWM260925P291`).
 */
export function expirationFromOccSymbol(optionSymbol) {
  const compact = String(optionSymbol || '')
    .trim()
    .replace(/^\./, '')
    .replace(/\s+/g, '')
    .toUpperCase();
  const m = compact.match(/^[A-Z]{1,6}(\d{6})[CP]/);
  if (!m) return null;
  const yymmdd = m[1];
  const yy = yymmdd.slice(0, 2);
  const mm = yymmdd.slice(2, 4);
  const dd = yymmdd.slice(4, 6);
  if (mm < '01' || mm > '12' || dd < '01' || dd > '31') return null;
  return `20${yy}-${mm}-${dd}`;
}

export function describeEntryExpirationMatch(requestedExpiration, option) {
  const requested = normalizeExpirationDate(requestedExpiration);
  const resolved = expirationFromOccSymbol(option?.optionSymbol);
  const mismatch = !requested || !resolved || requested !== resolved;
  return {
    mismatch,
    requested_expiration: requested,
    resolved_expiration: resolved,
    option_symbol: option?.optionSymbol || null,
    reason: mismatch ? EXPIRATION_MISMATCH_BLOCKED_REASON : null,
  };
}

async function persistZeroDteEntryEvent(strategy, eventType, { ticker, direction, details }) {
  const tradeDate = etDateKey();
  const payload = {
    ticker,
    tradeDate,
    eventType,
    direction: direction || null,
    breakoutLevel: null,
    details: details ?? {},
  };
  try {
    const key = String(strategy || '').toLowerCase();
    if (key === 'orb') {
      const { logOrbEvent } = await import('./orb/orbDb.js');
      await logOrbEvent(payload);
    } else if (key === 'premarket') {
      const { logPremarketEvent } = await import('./premarketBreakout/premarketDb.js');
      await logPremarketEvent(payload);
    } else if (key === 'emavwap') {
      const { logEmaVwapEvent } = await import('./emaVwapCross/emaVwapDb.js');
      await logEmaVwapEvent(payload);
    }
  } catch (err) {
    console.warn(`[brokerageConnector] persist ${eventType} failed:`, err.message);
  }
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
  return getPublicBaseUrl();
}

// --- Tastytrade ---

function getLegacyTastytradeAuth() {
  const credentials = isTastytradeSandbox() ? getPaperBrokerCredentials() : getLiveBrokerCredentials();
  const sessionRef = isTastytradeSandbox() ? paperSessionToken : liveSessionToken;
  return { credentials, sessionRef };
}

async function tastytradeLogin() {
  const { credentials, sessionRef } = getLegacyTastytradeAuth();
  return tastytradeLoginWithCredentials(credentials, sessionRef);
}

async function tastytradeRequest(path, options = {}, retried = false) {
  const { credentials, sessionRef } = getLegacyTastytradeAuth();
  return tastytradeRequestWithCredentials(credentials, sessionRef, path, options, retried);
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
  const sideData = strikeEntry?.[side];

  let optionSymbol = null;
  let bid = null;
  let ask = null;
  let mid = null;

  // Nested chain often returns call/put as OCC symbol strings:
  // { "strike-price": 696, "call": "SPY   260731C00696000", "call-streamer-symbol": ".SPY..." }
  if (typeof sideData === 'string' && sideData.trim()) {
    optionSymbol = sideData.trim();
  } else if (sideData && typeof sideData === 'object') {
    bid = parseNumber(sideData['bid-price'] ?? sideData.bid);
    ask = parseNumber(sideData['ask-price'] ?? sideData.ask);
    mid = parseNumber(sideData.mid ?? sideData['mark-price'] ?? sideData.mark);
    optionSymbol =
      sideData.symbol ||
      sideData['occ-symbol'] ||
      sideData['streamer-symbol'] ||
      null;
  }

  if (!optionSymbol) {
    optionSymbol =
      strikeEntry?.[`${side}-symbol`] ||
      strikeEntry?.[`${side}-occ-symbol`] ||
      strikeEntry?.symbol ||
      null;
  }

  // Prefer OCC over streamer symbols (streamer typically starts with ".")
  const streamer =
    strikeEntry?.[`${side}-streamer-symbol`] ||
    (typeof sideData === 'object' ? sideData?.['streamer-symbol'] : null);
  if (!optionSymbol && streamer) optionSymbol = streamer;
  if (optionSymbol && String(optionSymbol).startsWith('.') && typeof sideData === 'string') {
    optionSymbol = sideData.trim();
  }

  if (bid == null) {
    bid = parseNumber(strikeEntry?.[`${side}-bid`] ?? strikeEntry?.[`${side}-bid-price`]);
  }
  if (ask == null) {
    ask = parseNumber(strikeEntry?.[`${side}-ask`] ?? strikeEntry?.[`${side}-ask-price`]);
  }
  if (mid == null && bid != null && ask != null) {
    mid = (bid + ask) / 2;
  }

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

async function tastytradeGetOptionChain(ticker, direction, spotPrice, targetExpiration = null) {
  const price = spotPrice ?? (await fetchQuote(ticker)).price;
  const step = getStrikeStep(ticker);
  const atm = Math.round(price / step) * step;
  const targetStrike = direction === 'CALL' ? atm + step : atm - step;

  const chainJson = await tastytradeFetchNestedChain(ticker);
  const expirations = extractExpirations(chainJson);

  // When targetExpiration is provided (0DTE fallback), search for that exact date.
  // Otherwise, use the original Swing-compatible 21+ DTE minimum logic.
  let expirationEntry = null;
  if (targetExpiration) {
    const normalizedTarget = normalizeExpirationDate(targetExpiration);
    expirationEntry = expirations
      .map((exp) => ({
        exp,
        expiration: normalizeExpirationDate(exp['expiration-date'] || exp.expiration_date || exp.expiration),
      }))
      .find((entry) => entry.expiration === normalizedTarget);
    if (!expirationEntry) {
      throw new Error(`No Tastytrade expiration found for target date ${normalizedTarget} on ${ticker}`);
    }
  } else {
    expirationEntry = pickExpirationEntry(expirations);
    if (!expirationEntry) throw new Error(`No Tastytrade expiration with DTE >= 21 for ${ticker}`);
  }

  const strikeMatch = findStrikeEntry(expirationEntry, targetStrike, direction);
  if (!strikeMatch?.optionSymbol) {
    throw new Error(`No Tastytrade option found for ${ticker} ${direction} @ ${targetStrike}`);
  }

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
  const underlying = underlyingFromOptionSymbol(optionSymbol);
  const roundedPrice = formatOptionPriceForApi(price, { underlying });
  if (roundedPrice == null) {
    throw new Error(`Invalid limit price after increment rounding: ${price}`);
  }
  const body = {
    'order-type': 'Limit',
    'time-in-force': 'Day',
    price: roundedPrice,
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

/**
 * Option positions for a specific order environment (live vs paper), with account number.
 * Used by THE3-2 reconciliation — never mix live/paper credentials.
 */
export async function tastytradeGetOptionPositions({ environment = 'live' } = {}) {
  const orderEnvironment = normalizeOrderEnvironment(environment);
  if (!hasCredentialsForEnvironment(orderEnvironment)) {
    throw new Error(`[BrokerageConnector] No ${orderEnvironment} credentials for position recon`);
  }
  const { credentials, sessionRef } = getCredentialsForOrderEnvironment(orderEnvironment);
  const accountNumber = await tastytradeGetAccountWithCredentials(credentials, sessionRef);
  const json = await tastytradeRequestWithCredentials(
    credentials,
    sessionRef,
    `/accounts/${accountNumber}/positions`
  );
  const items = json?.data?.items || [];
  const positions = items
    .filter((p) => {
      const itype = String(p['instrument-type'] || p.instrument_type || '');
      return itype.toLowerCase().includes('option');
    })
    .map((p) => ({
      symbol: p.symbol,
      quantity: parseNumber(p.quantity),
      averageOpenPrice: parseNumber(p['average-open-price'] ?? p.average_open_price),
      'average-open-price': parseNumber(p['average-open-price'] ?? p.average_open_price),
      'cost-basis': parseNumber(p['cost-basis'] ?? p.cost_basis),
      'instrument-type': p['instrument-type'] || p.instrument_type,
    }));
  return { accountNumber, environment: orderEnvironment, positions };
}

/**
 * Recent trade transactions for fill reconciliation (THE3-2).
 * GET /accounts/{id}/transactions?start-date=YYYY-MM-DD
 */
export async function tastytradeGetRecentTradeTransactions({
  environment = 'live',
  startDate,
} = {}) {
  const orderEnvironment = normalizeOrderEnvironment(environment);
  if (!hasCredentialsForEnvironment(orderEnvironment)) {
    throw new Error(`[BrokerageConnector] No ${orderEnvironment} credentials for transaction recon`);
  }
  const { credentials, sessionRef } = getCredentialsForOrderEnvironment(orderEnvironment);
  const accountNumber = await tastytradeGetAccountWithCredentials(credentials, sessionRef);
  const day = startDate || formatDate(new Date());
  const path =
    `/accounts/${accountNumber}/transactions?start-date=${encodeURIComponent(day)}` +
    `&types=Trade`;
  const json = await tastytradeRequestWithCredentials(credentials, sessionRef, path);
  const items = json?.data?.items || [];
  return { accountNumber, environment: orderEnvironment, transactions: items };
}

/**
 * Live long quantity for this option at Tastytrade. null = lookup failed
 * (retry/protect paths must keep trying, not assume flat).
 */
export async function getLiveOptionPositionQuantity(position, { environment } = {}) {
  const orderEnvironment = normalizeOrderEnvironment(environment);
  if (!hasCredentialsForEnvironment(orderEnvironment)) return null;
  try {
    const { positions } = await tastytradeGetOptionPositions({ environment: orderEnvironment });
    return brokerQtyForOcc(positions, occForDbPosition(position));
  } catch (err) {
    console.error(`[BrokerageConnector] live option qty lookup failed:`, err.message);
    return null;
  }
}

export async function findLatestSellToCloseFill(position, { environment } = {}) {
  const orderEnvironment = normalizeOrderEnvironment(environment);
  if (!hasCredentialsForEnvironment(orderEnvironment)) return null;
  try {
    const { transactions } = await tastytradeGetRecentTradeTransactions({
      environment: orderEnvironment,
      startDate: formatDate(new Date()),
    });
    return latestSellToCloseFromTransactions(transactions, occForDbPosition(position));
  } catch (err) {
    console.warn(`[BrokerageConnector] STC fill lookup failed:`, err.message);
    return null;
  }
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
  // OCC: 6-char root (space-padded) + YYMMDD + C/P + strike*1000 (8 digits)
  const root = String(symbol).toUpperCase().padEnd(6, ' ').slice(0, 6);
  const exp = expiration.replace(/-/g, '').slice(2);
  const type = direction === 'CALL' ? 'C' : 'P';
  const strikeStr = String(Math.round(Number(strike) * 1000)).padStart(8, '0');
  return `${root}${exp}${type}${strikeStr}`;
}

async function waitForBrokerOrderFill(credentials, sessionRef, accountNumber, orderId, {
  timeoutMs = 15_000,
  pollMs = 1_000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await tastytradeGetOrderStatusWithCredentials(credentials, sessionRef, accountNumber, orderId);
    if (fillPollShouldReturn(last)) return last;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return last;
}

async function resolveFillStatusWithPrice(credentials, sessionRef, accountNumber, orderId, fillStatus) {
  if (hasConfirmedFillPrice(fillStatus) || !orderId) return fillStatus;
  try {
    const again = await tastytradeGetOrderStatusWithCredentials(
      credentials,
      sessionRef,
      accountNumber,
      orderId
    );
    if (hasConfirmedFillPrice(again)) return again;
  } catch (err) {
    console.warn(
      `[brokerageConnector] Fill-price re-GET failed for ${orderId}:`,
      err.message
    );
  }
  return fillStatus;
}

export async function placeOptionOrder({
  ticker,
  direction,
  strike,
  expiration,
  quantity,
  premium,
  broker = 'tastytrade',
  environment = 'paper',
  strategy = 'unknown',
  initialStop = null,
}) {
  const orderEnvironment = normalizeOrderEnvironment(environment);
  const order = {
    symbol: toTastytradeSymbol(ticker),
    direction,
    strike,
    expiration,
    quantity,
    premium,
    broker,
    environment: orderEnvironment,
    strategy,
    totalCost: premium * quantity * 100,
  };

  if (orderEnvironment === 'live') {
    assertLiveCredentialsForStrategy(strategy);
  } else if (!hasCredentialsForEnvironment('paper')) {
    throw new Error(
      `[BrokerageConnector] Paper order blocked for ${strategy}: sandbox Tastytrade credentials are not configured ` +
        '(need TASTYTRADE_SANDBOX_CLIENT_SECRET + TASTYTRADE_SANDBOX_REFRESH_TOKEN + TASTYTRADE_ACCOUNT_NUMBER)'
    );
  }

  const { credentials, sessionRef } = getCredentialsForOrderEnvironment(orderEnvironment);
  const accountNumber = await tastytradeGetAccountWithCredentials(credentials, sessionRef);

  let option = null;
  try {
    option = await tastytradeFindOption(ticker, direction, strike, expiration);
  } catch (err) {
    console.warn(`[brokerageConnector] Option lookup failed for ${strategy}:`, err.message);
  }

  if (!option?.optionSymbol) {
    const requestedExpiration = normalizeExpirationDate(expiration);
    const missDetails = {
      reason: FIND_OPTION_MISS_REASON,
      ticker,
      direction,
      strike,
      requested_expiration: requestedExpiration,
      fallback_attempted: true,
      strategy,
    };
    console.warn(
      `[brokerageConnector][${strategy}] ${FIND_OPTION_MISS_REASON}` +
        ` ticker=${ticker} direction=${direction} strike=${strike}` +
        ` requested_expiration=${requestedExpiration}` +
        ` — fallback will be attempted`
    );
    await persistZeroDteEntryEvent(strategy, FIND_OPTION_MISS_REASON, {
      ticker,
      direction,
      details: missDetails,
    });
    try {
      const quote = await fetchQuote(ticker);
      // 0DTE strategies (orb/premarket/emavwap) pass exact expiration — search for that date.
      // Swing/others may not pass expiration or pass monthly — fallback uses minDte=21 logic.
      if (expiration) {
        console.log(
          `[brokerageConnector][${strategy}] Exact lookup missed; searching chain for target expiration ${expiration}`
        );
      }
      option = await tastytradeGetOptionChain(ticker, direction, quote.price, expiration);
    } catch (err) {
      console.warn(`[brokerageConnector] Chain lookup failed for order:`, err.message);
    }
  }

  if (!option?.optionSymbol) {
    // Last resort OCC build — may be rejected by broker if format/root differs.
    option = {
      optionSymbol: buildOccSymbol(order.symbol, expiration, direction, strike),
      mid: premium,
    };
    console.warn(`[brokerageConnector] Using OCC fallback symbol ${option.optionSymbol}`);
  }

  const expirationCheck = describeEntryExpirationMatch(expiration, option);
  if (expirationCheck.mismatch) {
    const blockDetails = {
      reason: EXPIRATION_MISMATCH_BLOCKED_REASON,
      ticker,
      direction,
      strike,
      requested_expiration: expirationCheck.requested_expiration,
      resolved_expiration: expirationCheck.resolved_expiration,
      option_symbol: expirationCheck.option_symbol,
      strategy,
    };
    console.error(
      `[brokerageConnector][${strategy}] ${EXPIRATION_MISMATCH_BLOCKED_REASON}` +
        ` ticker=${ticker} direction=${direction} strike=${strike}` +
        ` requested_expiration=${expirationCheck.requested_expiration}` +
        ` resolved_expiration=${expirationCheck.resolved_expiration}` +
        ` occ=${expirationCheck.option_symbol}` +
        ` — order not submitted`
    );
    await persistZeroDteEntryEvent(strategy, EXPIRATION_MISMATCH_BLOCKED_REASON, {
      ticker,
      direction,
      details: blockDetails,
    });
    const err = new Error(
      `${EXPIRATION_MISMATCH_BLOCKED_REASON} requested=${expirationCheck.requested_expiration}` +
        ` resolved=${expirationCheck.resolved_expiration} occ=${expirationCheck.option_symbol}`
    );
    err.code = EXPIRATION_MISMATCH_BLOCKED_REASON;
    err.details = blockDetails;
    throw err;
  }

  const limitPrice = option.mid ?? option.ask ?? option.bid ?? premium;
  if (limitPrice == null || !Number.isFinite(Number(limitPrice)) || Number(limitPrice) <= 0) {
    throw new Error(`No usable limit price for ${ticker} ${direction} ${strike} ${expiration}`);
  }

  const wantOto =
    isLadderBrokerStopEnabledForStrategy(strategy) &&
    Number(initialStop?.stopTrigger) > 0 &&
    Number(quantity) >= 1;

  if (wantOto) {
    try {
      const oto = await tastytradeSubmitOtoEntryStopWithCredentials(credentials, sessionRef, {
        accountNumber,
        optionSymbol: option.optionSymbol,
        quantity,
        entryPrice: limitPrice,
        stopTrigger: initialStop.stopTrigger,
        stopLimitPrice: initialStop.limitPrice ?? null,
        stopOrderType: initialStop.orderType ?? null,
      });

      let fillStatus = null;
      try {
        fillStatus = await waitForBrokerOrderFill(
          credentials,
          sessionRef,
          accountNumber,
          oto.triggerOrderId
        );
      } catch (err) {
        console.warn(`[brokerageConnector] OTO fill poll failed for ${oto.triggerOrderId}:`, err.message);
      }
      if (fillStatus?.status === 'rejected') {
        throw new Error(`Tastytrade OTO trigger ${oto.triggerOrderId} was rejected`);
      }

      let fillCtx = { price: fillStatus?.fillPrice ?? null };
      let finalized;
      try {
        finalized = await finalizeOtoPartialFill({
          triggerOrderId: oto.triggerOrderId,
          stopOrderId: oto.stopOrderId,
          requestedQuantity: quantity,
          fillStatus,
          fillPrice: fillStatus?.fillPrice,
          fillCtx,
          stopPnlFrac: initialStop.stopPnlFrac,
          getStatus: (id) =>
            tastytradeGetOrderStatusWithCredentials(credentials, sessionRef, accountNumber, id),
          cancelOrder: (id) =>
            tastytradeCancelOrderWithCredentials(credentials, sessionRef, accountNumber, id),
          placeStop: async (qty) => {
            const fillStop = fillBasedStopParams(initialStop, fillCtx.price);
            const placed = await tastytradeSubmitStopOrderWithCredentials(credentials, sessionRef, {
              accountNumber,
              optionSymbol: option.optionSymbol,
              quantity: qty,
              stopTrigger: fillStop.stopTrigger,
              limitPrice: fillStop.limitPrice ?? null,
              orderType: fillStop.orderType ?? initialStop.orderType ?? null,
            });
            if (!placed?.orderId) return placed;
            try {
              const status = await tastytradeGetOrderStatusWithCredentials(
                credentials,
                sessionRef,
                accountNumber,
                placed.orderId
              );
              if (!isConfirmedRestingStop(status)) {
                return {
                  ...placed,
                  orderId: null,
                  resting: false,
                  reason: status?.rejectReason || status?.status || 'not_resting',
                };
              }
              return { ...placed, resting: true, stopTrigger: status.stopTrigger ?? fillStop.stopTrigger };
            } catch (err) {
              return {
                ...placed,
                orderId: null,
                resting: false,
                reason: 'stop_status_unconfirmed',
              };
            }
          },
        });
      } catch (err) {
        console.error(
          `[brokerageConnector] OTO fill/stop align failed for ${oto.triggerOrderId}:`,
          err.message
        );
        finalized = {
          fillStatus,
          bookedQuantity: bookedEntryQuantity({
            requestedQuantity: quantity,
            fillQuantity: fillStatus?.fillQuantity,
          }),
          cancelledRemainder: false,
          observedStopQty: null,
          brokerDidMatch: false,
          aligned: {
            aligned: false,
            stopOrderId: null,
            replaced: false,
            reason: err.message,
          },
        };
      }
      fillStatus = finalized.fillStatus || fillStatus;
      fillStatus = await resolveFillStatusWithPrice(
        credentials,
        sessionRef,
        accountNumber,
        oto.triggerOrderId,
        fillStatus
      );
      const bookedQty = finalized.bookedQuantity;
      const fillStop = fillBasedStopParams(initialStop, fillStatus?.fillPrice);
      const stopAligned = Boolean(finalized.aligned?.aligned);
      const stopOrderId = restingStopIdAfterAlign({
        aligned: finalized.aligned,
        otoStopOrderId: oto.stopOrderId,
      });
      const stopAlignFailed =
        bookedQty >= 1 &&
        Math.floor(Number(fillStatus?.fillQuantity) || 0) >= 1 &&
        !stopAligned;

      if (stopAlignFailed) {
        console.error(
          `[${orderEnvironment === 'paper' ? 'SANDBOX' : 'LIVE'}][${strategy}] ` +
            `OTO STOP ALIGN FAILED entry=${oto.triggerOrderId} ` +
            `requested=${quantity} filled=${fillStatus?.fillQuantity ?? 0} booked=${bookedQty} ` +
            `otoChildStopQty=${finalized.observedStopQty ?? 'n/a'} ` +
            `observedTrigger=$${finalized.aligned?.observedTrigger ?? 'n/a'} ` +
            `fillStopTrigger=$${fillStop.stopTrigger ?? 'n/a'} ` +
            `reason=${finalized.aligned?.reason || 'unknown'} — clearing stop id for retry loop`
        );
      }

      console.log(
        `[${orderEnvironment === 'paper' ? 'SANDBOX' : 'LIVE'}][${strategy}] OTO placed ` +
          `entry=${oto.triggerOrderId} stop=${stopOrderId || 'none'} complex=${oto.complexOrderId} ` +
          `status=${fillStatus?.status || 'submitted'} fill=${fillStatus?.fillPrice ?? 'n/a'} ` +
          `requested=${quantity} filled=${fillStatus?.fillQuantity ?? 0} booked=${bookedQty} ` +
          `otoChildStopQty=${finalized.observedStopQty ?? 'n/a'} ` +
          `brokerStopMatchedFill=${Boolean(finalized.brokerDidMatch)} ` +
          `stopReplaced=${Boolean(finalized.aligned?.replaced)} ` +
          `stopAlignReason=${finalized.aligned?.reason || 'n/a'} ` +
          `stopAlignFailed=${stopAlignFailed} ` +
          `remainderCancelled=${Boolean(finalized.cancelledRemainder)} ` +
          `submittedStopTrigger=$${initialStop.stopTrigger} ` +
          `fillStopTrigger=$${fillStop.stopTrigger}`
      );

      const confirmedFill = hasConfirmedFillPrice(fillStatus) ? fillStatus.fillPrice : null;
      if (bookedQty >= 1 && confirmedFill == null) {
        console.error(
          `[brokerageConnector] OTO ${oto.triggerOrderId} booked qty=${bookedQty} ` +
            `without a confirmed fill price — downstream must not use the selection quote`
        );
      }

      return {
        orderId: oto.triggerOrderId,
        stopOrderId,
        complexOrderId: oto.complexOrderId,
        bracketType: 'OTO',
        stopTrigger: Number(fillStop.stopTrigger) || Number(initialStop.stopTrigger),
        stopPnlFrac: initialStop.stopPnlFrac ?? null,
        paper: orderEnvironment === 'paper',
        environment: orderEnvironment,
        sandbox: Boolean(credentials.sandbox),
        broker: 'tastytrade',
        ...order,
        status: fillStatus?.status || 'submitted',
        fillPrice: confirmedFill,
        filled: Boolean(fillStatus?.isFilled),
        partialFill: Boolean(fillStatus?.isPartialFill) || (bookedQty >= 1 && bookedQty < quantity),
        premium: confirmedFill ?? limitPrice,
        quantity: bookedQty,
        requestedQuantity: quantity,
        fillQuantity: Math.floor(Number(fillStatus?.fillQuantity) || 0),
        remainingQuantity: fillStatus?.remainingQuantity ?? null,
        observedOtoStopQty: finalized.observedStopQty ?? null,
        observedOtoStopTrigger: finalized.aligned?.observedTrigger ?? null,
        stopQtyReplaced: Boolean(finalized.aligned?.replaced),
        brokerStopMatchedFill: Boolean(finalized.brokerDidMatch),
        stopAlignFailed,
        stopAlignReason: finalized.aligned?.reason || null,
      };
    } catch (err) {
      console.error(
        `[BrokerageConnector] OTO bracket failed for ${strategy}: ${otoFallbackReason(err)} ` +
          `— falling back to entry-only + stop retry`
      );
    }
  }

  const orderId = await tastytradeSubmitOrderWithCredentials(credentials, sessionRef, {
    accountNumber,
    optionSymbol: option.optionSymbol,
    quantity,
    price: limitPrice,
    action: 'Buy to Open',
  });

  // Brief fill poll — downstream still records intended premium if fill is delayed.
  let fillStatus = null;
  try {
    fillStatus = await waitForBrokerOrderFill(credentials, sessionRef, accountNumber, orderId);
  } catch (err) {
    console.warn(`[brokerageConnector] Fill poll failed for ${orderId}:`, err.message);
  }

  if (fillStatus?.status === 'rejected') {
    throw new Error(`Tastytrade order ${orderId} was rejected`);
  }

  const remaining = Number(fillStatus?.remainingQuantity);
  const filledSoFar = Math.floor(Number(fillStatus?.fillQuantity) || 0);
  if (filledSoFar >= 1 && remaining > 0) {
    try {
      await tastytradeCancelOrderWithCredentials(
        credentials,
        sessionRef,
        accountNumber,
        orderId
      );
      fillStatus = await tastytradeGetOrderStatusWithCredentials(
        credentials,
        sessionRef,
        accountNumber,
        orderId
      );
    } catch (err) {
      console.warn(
        `[brokerageConnector] Partial-fill remainder cancel failed for ${orderId}:`,
        err.message
      );
    }
  }

  fillStatus = await resolveFillStatusWithPrice(
    credentials,
    sessionRef,
    accountNumber,
    orderId,
    fillStatus
  );

  const bookedQty = bookedEntryQuantity({
    requestedQuantity: quantity,
    fillQuantity: fillStatus?.fillQuantity,
  });
  const confirmedFill = hasConfirmedFillPrice(fillStatus) ? fillStatus.fillPrice : null;
  if (bookedQty >= 1 && confirmedFill == null) {
    console.error(
      `[brokerageConnector] Order ${orderId} booked qty=${bookedQty} ` +
        `without a confirmed fill price — downstream must not use the selection quote`
    );
  }

  console.log(
    `[${orderEnvironment === 'paper' ? 'SANDBOX' : 'LIVE'}][${strategy}] Order placed id=${orderId} ` +
      `status=${fillStatus?.status || 'submitted'} fill=${confirmedFill ?? 'n/a'} ` +
      `requested=${quantity} filled=${fillStatus?.fillQuantity ?? 0} booked=${bookedQty}`
  );

  return {
    orderId,
    stopOrderId: null,
    complexOrderId: null,
    bracketType: null,
    paper: orderEnvironment === 'paper',
    environment: orderEnvironment,
    sandbox: Boolean(credentials.sandbox),
    broker: 'tastytrade',
    ...order,
    status: fillStatus?.status || 'submitted',
    fillPrice: confirmedFill,
    filled: Boolean(fillStatus?.isFilled),
    partialFill: Boolean(fillStatus?.isPartialFill) || (bookedQty >= 1 && bookedQty < quantity),
    premium: confirmedFill ?? limitPrice,
    quantity: bookedQty,
    requestedQuantity: quantity,
    fillQuantity: Math.floor(Number(fillStatus?.fillQuantity) || 0),
    remainingQuantity: fillStatus?.remainingQuantity ?? null,
  };
}

async function placeEtradeOrder() {
  throw new Error('E*Trade live order placement requires full OAuth 1.0a signing — use Tastytrade or paper mode');
}

export async function closeOptionOrder(position, exitPremium, quantity = null, options = {}) {
  const closeQty = quantity ?? position.quantity ?? position.contracts_open;
  const positionForClose = { ...position, quantity: closeQty };
  const orderEnvironment = normalizeOrderEnvironment(options.environment);
  const strategy = options.strategy || 'unknown';

  if (orderEnvironment === 'live') {
    assertLiveCredentialsForStrategy(strategy);
  } else if (!hasCredentialsForEnvironment('paper')) {
    throw new Error(
      `[BrokerageConnector] Paper close blocked for ${strategy}: sandbox Tastytrade credentials are not configured`
    );
  }

  const { credentials, sessionRef } = getCredentialsForOrderEnvironment(orderEnvironment);
  const accountNumber = await tastytradeGetAccountWithCredentials(credentials, sessionRef);

  // Resolve the contract we intend to close (exact expiration — no DTE>=21 fallback).
  let optionSymbol = null;
  try {
    const found = await tastytradeFindOption(
      position.ticker,
      position.direction,
      position.strike,
      position.expiration
    );
    optionSymbol = found?.optionSymbol || null;
  } catch {
    /* fall through to OCC */
  }
  if (!optionSymbol) {
    optionSymbol = buildOccSymbol(
      toTastytradeSymbol(position.ticker),
      position.expiration,
      position.direction,
      position.strike
    );
  }

  const entryOrderId = position.order_id || position.orderId || null;
  const tag = `[CLOSE][${orderEnvironment === 'paper' ? 'SANDBOX' : 'LIVE'}][${strategy}]`;
  console.log(
    `${tag} ATTEMPT pos=#${position.id ?? '?'} ${position.ticker || ''} ${position.direction || ''} ` +
      `$${position.strike ?? '?'} qty=${closeQty} entryOrder=${entryOrderId || 'none'} symbol=${optionSymbol}`
  );

  // If the recorded entry order is still working/unfilled, cancel it first.
  // An unfilled BTO means there is no long to Sell-to-Close — do not submit STC.
  let entryStatus = null;
  if (entryOrderId && !String(entryOrderId).startsWith('PAPER-')) {
    try {
      entryStatus = await tastytradeGetOrderStatusWithCredentials(
        credentials,
        sessionRef,
        accountNumber,
        String(entryOrderId)
      );
      const entrySym = orderLegSymbol(entryStatus.raw) || optionSymbol;
      if (entrySym) optionSymbol = entrySym;

      if (isWorkingOrderStatus(entryStatus.status) && !entryHasBrokerLong(entryStatus)) {
        const cancelResult = await tastytradeCancelOrderWithCredentials(
          credentials,
          sessionRef,
          accountNumber,
          String(entryOrderId)
        );
        if (!isCancelConfirmed(cancelResult)) {
          console.error(
            `${tag} entry cancel not confirmed orderId=${entryOrderId} ` +
              `reason=${cancelResult?.reason || 'n/a'} — not treating as flat`
          );
          return {
            orderId: null,
            noBrokerPosition: false,
            cancelledEntryOrderId: String(entryOrderId),
            reason: 'entry_cancel_unconfirmed',
            paper: orderEnvironment === 'paper',
            environment: orderEnvironment,
            sandbox: Boolean(credentials.sandbox),
            status: cancelResult?.status || entryStatus.status,
            fillPrice: null,
            filled: false,
          };
        }
        console.log(
          `${tag} CONFLICT_CANCELLED entry_unfilled orderId=${entryOrderId} status=${entryStatus.status}`
        );
        console.log(
          `${tag} OK_FLAT reason=entry_unfilled_cancelled (no STC — position never filled at broker)`
        );
        return {
          orderId: null,
          noBrokerPosition: true,
          cancelledEntryOrderId: String(entryOrderId),
          reason: 'entry_unfilled_cancelled',
          paper: orderEnvironment === 'paper',
          environment: orderEnvironment,
          sandbox: Boolean(credentials.sandbox),
          status: 'entry_cancelled',
          fillPrice: null,
          filled: false,
        };
      }

      if (isWorkingOrderStatus(entryStatus.status) && entryHasBrokerLong(entryStatus)) {
        const cancelResult = await tastytradeCancelOrderWithCredentials(
          credentials,
          sessionRef,
          accountNumber,
          String(entryOrderId)
        );
        if (!isCancelConfirmed(cancelResult)) {
          console.error(
            `${tag} entry remainder cancel not confirmed orderId=${entryOrderId} ` +
              `reason=${cancelResult?.reason || 'n/a'} — not submitting STC`
          );
          return {
            orderId: null,
            noBrokerPosition: false,
            cancelledEntryOrderId: String(entryOrderId),
            reason: 'entry_remainder_cancel_unconfirmed',
            paper: orderEnvironment === 'paper',
            environment: orderEnvironment,
            sandbox: Boolean(credentials.sandbox),
            status: cancelResult?.status || entryStatus.status,
            fillPrice: null,
            filled: false,
          };
        }
        console.log(
          `${tag} CONFLICT_CANCELLED entry_remainder orderId=${entryOrderId} ` +
            `filled=${entryStatus.fillQuantity} remaining=${entryStatus.remainingQuantity}`
        );
      }

      // Entry already terminal without a fill — nothing to Sell-to-Close at the broker.
      if (!entryHasBrokerLong(entryStatus) && !isWorkingOrderStatus(entryStatus.status)) {
        console.log(
          `${tag} OK_FLAT reason=entry_never_filled entryOrder=${entryOrderId} status=${entryStatus.status}`
        );
        return {
          orderId: null,
          noBrokerPosition: true,
          cancelledEntryOrderId: String(entryOrderId),
          reason: 'entry_never_filled',
          paper: orderEnvironment === 'paper',
          environment: orderEnvironment,
          sandbox: Boolean(credentials.sandbox),
          status: entryStatus.status,
          fillPrice: null,
          filled: false,
        };
      }
    } catch (err) {
      console.warn(
        `${tag} Entry order status/cancel failed for ${entryOrderId}:`,
        err.message
      );
    }
  }

  // Entry filled but the broker book is already flat (stop filled, manual STC).
  // Do not submit another Sell — #88's later retries were Sell to Open.
  let liveQty = null;
  try {
    liveQty = await getLiveOptionPositionQuantity(position, { environment: orderEnvironment });
  } catch (err) {
    console.warn(`${tag} live qty lookup failed:`, err.message);
  }
  if (liveQty === 0) {
    const stc = await findLatestSellToCloseFill(position, { environment: orderEnvironment });
    console.log(
      `${tag} OK_FLAT reason=broker_already_flat qty=0 fill=${stc?.price ?? 'n/a'}`
    );
    return {
      orderId: stc?.orderId ? String(stc.orderId) : null,
      noBrokerPosition: true,
      reason: 'broker_already_flat',
      paper: orderEnvironment === 'paper',
      environment: orderEnvironment,
      sandbox: Boolean(credentials.sandbox),
      status: 'broker_already_flat',
      fillPrice: stc?.price ?? null,
      filled: Number(stc?.price) > 0,
    };
  }

  // Clear any other working orders on this OCC symbol (duplicate BTO / stale stops).
  const cancelled = await cancelConflictingLiveOrdersWithCredentials(
    credentials,
    sessionRef,
    accountNumber,
    {
      optionSymbol,
      preferOrderIds: [entryOrderId, position.broker_stop_order_id].filter(Boolean),
    }
  );
  if (cancelled.length) {
    console.log(
      `${tag} CONFLICT_CANCELLED count=${cancelled.length} symbol=${optionSymbol} ` +
        `ids=${cancelled.map((c) => c.orderId).join(',')}`
    );
  }

  const submitClose = async () =>
    tastytradeClosePositionWithCredentials(credentials, sessionRef, positionForClose, exitPremium);

  let result;
  let retriedAfterConflict = false;
  try {
    result = await submitClose();
  } catch (err) {
    if (isIllegalBuySellConflictError(err)) {
      retriedAfterConflict = true;
      console.warn(
        `${tag} RETRY after illegal_buy_and_sell_on_same_symbol — cancelling conflicts then resubmitting STC`
      );
      await cancelConflictingLiveOrdersWithCredentials(credentials, sessionRef, accountNumber, {
        optionSymbol,
        preferOrderIds: [entryOrderId, position.broker_stop_order_id].filter(Boolean),
      });
      // Re-check entry: if still no fill, treat as flat.
      if (entryOrderId && !String(entryOrderId).startsWith('PAPER-')) {
        try {
          const again = await tastytradeGetOrderStatusWithCredentials(
            credentials,
            sessionRef,
            accountNumber,
            String(entryOrderId)
          );
          if (!entryHasBrokerLong(again)) {
            console.log(
              `${tag} OK_FLAT reason=entry_unfilled_cancelled_after_conflict entryOrder=${entryOrderId}`
            );
            return {
              orderId: null,
              noBrokerPosition: true,
              cancelledEntryOrderId: String(entryOrderId),
              reason: 'entry_unfilled_cancelled',
              paper: orderEnvironment === 'paper',
              environment: orderEnvironment,
              sandbox: Boolean(credentials.sandbox),
              status: 'entry_cancelled_after_conflict',
              fillPrice: null,
              filled: false,
            };
          }
        } catch {
          /* proceed to retry STC */
        }
      }
      result = await submitClose();
    } else {
      throw err;
    }
  }

  let fillStatus = null;
  try {
    const fillWaitMs = Number(options.fillWaitMs);
    const timeoutMs =
      Number.isFinite(fillWaitMs) && fillWaitMs > 0 ? fillWaitMs : 15_000;
    const pollMs =
      Number.isFinite(Number(options.fillPollMs)) && Number(options.fillPollMs) > 0
        ? Number(options.fillPollMs)
        : timeoutMs <= 5_000
          ? 500
          : 1_000;
    fillStatus = await waitForBrokerOrderFill(
      credentials,
      sessionRef,
      accountNumber,
      result.orderId,
      { timeoutMs, pollMs }
    );
  } catch (err) {
    console.warn(`${tag} Close fill poll failed for ${result.orderId}:`, err.message);
  }

  fillStatus = await resolveFillStatusWithPrice(
    credentials,
    sessionRef,
    accountNumber,
    result.orderId,
    fillStatus
  );

  const confirmedFill = hasConfirmedFillPrice(fillStatus) ? fillStatus.fillPrice : null;
  const filledConfirmed = Boolean(fillStatus?.isFilled) && confirmedFill != null;
  if (fillStatus?.isFilled && confirmedFill == null) {
    console.error(
      `${tag} STC ${result.orderId} reported filled without a confirmed fill price ` +
        `— not treating as settled`
    );
  }

  const conflictNote =
    cancelled.length || retriedAfterConflict
      ? ` resolvedConflicts=${cancelled.length} retried=${retriedAfterConflict}`
      : '';
  console.log(
    `${tag} OK closeOrderId=${result.orderId} qty=${closeQty} ` +
      `status=${fillStatus?.status || 'submitted'} fill=${confirmedFill ?? 'n/a'}${conflictNote}`
  );

  return {
    orderId: result.orderId,
    paper: orderEnvironment === 'paper',
    environment: orderEnvironment,
    sandbox: Boolean(credentials.sandbox),
    status: fillStatus?.status || 'submitted',
    fillPrice: confirmedFill,
    fillQuantity: Math.floor(Number(fillStatus?.fillQuantity) || 0),
    filled: filledConfirmed,
    cancelledConflicts: cancelled,
    retriedAfterConflict,
  };
}

/**
 * Submit a broker-side stop (or stop-limit) sell-to-close for an open option position.
 * Paper strategy environment routes to Tastytrade cert/sandbox when credentials are configured.
 */
export async function submitOptionStopOrder(position, {
  quantity,
  stopTrigger,
  limitPrice = null,
  orderType = 'stop_market',
  environment = 'paper',
  strategy = 'unknown',
  dryRun = false,
} = {}) {
  const closeQty = quantity ?? position.quantity;
  const trigger = Number(stopTrigger);
  if (!Number.isFinite(trigger) || trigger <= 0) {
    throw new Error('Invalid stop trigger price');
  }
  if (!closeQty || closeQty < 1) {
    throw new Error('Stop order quantity must be >= 1');
  }

  const orderEnvironment = normalizeOrderEnvironment(environment);

  if (orderEnvironment === 'paper' && !hasCredentialsForEnvironment('paper')) {
    console.log(
      `[PAPER][${strategy}] Broker stop would be placed qty=${closeQty} trigger=$${trigger} (no cert credentials)`
    );
    return {
      orderId: `PAPER-STOP-${Date.now()}`,
      paper: true,
      simulated: true,
      resting: true,
      stopTrigger: trigger,
      quantity: closeQty,
      limitPrice,
      orderType,
    };
  }

  if (orderEnvironment === 'live') {
    assertLiveCredentialsForStrategy(strategy);
  }

  const { credentials, sessionRef } = getCredentialsForOrderEnvironment(orderEnvironment);
  const accountNumber = await tastytradeGetAccountWithCredentials(credentials, sessionRef);
  const optionSymbol = await resolveOptionSymbolForPosition(position);

  const result = await tastytradeSubmitStopOrderWithCredentials(credentials, sessionRef, {
    accountNumber,
    optionSymbol,
    quantity: closeQty,
    stopTrigger: trigger,
    limitPrice,
    orderType,
    dryRun,
  });

  if (dryRun) {
    return {
      ...result,
      resting: true,
      environment: orderEnvironment,
      sandbox: credentials.sandbox,
      optionSymbol,
    };
  }

  let status = null;
  try {
    status = await tastytradeGetOrderStatusWithCredentials(
      credentials,
      sessionRef,
      accountNumber,
      result.orderId
    );
  } catch (err) {
    console.error(
      `[brokerageConnector] Stop ${result.orderId} GET after submit failed:`,
      err.message
    );
    return {
      orderId: result.orderId,
      paper: orderEnvironment === 'paper',
      environment: orderEnvironment,
      sandbox: credentials.sandbox,
      stopTrigger: trigger,
      quantity: closeQty,
      limitPrice,
      orderType,
      optionSymbol,
      resting: false,
      reason: 'stop_status_unconfirmed',
      error: err.message,
    };
  }

  const resting = isConfirmedRestingStop(status);
  const brokerTrigger = Number(status?.stopTrigger);
  const brokerQty = stopQuantityFromStatus(status);
  if (!resting) {
    console.error(
      `[brokerageConnector] Stop ${result.orderId} not resting after submit ` +
        `status=${status?.status || 'n/a'} reject=${status?.rejectReason || 'n/a'}`
    );
  }

  return {
    orderId: result.orderId,
    paper: orderEnvironment === 'paper',
    environment: orderEnvironment,
    sandbox: credentials.sandbox,
    stopTrigger: Number.isFinite(brokerTrigger) && brokerTrigger > 0 ? brokerTrigger : trigger,
    quantity: brokerQty ?? closeQty,
    limitPrice,
    orderType,
    optionSymbol,
    status: status?.status || null,
    rejectReason: status?.rejectReason || null,
    resting,
    reason: resting ? null : (status?.rejectReason || status?.status || 'not_resting'),
  };
}

/**
 * PUT-replace a resting Stop STC. Does not cancel first — Tastytrade swaps the live order.
 */
export async function replaceOptionStopOrder(position, {
  existingOrderId,
  quantity,
  stopTrigger,
  limitPrice = null,
  orderType = 'stop_market',
  environment = 'paper',
  strategy = 'unknown',
} = {}) {
  const closeQty = quantity ?? position.quantity;
  const trigger = Number(stopTrigger);
  const priorId = existingOrderId || position.broker_stop_order_id;
  if (!priorId) {
    throw new Error('replaceOptionStopOrder requires an existing resting order id');
  }
  if (!Number.isFinite(trigger) || trigger <= 0) {
    throw new Error('Invalid stop trigger price');
  }
  if (!closeQty || closeQty < 1) {
    throw new Error('Stop order quantity must be >= 1');
  }

  const orderEnvironment = normalizeOrderEnvironment(environment);

  if (isBrokerDryRun() || String(priorId).startsWith('DRYRUN-')) {
    const orderId = `DRYRUN-STOP-${Date.now()}`;
    console.log(
      `[BROKER DRY-RUN][${strategy}] would PUT-replace stop ${priorId} → trigger=$${trigger}`
    );
    return {
      orderId,
      replacesOrderId: String(priorId),
      paper: true,
      dryRun: true,
      simulated: true,
      resting: true,
      replaced: true,
      stopTrigger: trigger,
      quantity: closeQty,
      limitPrice,
      orderType,
      environment: orderEnvironment,
    };
  }

  if (orderEnvironment === 'paper' && !hasCredentialsForEnvironment('paper')) {
    const orderId = `PAPER-STOP-${Date.now()}`;
    console.log(
      `[PAPER][${strategy}] Broker stop PUT-replace ${priorId} → trigger=$${trigger}`
    );
    return {
      orderId,
      replacesOrderId: String(priorId),
      paper: true,
      simulated: true,
      resting: true,
      replaced: true,
      stopTrigger: trigger,
      quantity: closeQty,
      limitPrice,
      orderType,
    };
  }

  if (orderEnvironment === 'live') {
    assertLiveCredentialsForStrategy(strategy);
  }

  const { credentials, sessionRef } = getCredentialsForOrderEnvironment(orderEnvironment);
  const accountNumber = await tastytradeGetAccountWithCredentials(credentials, sessionRef);
  const optionSymbol = await resolveOptionSymbolForPosition(position);

  const result = await tastytradeReplaceStopOrderWithCredentials(credentials, sessionRef, {
    accountNumber,
    existingOrderId: priorId,
    optionSymbol,
    quantity: closeQty,
    stopTrigger: trigger,
    limitPrice,
    orderType,
  });

  let status = null;
  try {
    status = await tastytradeGetOrderStatusWithCredentials(
      credentials,
      sessionRef,
      accountNumber,
      result.orderId
    );
  } catch (err) {
    console.error(
      `[brokerageConnector] Replaced stop ${result.orderId} GET after PUT failed:`,
      err.message
    );
    return {
      orderId: result.orderId,
      replacesOrderId: String(priorId),
      paper: orderEnvironment === 'paper',
      environment: orderEnvironment,
      sandbox: credentials.sandbox,
      stopTrigger: trigger,
      quantity: closeQty,
      limitPrice,
      orderType,
      optionSymbol,
      replaced: true,
      resting: false,
      reason: 'stop_status_unconfirmed',
      error: err.message,
    };
  }

  const resting = isConfirmedRestingStop(status);
  const brokerTrigger = Number(status?.stopTrigger);
  const brokerQty = stopQuantityFromStatus(status);
  if (!resting) {
    console.error(
      `[brokerageConnector] Replaced stop ${result.orderId} not resting after PUT ` +
        `status=${status?.status || 'n/a'} reject=${status?.rejectReason || 'n/a'}`
    );
  }

  return {
    orderId: result.orderId,
    replacesOrderId: String(priorId),
    paper: orderEnvironment === 'paper',
    environment: orderEnvironment,
    sandbox: credentials.sandbox,
    stopTrigger: Number.isFinite(brokerTrigger) && brokerTrigger > 0 ? brokerTrigger : trigger,
    quantity: brokerQty ?? closeQty,
    limitPrice,
    orderType,
    optionSymbol,
    status: status?.status || null,
    rejectReason: status?.rejectReason || null,
    replaced: true,
    resting,
    reason: resting ? null : (status?.rejectReason || status?.status || 'not_resting'),
  };
}

/** True when the prior stop is fully off the book (cancelled/gone/rejected) or already filled. */
export async function verifyBrokerOrderTerminated(orderId, { environment = 'paper', strategy = 'unknown' } = {}) {
  if (!orderId) return { terminated: true, filled: false, status: null, reason: 'no_order_id' };
  if (String(orderId).startsWith('DRYRUN-') || String(orderId).startsWith('PAPER-')) {
    return { terminated: true, filled: false, status: { status: 'cancelled' }, simulated: true };
  }
  try {
    const status = await getBrokerOrderStatus(orderId, { environment, strategy });
    if (status?.gone) return { terminated: true, filled: false, status };
    if (status?.isFilled) return { terminated: true, filled: true, status };
    if (isConfirmedCancelledStatus(status) || (status?.isTerminal && !status?.isFilled)) {
      return { terminated: true, filled: false, status };
    }
    return { terminated: false, filled: false, status, reason: status?.status || 'still_working' };
  } catch (err) {
    if (isBrokerOrderGoneError(err)) {
      return { terminated: true, filled: false, gone: true, status: { gone: true, status: 'cancelled' } };
    }
    return { terminated: false, filled: false, reason: err.message, error: err };
  }
}

export async function cancelBrokerOrder(orderId, { environment = 'paper', strategy = 'unknown' } = {}) {
  if (!orderId) return { cancelled: false, reason: 'no_order_id' };
  if (String(orderId).startsWith('PAPER-')) {
    console.log(`[PAPER][${strategy}] Cancel broker order ${orderId}`);
    return { cancelled: true, orderId, paper: true };
  }

  const orderEnvironment = normalizeOrderEnvironment(environment);
  if (orderEnvironment === 'live') {
    assertLiveCredentialsForStrategy(strategy);
  } else if (!hasCredentialsForEnvironment('paper')) {
    return { cancelled: true, orderId, simulated: true };
  }

  const { credentials, sessionRef } = getCredentialsForOrderEnvironment(orderEnvironment);
  const accountNumber = await tastytradeGetAccountWithCredentials(credentials, sessionRef);
  return tastytradeCancelOrderWithCredentials(credentials, sessionRef, accountNumber, orderId);
}

export async function getBrokerOrderStatus(orderId, { environment = 'paper', strategy = 'unknown' } = {}) {
  if (!orderId) return { status: 'unknown', isFilled: false, isTerminal: false };
  if (String(orderId).startsWith('PAPER-')) {
    return { status: 'paper', isFilled: false, isTerminal: false, paper: true };
  }

  const orderEnvironment = normalizeOrderEnvironment(environment);
  if (orderEnvironment === 'live') {
    assertLiveCredentialsForStrategy(strategy);
  } else if (!hasCredentialsForEnvironment('paper')) {
    return { status: 'simulated', isFilled: false, isTerminal: false, simulated: true };
  }

  const { credentials, sessionRef } = getCredentialsForOrderEnvironment(orderEnvironment);
  const accountNumber = await tastytradeGetAccountWithCredentials(credentials, sessionRef);
  return tastytradeGetOrderStatusWithCredentials(credentials, sessionRef, accountNumber, orderId);
}

/**
 * Confirm Tastytrade authentication (OAuth2 preferred for sandbox, sessions fallback).
 * @see https://developer.tastytrade.com/oauth/
 * Token exchange: POST {baseUrl}/oauth/token with grant_type=refresh_token
 */
export async function verifyTastytradeOAuthAuthentication({ environment = 'paper' } = {}) {
  const orderEnvironment = normalizeOrderEnvironment(environment);
  if (!hasCredentialsForEnvironment(orderEnvironment)) {
    return {
      authenticated: false,
      reason: 'missing_credentials',
      environment: orderEnvironment,
      requiredEnv:
        orderEnvironment === 'live'
          ? [
              'TASTYTRADE_LIVE_ACCOUNT_NUMBER',
              'TASTYTRADE_LIVE_CLIENT_SECRET + TASTYTRADE_LIVE_REFRESH_TOKEN (preferred OAuth)',
              '(optional) TASTYTRADE_LIVE_CLIENT_ID',
              '(legacy) TASTYTRADE_LIVE_TOKEN or TASTYTRADE_LIVE_USERNAME/PASSWORD',
            ]
          : [
              'TASTYTRADE_SANDBOX_CLIENT_SECRET',
              'TASTYTRADE_SANDBOX_REFRESH_TOKEN',
              '(optional) TASTYTRADE_SANDBOX_CLIENT_ID',
              '(sandbox) username/password is not supported — OAuth2 only',
            ],
    };
  }

  const { credentials, sessionRef } = getCredentialsForOrderEnvironment(orderEnvironment);
  clearSessionRef(sessionRef);

  const authMethod = usesOAuth(credentials)
    ? 'oauth2'
    : credentials.sandbox
      ? 'oauth2_required'
      : credentials.token
        ? 'static_token'
        : 'sessions';

  const baseUrl = getTastytradeBaseUrlForCredentials(credentials);

  try {
    await tastytradeLoginWithCredentials(credentials, sessionRef);
    const accountNumber = await tastytradeGetAccountWithCredentials(credentials, sessionRef);

    return {
      authenticated: true,
      environment: orderEnvironment,
      sandbox: credentials.sandbox,
      authMethod,
      accountNumber,
      tokenExpiresAt: sessionRef.expiresAt ? new Date(sessionRef.expiresAt).toISOString() : null,
      oauthEndpoint: `${baseUrl}/oauth/token`,
    };
  } catch (err) {
    return {
      authenticated: false,
      environment: orderEnvironment,
      sandbox: credentials.sandbox,
      authMethod,
      error: err.message,
      oauthEndpoint: `${baseUrl}/oauth/token`,
    };
  }
}

/**
 * Dry-run validation that Tastytrade cert/live API accepts equity-option stop orders.
 * Does not submit a live order.
 */
export async function verifyTastytradeStopOrderSupport({
  environment = 'paper',
  optionSymbol = 'SPY   250117C00500000',
  quantity = 1,
  stopTrigger = 1.0,
} = {}) {
  const orderEnvironment = normalizeOrderEnvironment(environment);
  if (!hasCredentialsForEnvironment(orderEnvironment)) {
    return {
      supported: false,
      reason: 'missing_credentials',
      environment: orderEnvironment,
    };
  }

  const auth = await verifyTastytradeOAuthAuthentication({ environment: orderEnvironment });
  if (!auth.authenticated) {
    return {
      supported: false,
      reason: 'authentication_failed',
      environment: orderEnvironment,
      auth,
    };
  }

  const { credentials, sessionRef } = getCredentialsForOrderEnvironment(orderEnvironment);
  const accountNumber = auth.accountNumber || (await tastytradeGetAccountWithCredentials(credentials, sessionRef));

  const checks = {};
  for (const orderType of ['stop_market', 'stop_limit']) {
    try {
      const limitPrice = orderType === 'stop_limit' ? stopTrigger * 0.95 : null;
      await tastytradeSubmitStopOrderWithCredentials(credentials, sessionRef, {
        accountNumber,
        optionSymbol,
        quantity,
        stopTrigger,
        limitPrice,
        orderType,
        dryRun: true,
      });
      checks[orderType] = { valid: true };
    } catch (err) {
      checks[orderType] = { valid: false, error: err.message };
    }
  }

  const supported = Object.values(checks).some((c) => c.valid);
  return {
    supported,
    environment: orderEnvironment,
    sandbox: credentials.sandbox,
    accountNumber,
    auth,
    checks,
  };
}

function parseBalanceField(data, ...keys) {
  for (const key of keys) {
    const value = data?.[key];
    if (value != null && value !== '') {
      const parsed = parseNumber(value);
      if (parsed != null) return parsed;
    }
  }
  return null;
}

export async function getLiveAccountBalances() {
  if (!hasLiveCredentialsConfigured()) {
    throw new Error('Live Tastytrade credentials are not configured');
  }

  const { credentials, sessionRef } = getCredentialsForOrderEnvironment('live');
  const accountNumber = await tastytradeGetAccountWithCredentials(credentials, sessionRef);
  const json = await tastytradeRequestWithCredentials(
    credentials,
    sessionRef,
    `/accounts/${accountNumber}/balances`
  );
  const data = json?.data || json;
  const settledCashBalance = parseBalanceField(
    data,
    'cash-balance',
    'cash_balance',
    'cash-available-for-trading',
    'cash_available_for_trading'
  );
  const pendingCash = parseBalanceField(data, 'pending-cash', 'pending_cash') ?? 0;
  const pendingCashEffect =
    data?.['pending-cash-effect'] ?? data?.pending_cash_effect ?? null;
  const tradableBalance = computeTradableCashBalance(data);
  const netLiquidatingValue = parseBalanceField(
    data,
    'net-liquidating-value',
    'net_liquidating_value',
    'equity',
    'account-value',
    'account_value'
  );

  // cashBalance is the tradable figure used by live Remaining / FCFS sizing.
  // Settled-only cash is exposed separately so daily-loss baseline stays conservative.
  return {
    accountNumber,
    cashBalance: tradableBalance || settledCashBalance || netLiquidatingValue || 0,
    settledCashBalance: settledCashBalance ?? 0,
    pendingCash,
    pendingCashEffect,
    tradableBalance: tradableBalance || 0,
    netLiquidatingValue: netLiquidatingValue ?? settledCashBalance ?? 0,
    raw: data,
  };
}

/**
 * Dry-run option order against Tastytrade via POST .../orders/dry-run
 * (never routes to the exchange). Refuses quantity !== 1.
 *
 * NOTE: X-Tastyworks-Validate-Only on /orders is NOT sufficient — live testing
 * showed it still created a real resting order. Use the dedicated dry-run path.
 */
export async function submitOptionOrderValidateOnly({
  environment = 'live',
  ticker = 'SPY',
  direction = 'CALL',
  quantity = 1,
  strategy = 'validate_only',
} = {}) {
  if (Number(quantity) !== 1) {
    throw new Error('submitOptionOrderValidateOnly refuses quantity !== 1');
  }

  const orderEnvironment = normalizeOrderEnvironment(environment);
  if (orderEnvironment === 'live') {
    assertLiveCredentialsForStrategy(strategy);
  } else if (!hasCredentialsForEnvironment('paper')) {
    throw new Error('Sandbox credentials required for paper validate-only');
  }

  const { credentials, sessionRef } = getCredentialsForOrderEnvironment(orderEnvironment);
  const scopesUsed = String(credentials.oauthScopes || DEFAULT_TASTYTRADE_OAUTH_SCOPES).trim();
  const accountNumber = await tastytradeGetAccountWithCredentials(credentials, sessionRef);

  const symbol = toTastytradeSymbol(ticker);
  const chainJson = await tastytradeRequestWithCredentials(
    credentials,
    sessionRef,
    `/option-chains/${encodeURIComponent(symbol)}/nested`
  );
  const expirations = extractExpirations(chainJson);
  const exp =
    expirations.find((e) => Number(e['days-to-expiration'] ?? e.days_to_expiration) >= 1) ||
    expirations[0];
  if (!exp) throw new Error(`No nested-chain expirations for ${ticker}`);

  const expiration = normalizeExpirationDate(
    exp['expiration-date'] || exp.expiration_date || exp.expiration
  );
  const strikes = extractStrikes(exp);
  const mid = strikes[Math.floor(strikes.length / 2)];
  if (!mid) throw new Error(`No strikes for ${ticker} ${expiration}`);

  const quotes = readLegQuotes(mid, direction);
  const optionSymbol = quotes.optionSymbol;
  const strike = parseNumber(mid['strike-price'] ?? mid.strike_price ?? mid.strike);
  if (!optionSymbol || strike == null) {
    throw new Error(`Could not resolve ${direction} symbol/strike for validate-only`);
  }

  // Cheap resting limit — format/BP check only via dry-run endpoint.
  const limitPrice = 0.01;
  const orderBody = {
    'order-type': 'Limit',
    'time-in-force': 'Day',
    price: String(limitPrice),
    'price-effect': 'Debit',
    legs: [
      {
        'instrument-type': 'Equity Option',
        symbol: optionSymbol,
        quantity: 1,
        action: 'Buy to Open',
      },
    ],
  };

  // Dedicated dry-run URL — do NOT POST to /orders (that places for real).
  const dryRunPath = `/accounts/${accountNumber}/orders/dry-run`;
  if (!dryRunPath.endsWith('/orders/dry-run')) {
    throw new Error('REFUSING: dry-run path malformed — aborting before any POST');
  }

  await ensureTastytradeSession(credentials, sessionRef);
  const url = `${getTastytradeBaseUrlForCredentials(credentials)}${dryRunPath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': TASTYTRADE_USER_AGENT,
      Authorization: `Bearer ${sessionRef.value}`,
    },
    body: JSON.stringify(orderBody),
  });
  const rawBody = await res.text();
  let parsed = null;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    parsed = null;
  }

  // Dry-run responses may include a synthetic order id; confirm it is NOT a live order.
  const maybeId = parsed?.data?.order?.id ?? parsed?.data?.id ?? null;
  let existsAsLiveOrder = null;
  if (maybeId != null) {
    try {
      const liveCheck = await tastytradeRequestWithCredentials(
        credentials,
        sessionRef,
        `/accounts/${accountNumber}/orders/${maybeId}`
      );
      existsAsLiveOrder = Boolean(liveCheck?.data || liveCheck?.id || liveCheck);
    } catch (err) {
      // 404 / not found → dry-run did not persist a real order (expected).
      existsAsLiveOrder = false;
      parsed = {
        ...(parsed && typeof parsed === 'object' ? parsed : {}),
        _liveOrderLookup: { orderId: maybeId, found: false, error: err.message },
      };
    }
  }

  return {
    validateOnly: true,
    dryRunEndpoint: dryRunPath,
    noRealOrderSubmitted: existsAsLiveOrder !== true,
    environment: orderEnvironment,
    sandbox: Boolean(credentials.sandbox),
    accountNumber,
    scopesUsed,
    scopesIncludeTrade: /\btrade\b/i.test(scopesUsed),
    contract: {
      ticker: symbol,
      direction,
      strike,
      expiration,
      optionSymbol,
      quantity: 1,
      limitPrice,
    },
    httpStatus: res.status,
    httpOk: res.ok,
    syntheticOrderId: maybeId,
    existsAsLiveOrder,
    responseBody: parsed,
    responseRaw: rawBody,
  };
}

/**
 * POST /accounts/{id}/complex-orders/dry-run for an OTO entry+stop. Never POST /complex-orders.
 */
export async function submitOtoEntryStopValidateOnly({
  environment = 'live',
  ticker = 'SPY',
  direction = 'PUT',
  quantity = 1,
  strategy = 'oto_validate_only',
} = {}) {
  if (Number(quantity) !== 1) {
    throw new Error('submitOtoEntryStopValidateOnly refuses quantity !== 1');
  }
  const orderEnvironment = normalizeOrderEnvironment(environment);
  if (orderEnvironment === 'live') {
    assertLiveCredentialsForStrategy(strategy);
  } else if (!hasCredentialsForEnvironment('paper')) {
    throw new Error('Sandbox credentials required for paper OTO validate-only');
  }

  const { credentials, sessionRef } = getCredentialsForOrderEnvironment(orderEnvironment);
  const accountNumber = await tastytradeGetAccountWithCredentials(credentials, sessionRef);
  const symbol = toTastytradeSymbol(ticker);
  const chainJson = await tastytradeRequestWithCredentials(
    credentials,
    sessionRef,
    `/option-chains/${encodeURIComponent(symbol)}/nested`
  );
  const expirations = extractExpirations(chainJson);
  const exp =
    expirations.find((e) => Number(e['days-to-expiration'] ?? e.days_to_expiration) >= 1) ||
    expirations[0];
  if (!exp) throw new Error(`No nested-chain expirations for ${ticker}`);
  const expiration = normalizeExpirationDate(
    exp['expiration-date'] || exp.expiration_date || exp.expiration
  );
  const strikes = extractStrikes(exp);
  const mid = strikes[Math.floor(strikes.length / 2)];
  const quotes = readLegQuotes(mid, direction);
  const optionSymbol = quotes.optionSymbol;
  if (!optionSymbol) throw new Error('Could not resolve option symbol for OTO dry-run');

  const dryRunPath = `/accounts/${accountNumber}/complex-orders/dry-run`;
  if (!dryRunPath.endsWith('/complex-orders/dry-run')) {
    throw new Error('REFUSING: OTO dry-run path malformed');
  }

  const result = await tastytradeSubmitOtoEntryStopWithCredentials(credentials, sessionRef, {
    accountNumber,
    optionSymbol,
    quantity: 1,
    entryPrice: 0.05,
    stopTrigger: 0.04,
    stopOrderType: 'stop_market',
    dryRun: true,
  });

  return {
    validateOnly: true,
    dryRunEndpoint: dryRunPath,
    noRealOrderSubmitted: true,
    environment: orderEnvironment,
    sandbox: Boolean(credentials.sandbox),
    accountNumber,
    expiration,
    optionSymbol,
    ...result,
  };
}

export { WATCHED_TICKERS, isPaperTrading, hasCredentialsForEnvironment };
