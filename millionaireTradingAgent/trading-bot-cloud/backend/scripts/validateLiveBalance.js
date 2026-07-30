/**
 * End-to-end proof: fetch live Tastytrade account balances.
 * Loads .env; prints account + cash/NLV only (never prints secrets).
 *
 * Usage: node backend/scripts/validateLiveBalance.js
 */
import 'dotenv/config';
import {
  getLiveAccountBalances,
  hasLiveCredentialsConfigured,
} from '../brokerageConnector.js';

function authModeFromEnv() {
  const hasOAuth = !!(
    String(process.env.TASTYTRADE_LIVE_CLIENT_SECRET || '').trim() &&
    String(process.env.TASTYTRADE_LIVE_REFRESH_TOKEN || '').trim()
  );
  const hasToken = !!String(process.env.TASTYTRADE_LIVE_TOKEN || '').trim();
  const hasUserPass = !!(
    String(process.env.TASTYTRADE_LIVE_USERNAME || '').trim() &&
    String(process.env.TASTYTRADE_LIVE_PASSWORD || '').trim()
  );
  // Must match tastytradeLoginWithCredentials preference order
  if (hasOAuth) return 'oauth_refresh';
  if (hasUserPass) return 'username_password';
  if (hasToken) return 'static_token';
  return 'none';
}

async function main() {
  const account =
    process.env.TASTYTRADE_LIVE_ACCOUNT_NUMBER || process.env.TASTYTRADE_LIVE_ACCOUNT || '';
  const mode = authModeFromEnv();

  console.log(
    JSON.stringify(
      {
        hasLiveCredentialsConfigured: hasLiveCredentialsConfigured(),
        authMode: mode,
        expectedAccountConfigured: Boolean(String(account).trim()),
      },
      null,
      2
    )
  );

  if (!hasLiveCredentialsConfigured()) {
    console.error('FAIL: live credentials not configured');
    process.exit(1);
  }

  const balances = await getLiveAccountBalances();
  const cash = Number(balances.cashBalance);
  const nlv = Number(balances.netLiquidatingValue);

  if (!Number.isFinite(cash)) {
    console.error('FAIL: cashBalance is not a finite number');
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        accountNumber: balances.accountNumber,
        cashBalance: cash,
        netLiquidatingValue: Number.isFinite(nlv) ? nlv : null,
        authMode: mode,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
