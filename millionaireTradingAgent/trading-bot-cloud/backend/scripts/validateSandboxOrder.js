#!/usr/bin/env node
/**
 * End-to-end: place a real Tastytrade *sandbox* limit order (not PAPER- fake ID),
 * confirm status via API, then cancel. Optionally attempt a marketable fill + close.
 *
 * Usage: node backend/scripts/validateSandboxOrder.js
 *        node backend/scripts/validateSandboxOrder.js --with-close
 */
import 'dotenv/config';
import {
  placeOptionOrder,
  closeOptionOrder,
  getBrokerOrderStatus,
  cancelBrokerOrder,
  verifyTastytradeOAuthAuthentication,
} from '../brokerageConnector.js';

const withClose = process.argv.includes('--with-close');

async function pickContractFromSandboxChain() {
  const clientId = process.env.TASTYTRADE_SANDBOX_CLIENT_ID;
  const clientSecret = process.env.TASTYTRADE_SANDBOX_CLIENT_SECRET;
  const refreshToken = process.env.TASTYTRADE_SANDBOX_REFRESH_TOKEN;
  const tokenRes = await fetch('https://api.cert.tastyworks.com/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'trading-bot-cloud/1.0',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_secret: clientSecret,
      client_id: clientId,
      scope: process.env.TASTYTRADE_OAUTH_SCOPES || 'read trade',
    }),
  });
  if (!tokenRes.ok) throw new Error(`sandbox oauth failed: ${tokenRes.status}`);
  const tokenJson = await tokenRes.json();
  const access = tokenJson.access_token || tokenJson.data?.access_token;
  if (!access) throw new Error('sandbox oauth: no access_token');

  const chainRes = await fetch('https://api.cert.tastyworks.com/option-chains/SPY/nested', {
    headers: {
      Authorization: `Bearer ${access}`,
      Accept: 'application/json',
      'User-Agent': 'trading-bot-cloud/1.0',
    },
  });
  if (!chainRes.ok) throw new Error(`nested chain failed: ${chainRes.status}`);
  const chain = await chainRes.json();
  const root = chain?.data?.items?.[0] || chain?.data || {};
  const exps = root.expirations || [];
  // Prefer an expiration with DTE >= 1 so the contract is less likely to be halted/invalid
  const exp =
    exps.find((e) => Number(e['days-to-expiration'] ?? e.days_to_expiration) >= 1) || exps[0];
  if (!exp) throw new Error('No SPY expirations on sandbox nested chain');

  const expiration = String(exp['expiration-date'] || exp.expiration_date || exp.expiration).slice(0, 10);
  const strikes = exp.strikes || [];
  const mid = strikes[Math.floor(strikes.length / 2)];
  if (!mid) throw new Error('No strikes on chosen expiration');

  const call = mid.call;
  const optionSymbol =
    typeof call === 'string'
      ? call.trim()
      : call?.symbol || mid['call-symbol'] || call?.['streamer-symbol'] || mid['call-streamer-symbol'];
  const strike = Number(mid['strike-price'] ?? mid.strike_price ?? mid.strike);
  const bid = Number(
    (typeof call === 'object' && call?.['bid-price']) || mid['call-bid'] || 0
  );
  const ask = Number(
    (typeof call === 'object' && call?.['ask-price']) || mid['call-ask'] || 0
  );
  const midPx = bid > 0 && ask > 0 ? (bid + ask) / 2 : ask || bid || 0.05;

  if (!optionSymbol || !Number.isFinite(strike)) {
    throw new Error('Could not resolve call symbol/strike from nested chain');
  }

  return {
    ticker: 'SPY',
    direction: 'CALL',
    strike,
    expiration,
    quantity: 1,
    // Slightly below mid so we get a resting order (real id) without needing a fill
    premium: Math.max(0.01, Number((midPx * 0.5).toFixed(2))),
    // Aggressive limit for fill attempts (cert liquidity is thin)
    marketablePremium: Math.max(1, Number((Math.max(midPx, ask, 0.5) * 5).toFixed(2))),
    optionSymbolHint: optionSymbol,
  };
}

async function main() {
  const auth = await verifyTastytradeOAuthAuthentication({ environment: 'paper' });
  console.log(
    JSON.stringify(
      {
        step: 'auth',
        authenticated: auth.authenticated,
        accountNumber: auth.accountNumber || null,
        oauthEndpoint: auth.oauthEndpoint || null,
      },
      null,
      2
    )
  );
  if (!auth.authenticated) {
    process.exitCode = 1;
    return;
  }

  const contract = await pickContractFromSandboxChain();
  console.log(JSON.stringify({ step: 'contract', ...contract }, null, 2));

  const order = await placeOptionOrder({
    ticker: contract.ticker,
    direction: contract.direction,
    strike: contract.strike,
    expiration: contract.expiration,
    quantity: contract.quantity,
    premium: contract.premium,
    environment: 'paper',
    strategy: 'sandbox_validation',
  });

  const looksFake = String(order.orderId || '').startsWith('PAPER-');
  console.log(
    JSON.stringify(
      {
        step: 'place',
        orderId: order.orderId,
        isFakePaperId: looksFake,
        environment: order.environment,
        sandbox: order.sandbox,
        status: order.status,
        fillPrice: order.fillPrice,
        filled: order.filled,
      },
      null,
      2
    )
  );

  if (looksFake || !order.orderId) {
    console.error('FAIL: expected a real Tastytrade sandbox order id');
    process.exitCode = 1;
    return;
  }

  const status = await getBrokerOrderStatus(order.orderId, {
    environment: 'paper',
    strategy: 'sandbox_validation',
  });
  console.log(
    JSON.stringify(
      {
        step: 'status',
        orderId: order.orderId,
        status: status.status,
        isFilled: status.isFilled,
        isTerminal: status.isTerminal,
        fillPrice: status.fillPrice ?? null,
      },
      null,
      2
    )
  );

  const cancel = await cancelBrokerOrder(order.orderId, {
    environment: 'paper',
    strategy: 'sandbox_validation',
  });
  console.log(JSON.stringify({ step: 'cancel', cancelled: cancel.cancelled, orderId: cancel.orderId }, null, 2));

  let closeResult = null;
  if (withClose) {
    // Marketable BTO → wait for fill → STC via closeOptionOrder (same path ladder exits use)
    const entry = await placeOptionOrder({
      ticker: contract.ticker,
      direction: contract.direction,
      strike: contract.strike,
      expiration: contract.expiration,
      quantity: 1,
      premium: contract.marketablePremium,
      environment: 'paper',
      strategy: 'sandbox_validation_close',
    });
    console.log(
      JSON.stringify(
        {
          step: 'place_marketable',
          orderId: entry.orderId,
          isFakePaperId: String(entry.orderId || '').startsWith('PAPER-'),
          status: entry.status,
          filled: entry.filled,
          fillPrice: entry.fillPrice,
        },
        null,
        2
      )
    );

    if (entry.filled) {
      closeResult = await closeOptionOrder(
        {
          ticker: contract.ticker,
          direction: contract.direction,
          strike: contract.strike,
          expiration: contract.expiration,
          quantity: 1,
        },
        Math.max(0.01, Number((Number(entry.fillPrice || contract.premium) * 0.5).toFixed(2))),
        1,
        { environment: 'paper', strategy: 'sandbox_validation_close' }
      );
      console.log(
        JSON.stringify(
          {
            step: 'close',
            orderId: closeResult.orderId,
            isFakePaperId: String(closeResult.orderId || '').startsWith('PAPER-'),
            status: closeResult.status,
            filled: closeResult.filled,
          },
          null,
          2
        )
      );
    } else {
      // Still exercise the close submit path; may reject if no position exists.
      try {
        closeResult = await closeOptionOrder(
          {
            ticker: contract.ticker,
            direction: contract.direction,
            strike: contract.strike,
            expiration: contract.expiration,
            quantity: 1,
          },
          0.01,
          1,
          { environment: 'paper', strategy: 'sandbox_validation_close' }
        );
        console.log(
          JSON.stringify(
            {
              step: 'close_without_fill',
              orderId: closeResult.orderId,
              isFakePaperId: String(closeResult.orderId || '').startsWith('PAPER-'),
              status: closeResult.status,
            },
            null,
            2
          )
        );
        if (closeResult.orderId && !String(closeResult.orderId).startsWith('PAPER-')) {
          await cancelBrokerOrder(closeResult.orderId, {
            environment: 'paper',
            strategy: 'sandbox_validation_close',
          }).catch(() => {});
        }
      } catch (err) {
        console.log(
          JSON.stringify(
            {
              step: 'close_without_fill',
              submitted: false,
              error: err.message,
              note: 'Close path reached broker; rejection expected if no filled position',
            },
            null,
            2
          )
        );
      }

      if (entry.orderId && !String(entry.orderId).startsWith('PAPER-')) {
        await cancelBrokerOrder(entry.orderId, {
          environment: 'paper',
          strategy: 'sandbox_validation_close',
        }).catch(() => {});
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        tastytradeSandboxOrderId: order.orderId,
        closeOrderId: closeResult?.orderId || null,
        note: 'Order was submitted to api.cert.tastyworks.com (not a local PAPER- id)',
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exitCode = 1;
});
