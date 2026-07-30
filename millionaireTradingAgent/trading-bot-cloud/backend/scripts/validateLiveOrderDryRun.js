#!/usr/bin/env node
/**
 * Live (or paper) option order DRY-RUN check.
 * Uses POST /accounts/{id}/orders/dry-run — never POST /orders.
 * (X-Tastyworks-Validate-Only on /orders does NOT prevent real orders.)
 *
 * Usage: node backend/scripts/validateLiveOrderDryRun.js
 *        node backend/scripts/validateLiveOrderDryRun.js live
 *        node backend/scripts/validateLiveOrderDryRun.js paper
 */
import 'dotenv/config';
import {
  verifyTastytradeOAuthAuthentication,
  submitOptionOrderValidateOnly,
} from '../brokerageConnector.js';

const environment = process.argv[2] || 'live';

async function main() {
  if (environment !== 'live' && environment !== 'paper') {
    console.error('Usage: node backend/scripts/validateLiveOrderDryRun.js [live|paper]');
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify(
      {
        step: 'safety',
        mode: 'dry-run-endpoint',
        environment,
        note: 'POST /accounts/{id}/orders/dry-run only — never POST /orders',
      },
      null,
      2
    )
  );

  const auth = await verifyTastytradeOAuthAuthentication({ environment });
  console.log(JSON.stringify({ step: 'authentication', ...auth }, null, 2));
  if (!auth.authenticated) {
    process.exitCode = 1;
    return;
  }

  const result = await submitOptionOrderValidateOnly({
    environment,
    ticker: 'SPY',
    direction: 'CALL',
    quantity: 1,
    strategy: 'live_order_validate_only',
  });

  console.log(JSON.stringify({ step: 'validate_only_order', ...result }, null, 2));

  console.log(
    JSON.stringify(
      {
        step: 'confirmation',
        validateOnly: result.validateOnly === true,
        dryRunEndpoint: result.dryRunEndpoint || null,
        noRealOrderSubmitted: result.noRealOrderSubmitted === true,
        existsAsLiveOrder: result.existsAsLiveOrder,
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
