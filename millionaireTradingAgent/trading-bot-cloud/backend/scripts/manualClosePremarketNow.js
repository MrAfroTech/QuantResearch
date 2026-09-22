#!/usr/bin/env node
/**
 * One-shot: flatten the open live Premarket position at the current mark.
 */
import { closeOptionOrder, getOptionPremium, cancelBrokerOrder } from '../brokerageConnector.js';
import {
  getPremarketOpenPositions,
  closePremarketPosition,
} from '../premarketBreakout/premarketDb.js';
import { getStrategyEnvironment } from '../strategyEnvironment.js';
import { sendPremarketTradeClosedTelegram } from '../premarketBreakout/premarketTelegram.js';

async function main() {
  const positions = await getPremarketOpenPositions();
  if (!positions.length) {
    console.log(JSON.stringify({ ok: false, reason: 'no_open_premarket_position' }));
    return;
  }

  const position = positions.find((p) => Number(p.id) === 95) || positions[0];
  const qty = Number(position.contracts_open ?? position.quantity) || 0;
  const entry = Number(position.entry_premium);
  const environment = await getStrategyEnvironment('premarket');

  const exitPremium = await getOptionPremium(
    position.ticker,
    position.direction,
    position.strike,
    position.expiration
  );
  const pnlPct = Number.isFinite(entry) && entry > 0
    ? ((exitPremium - entry) / entry) * 100
    : null;

  console.log(
    JSON.stringify({
      step: 'quote',
      id: position.id,
      ticker: position.ticker,
      direction: position.direction,
      strike: position.strike,
      expiration: position.expiration,
      qty,
      entry,
      exitPremium,
      pnlPct,
      environment,
    })
  );

  if (environment !== 'live') {
    throw new Error(`Refusing close: premarket environment is ${environment}, expected live`);
  }

  if (position.broker_stop_order_id) {
    try {
      await cancelBrokerOrder(position.broker_stop_order_id, {
        environment,
        strategy: 'premarket',
      });
      console.log(JSON.stringify({ step: 'cancelled_stop', orderId: 'redacted' }));
    } catch (err) {
      console.warn(JSON.stringify({ step: 'cancel_stop_failed', error: err.message }));
    }
  }

  const closeResult = await closeOptionOrder(position, exitPremium, qty, {
    environment,
    strategy: 'premarket',
  });

  const reason = closeResult?.noBrokerPosition
    ? closeResult.reason || 'manual_close_already_flat'
    : 'manual_close';
  const dbPnl = closeResult?.noBrokerPosition ? 0 : pnlPct;
  const fillPrice = closeResult?.fillPrice ?? exitPremium;

  await closePremarketPosition(position.id, fillPrice, dbPnl, reason, qty);

  try {
    await sendPremarketTradeClosedTelegram({
      ticker: position.ticker,
      reason,
      pnlPct: (Number(dbPnl) || 0) / 100,
    });
  } catch (err) {
    console.warn(JSON.stringify({ step: 'telegram_failed', error: err.message }));
  }

  console.log(
    JSON.stringify({
      step: 'done',
      ok: true,
      reason,
      filled: Boolean(closeResult?.filled),
      status: closeResult?.status || null,
      fillPrice: closeResult?.fillPrice ?? null,
      quotedPnlPct: pnlPct,
      noBrokerPosition: Boolean(closeResult?.noBrokerPosition),
    })
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exitCode = 1;
});
