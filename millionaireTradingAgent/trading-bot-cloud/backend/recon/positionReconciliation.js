/**
 * THE3-2 — Tastytrade ↔ Supabase position/fill reconciliation runner.
 */

import { getOpenPositions, logAlert } from '../db.js';
import { getOrbOpenPositions, logOrbEvent } from '../orb/orbDb.js';
import { getPremarketOpenPositions } from '../premarketBreakout/premarketDb.js';
import { getEmaVwapOpenPositions } from '../emaVwapCross/emaVwapDb.js';
import {
  tastytradeGetOptionPositions,
  tastytradeGetRecentTradeTransactions,
} from '../brokerageConnector.js';
import { underlyingFromOptionSymbol } from '../optionPriceIncrement.js';
import { getSql } from '../sqlClient.js';
import { sendReconMismatchTelegram } from '../telegramHandler.js';
import {
  assertReconIsolation,
  getReconRuntimeConfig,
  mutedUnderlyings,
  resolveActiveDbSchema,
} from './reconConfig.js';
import {
  buildOccSymbol,
  collectUnloggedBrokerFills,
  compareFillPremium,
  compareOpenBooks,
  occKey,
  RECON_MISMATCH,
  toTastyRoot,
} from './positionMatch.js';

function etDateKey(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function loadDbOpenPositions() {
  const [swing, orb, premarket, emavwap] = await Promise.all([
    getOpenPositions(),
    getOrbOpenPositions(),
    getPremarketOpenPositions(),
    getEmaVwapOpenPositions(),
  ]);
  return [
    ...swing.map((r) => ({ ...r, strategy: 'swing' })),
    ...orb.map((r) => ({ ...r, strategy: 'orb' })),
    ...premarket.map((r) => ({ ...r, strategy: 'premarket' })),
    ...emavwap.map((r) => ({ ...r, strategy: 'emavwap' })),
  ].map((r) => ({
    ...r,
    occ: buildOccSymbol(toTastyRoot(r.ticker), r.expiration, r.direction, r.strike),
  }));
}

async function loadTodaysClosedTrades(tradeDate) {
  const sql = getSql();
  // Unqualified tables resolve via connection search_path / public in production.
  const like = `${tradeDate}%`;
  const queries = [
    sql`
      SELECT 'swing' AS strategy, id, ticker, direction, strike, expiration, exit_premium, closed_at
      FROM trade_log
      WHERE closed_at IS NOT NULL AND closed_at::text LIKE ${like}
    `,
    sql`
      SELECT 'orb' AS strategy, id, ticker, direction, strike, expiration, exit_premium, closed_at
      FROM orb_trade_log
      WHERE closed_at IS NOT NULL AND closed_at::text LIKE ${like}
    `,
    sql`
      SELECT 'premarket' AS strategy, id, ticker, direction, strike, expiration, exit_premium, closed_at
      FROM premarket_trade_log
      WHERE closed_at IS NOT NULL AND closed_at::text LIKE ${like}
    `,
    sql`
      SELECT 'emavwap' AS strategy, id, ticker, direction, strike, expiration, exit_premium, closed_at
      FROM emavwap_trade_log
      WHERE closed_at IS NOT NULL AND closed_at::text LIKE ${like}
    `,
  ];
  const results = await Promise.all(
    queries.map((q) =>
      q.catch((err) => {
        console.warn('[THE3-2] trade_log query failed:', err.message);
        return [];
      })
    )
  );
  return results.flat();
}

async function loadLoggedOccKeySetsForDay(tradeDate) {
  const open = await loadDbOpenPositions();
  const openOccKeys = new Set(open.map((r) => occKey(r.occ)));
  const closed = await loadTodaysClosedTrades(tradeDate);
  const closedOccKeys = new Set(
    closed.map((r) =>
      occKey(buildOccSymbol(toTastyRoot(r.ticker), r.expiration, r.direction, r.strike))
    )
  );
  return { openOccKeys, closedOccKeys };
}

function txSymbol(tx) {
  return (
    tx.symbol ||
    tx['instrument-symbol'] ||
    tx.instrument_symbol ||
    tx['underlying-symbol'] ||
    null
  );
}

function txPrice(tx) {
  const n = Number(
    tx.price ?? tx['fill-price'] ?? tx.fill_price ?? tx['average-fill-price'] ?? tx.value
  );
  return Number.isFinite(n) ? Math.abs(n) : null;
}

/**
 * Match today's closed DB rows to broker trade transactions by OCC and compare exit fill.
 */
async function checkClosedFillPrices(transactions) {
  const closed = await loadTodaysClosedTrades(etDateKey());
  const byOcc = new Map();
  for (const tx of transactions || []) {
    const sym = txSymbol(tx);
    if (!sym) continue;
    const key = String(sym).replace(/ /g, '').toUpperCase();
    const list = byOcc.get(key) || [];
    list.push(tx);
    byOcc.set(key, list);
  }

  const mismatches = [];
  for (const row of closed) {
    if (row.exit_premium == null) continue;
    const occ = buildOccSymbol(toTastyRoot(row.ticker), row.expiration, row.direction, row.strike);
    const key = occ.replace(/ /g, '').toUpperCase();
    const txs = byOcc.get(key) || [];
    if (!txs.length) continue;
    // Prefer the transaction price closest to recorded exit_premium
    let best = null;
    for (const tx of txs) {
      const px = txPrice(tx);
      if (px == null) continue;
      const delta = Math.abs(px - Number(row.exit_premium));
      if (!best || delta < best.delta) best = { tx, px, delta };
    }
    if (!best) continue;
    const cmp = compareFillPremium(row.exit_premium, best.px);
    if (!cmp.ok) {
      mismatches.push({
        type: RECON_MISMATCH.FILL_PRICE_MISMATCH,
        severity: 'critical',
        occ,
        detail:
          `Closed ${row.strategy}#${row.id} ${row.ticker} exit_premium=$${Number(row.exit_premium).toFixed(3)} ` +
          `but broker fill≈$${cmp.brokerFillPrice.toFixed(3)}`,
        db: [row],
        broker: best.tx,
      });
    }
  }
  return mismatches;
}

async function persistPreprodEvent(mismatches, summary) {
  try {
    await logOrbEvent({
      ticker: 'RECON',
      tradeDate: etDateKey(),
      eventType: 'recon_mismatch',
      direction: null,
      breakoutLevel: null,
      details: {
        type: 'recon_mismatch',
        source: 'THE3-2',
        mismatch_count: mismatches.length,
        mismatches: mismatches.map((m) => ({
          type: m.type,
          severity: m.severity,
          occ: m.occ,
          detail: m.detail,
        })),
        summary,
      },
    });
  } catch (err) {
    console.error('[THE3-2] preprod event log write failed:', err.message);
  }
}

/**
 * Run one reconciliation cycle. Safe to call from cron.
 */
export async function runPositionReconciliation({ now = new Date() } = {}) {
  const config = getReconRuntimeConfig();
  const schema = resolveActiveDbSchema();
  assertReconIsolation(config, { schema });

  console.log(
    `[THE3-2] recon start mode=${config.mode} schema=${schema} env=${config.orderEnvironment} account=${config.expectedAccount}`
  );

  const { accountNumber, positions: brokerPositions } = await tastytradeGetOptionPositions({
    environment: config.orderEnvironment,
  });
  assertReconIsolation(config, { schema, accountNumber });

  const dbPositions = await loadDbOpenPositions();
  const openCompare = compareOpenBooks(brokerPositions, dbPositions, {
    mutedUnderlyings: mutedUnderlyings(),
    underlyingFromOptionSymbol,
  });

  const tradeDate = etDateKey(now);
  let transactions = [];
  try {
    const txResult = await tastytradeGetRecentTradeTransactions({
      environment: config.orderEnvironment,
      startDate: tradeDate,
    });
    transactions = txResult.transactions || [];
  } catch (err) {
    console.warn('[THE3-2] transaction history unavailable:', err.message);
  }

  const fillMismatches = await checkClosedFillPrices(transactions);
  let unloggedFills = [];
  try {
    const { openOccKeys, closedOccKeys } = await loadLoggedOccKeySetsForDay(tradeDate);
    const muted = mutedUnderlyings();
    unloggedFills = collectUnloggedBrokerFills(transactions, {
      openOccKeys,
      closedOccKeys,
    }).filter((m) => {
      const und = underlyingFromOptionSymbol(m.occ);
      return !(und && muted.has(und));
    });
  } catch (err) {
    console.error('[THE3-2] fill-log check failed:', err.message);
  }

  const actionable = [...openCompare.actionable, ...fillMismatches, ...unloggedFills];
  const muted = openCompare.muted;

  const summary = {
    mode: config.mode,
    schema,
    accountNumber,
    tradeDate,
    brokerOpen: openCompare.brokerCount,
    dbOpen: openCompare.dbCount,
    actionable: actionable.length,
    muted: muted.length,
  };

  if (muted.length) {
    console.log(
      `[THE3-2] muted ${muted.length} broker-only position(s):`,
      muted.map((m) => m.occ).join(', ')
    );
  }

  if (!actionable.length) {
    console.log('[THE3-2] OK — books match', summary);
    return { ok: true, summary, mismatches: [], muted };
  }

  console.error(
    `[THE3-2] MISMATCH x${actionable.length}`,
    actionable.map((m) => m.detail).join(' | ')
  );

  const message =
    `🚨 RECON MISMATCH (THE3-2) — books disagree\n` +
    `Mode: ${config.mode} · Account: ${accountNumber} · Schema: ${schema}\n` +
    `Broker open OCC: ${openCompare.brokerCount} · DB OPEN: ${openCompare.dbCount}\n` +
    `Issues (${actionable.length}):\n` +
    actionable
      .slice(0, 8)
      .map((m, i) => `${i + 1}. [${m.type}] ${m.detail}`)
      .join('\n') +
    (actionable.length > 8 ? `\n… +${actionable.length - 8} more` : '') +
    (muted.length
      ? `\n(Muted manual: ${muted.map((m) => underlyingFromOptionSymbol(m.occ) || m.occ).join(', ')})`
      : '');

  try {
    await logAlert({
      alertType: 'recon_mismatch',
      message,
      success: false,
      error: actionable.map((m) => m.type).join(','),
    });
  } catch (err) {
    console.error('[THE3-2] alert_log write failed:', err.message);
  }

  if (config.notifyTelegram) {
    await sendReconMismatchTelegram(message);
  } else if (config.logToEventLog) {
    await persistPreprodEvent(actionable, summary);
  }

  return { ok: false, summary, mismatches: actionable, muted };
}
