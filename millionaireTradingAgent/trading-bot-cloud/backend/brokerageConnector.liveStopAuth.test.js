import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetTastytradeSessionsForTests,
  submitOptionStopOrder,
} from './brokerageConnector.js';

const LIVE_REFRESH = 'live-refresh-sentinel';
const SANDBOX_REFRESH = 'sandbox-refresh-sentinel';
const LIVE_SECRET = 'live-secret-sentinel';
const SANDBOX_SECRET = 'sandbox-secret-sentinel';

const ENV_KEYS = [
  'TASTYTRADE_SANDBOX',
  'TASTYTRADE_ACCOUNT_NUMBER',
  'TASTYTRADE_SANDBOX_CLIENT_ID',
  'TASTYTRADE_SANDBOX_CLIENT_SECRET',
  'TASTYTRADE_SANDBOX_REFRESH_TOKEN',
  'TASTYTRADE_LIVE_ACCOUNT_NUMBER',
  'TASTYTRADE_LIVE_CLIENT_ID',
  'TASTYTRADE_LIVE_CLIENT_SECRET',
  'TASTYTRADE_LIVE_REFRESH_TOKEN',
  'BROKER_DRY_RUN',
];

function chainBody() {
  return {
    data: {
      items: [
        {
          expirations: [
            {
              'expiration-date': '2026-09-30',
              strikes: [
                {
                  'strike-price': 767,
                  call: 'SPY   260930C00767000',
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

function orderBody(id = '9001') {
  return {
    data: {
      id,
      status: 'Live',
      'stop-trigger': '1.32',
      legs: [{ quantity: 1, 'remaining-quantity': 1, 'instrument-type': 'Equity Option' }],
    },
  };
}

function installFetch({ sandboxRefreshStatus = 400 } = {}) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const href = String(url);
    const body = options.body == null ? '' : String(options.body);
    calls.push({ href, method: options.method || 'GET', body });

    if (href.startsWith('https://api.cert.tastyworks.com/oauth/token')) {
      if (sandboxRefreshStatus !== 200) {
        return new Response(
          JSON.stringify({ error_code: 'invalid_grant', error_description: 'Grant revoked' }),
          { status: sandboxRefreshStatus, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ access_token: 'sandbox-access', expires_in: 900 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (href.startsWith('https://api.tastyworks.com/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'live-access', expires_in: 900 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (href.includes('/option-chains/')) {
      return new Response(JSON.stringify(chainBody()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (href.includes('/orders')) {
      const id = href.split('/').pop();
      const orderId = id && id !== 'orders' ? id : '9001';
      return new Response(JSON.stringify(orderBody(orderId === 'orders' ? '9001' : orderId)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('unexpected', { status: 500 });
  };
  return {
    calls,
    restore() {
      global.fetch = original;
    },
  };
}

const position = {
  ticker: 'SPY',
  direction: 'CALL',
  strike: 767,
  expiration: '2026-09-30',
  quantity: 1,
  entry_premium: 1.55,
};

describe('live stop lookup uses production Tastytrade credentials', () => {
  const saved = new Map();

  beforeEach(() => {
    resetTastytradeSessionsForTests();
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    delete process.env.TASTYTRADE_SANDBOX;
    delete process.env.BROKER_DRY_RUN;
    process.env.TASTYTRADE_ACCOUNT_NUMBER = 'SANDBOXACCT';
    process.env.TASTYTRADE_SANDBOX_CLIENT_ID = 'sandbox-client';
    process.env.TASTYTRADE_SANDBOX_CLIENT_SECRET = SANDBOX_SECRET;
    process.env.TASTYTRADE_SANDBOX_REFRESH_TOKEN = SANDBOX_REFRESH;
    process.env.TASTYTRADE_LIVE_ACCOUNT_NUMBER = 'LIVEACCT';
    process.env.TASTYTRADE_LIVE_CLIENT_ID = 'live-client';
    process.env.TASTYTRADE_LIVE_CLIENT_SECRET = LIVE_SECRET;
    process.env.TASTYTRADE_LIVE_REFRESH_TOKEN = LIVE_REFRESH;
  });

  afterEach(() => {
    resetTastytradeSessionsForTests();
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('never selects sandbox credentials and posts the stop on api.tastyworks.com', async () => {
    const fetchMock = installFetch({ sandboxRefreshStatus: 400 });
    try {
      const result = await submitOptionStopOrder(position, {
        quantity: 1,
        stopTrigger: 1.32,
        environment: 'live',
        strategy: 'orb',
      });
      assert.equal(result.resting, true);
      assert.equal(result.environment, 'live');
      assert.equal(result.sandbox, false);
      assert.equal(result.optionSymbol, 'SPY   260930C00767000');

      const hosts = fetchMock.calls.map((call) => new URL(call.href).host);
      assert.ok(hosts.length > 0);
      assert.ok(hosts.every((host) => host === 'api.tastyworks.com'));
      assert.ok(fetchMock.calls.some((call) => call.href.includes('/option-chains/')));
      assert.ok(fetchMock.calls.some((call) => call.href.includes('/oauth/token')));

      const bodies = fetchMock.calls.map((call) => call.body).join('\n');
      assert.match(bodies, new RegExp(LIVE_REFRESH));
      assert.doesNotMatch(bodies, new RegExp(SANDBOX_REFRESH));
      assert.doesNotMatch(bodies, new RegExp(SANDBOX_SECRET));
    } finally {
      fetchMock.restore();
    }
  });

  it('still places the live stop when the sandbox grant is revoked', async () => {
    const fetchMock = installFetch({ sandboxRefreshStatus: 400 });
    try {
      const result = await submitOptionStopOrder(position, {
        quantity: 1,
        stopTrigger: 1.32,
        environment: 'live',
        strategy: 'orb',
      });
      assert.equal(result.resting, true);
      assert.ok(String(result.orderId).length > 0);
      assert.equal(
        fetchMock.calls.some((call) => call.href.includes('api.cert.tastyworks.com')),
        false
      );
    } finally {
      fetchMock.restore();
    }
  });

  it('paper stop lookup still uses sandbox credentials on the cert host', async () => {
    const fetchMock = installFetch({ sandboxRefreshStatus: 200 });
    try {
      const result = await submitOptionStopOrder(position, {
        quantity: 1,
        stopTrigger: 1.32,
        environment: 'paper',
        strategy: 'orb',
      });
      assert.equal(result.resting, true);
      assert.equal(result.environment, 'paper');
      assert.equal(result.sandbox, true);

      const hosts = fetchMock.calls.map((call) => new URL(call.href).host);
      assert.ok(hosts.every((host) => host === 'api.cert.tastyworks.com'));
      const bodies = fetchMock.calls.map((call) => call.body).join('\n');
      assert.match(bodies, new RegExp(SANDBOX_REFRESH));
      assert.doesNotMatch(bodies, new RegExp(LIVE_REFRESH));
    } finally {
      fetchMock.restore();
    }
  });
});
