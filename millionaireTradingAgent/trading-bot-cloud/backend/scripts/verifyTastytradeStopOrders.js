#!/usr/bin/env node
/**
 * Dry-run verification that Tastytrade cert API authenticates via OAuth2 and accepts stop orders.
 * Usage: node backend/scripts/verifyTastytradeStopOrders.js [paper|live]
 *
 * Sandbox (paper) expects OAuth2 credentials per https://developer.tastytrade.com/oauth/
 */
import 'dotenv/config';
import {
  verifyTastytradeOAuthAuthentication,
  verifyTastytradeStopOrderSupport,
} from '../brokerageConnector.js';

const environment = process.argv[2] || 'paper';

async function main() {
  console.log(`Verifying Tastytrade authentication (${environment})...`);
  const auth = await verifyTastytradeOAuthAuthentication({ environment });
  console.log(JSON.stringify({ step: 'authentication', ...auth }, null, 2));

  if (!auth.authenticated) {
    process.exitCode = 1;
    return;
  }

  console.log(`\nVerifying stop order dry-run support (${environment})...`);
  const result = await verifyTastytradeStopOrderSupport({ environment });
  console.log(JSON.stringify({ step: 'stop_orders', ...result }, null, 2));

  if (!result.supported) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
