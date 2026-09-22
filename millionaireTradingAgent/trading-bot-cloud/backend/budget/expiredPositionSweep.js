/**
 * Last-resort sweep for DB OPEN rows whose option expiration is already past.
 *
 * Never books a calculated intrinsic. Same confirmation standard as every other
 * close path: broker position check first, then a confirmed fill price, or leave
 * the row OPEN.
 *
 * If flatten-until-closed is doing its job, this should find nothing.
 */

import { getSql } from '../sqlClient.js';
import { closePosition } from '../db.js';
import { closeOrbPosition } from '../orb/orbDb.js';
import { closePremarketPosition } from '../premarketBreakout/premarketDb.js';
import { closeEmaVwapPosition } from '../emaVwapCross/emaVwapDb.js';
import { etDateKey } from '../orb/tradierTimesales.js';
import { getStrategyEnvironment } from '../strategyEnvironment.js';
import {
  closeOptionOrder,
  tastytradeGetOptionPositions,
  tastytradeGetRecentTradeTransactions,
} from '../brokerageConnector.js';
import { closeFillIsConfirmed, hasConfirmedFillPrice } from '../ladder/orderFillStatus.js';
import { syncFlattenUntilClosed } from '../ladder/flattenUntilClosed.js';
import { LADDER_FORCED_FLATTEN_PRICE } from '../ladder/ladderConfig.js';
import { buildOccSymbol, occKey } from '../recon/positionMatch.js';
import { sendCloseFailedTelegram } from '../telegramHandler.js';

export const EXPIRED_SWEEP_CLOSE_REASON = {
  BROKER_FILL: 'expired_sweep_broker_fill',
  FLATTENED: 'expired_sweep_flatten',
};

const ALLOWED_TABLES = Object.freeze({
  swing: 'positions',
  orb: 'orb_positions',
  premarket: 'premarket_positions',
  emavwap: 'emavwap_positions',
});

const CLOSERS = {
  swing: closePosition,
  orb: closeOrbPosition,
  premarket: closePremarketPosition,
  emavwap: closeEmaVwapPosition,
};

function toTastyRoot(ticker) {
  if (ticker === 'C3.AI') return 'AI';
  return String(ticker || '').toUpperCase();
}

export function occForPosition(position) {
  return buildOccSymbol(
    toTastyRoot(position?.ticker),
    position?.expiration,
    position?.direction,
    position?.strike
  );
}

export function brokerQtyForPosition(brokerPositions, position) {
  const key = occKey(occForPosition(position));
  if (!key) return 0;
  let qty = 0;
  for (const row of brokerPositions || []) {
    if (occKey(row?.symbol) === key) {
      qty += Math.abs(Number(row.quantity) || 0);
    }
  }
  return qty;
}

function txSymbol(tx) {
  return (
    tx?.symbol ||
    tx?.['instrument-symbol'] ||
    tx?.instrument_symbol ||
    null
  );
}

function txPrice(tx) {
  const n = Number(
    tx?.price ?? tx?.['fill-price'] ?? tx?.fill_price ?? tx?.['average-fill-price']
  );
  return Number.isFinite(n) ? Math.abs(n) : null;
}

function txExecutedAt(tx) {
  return tx?.['executed-at'] || tx?.executed_at || tx?.['transaction-date'] || '';
}

function isClosingTransaction(tx) {
  const blob = [
    tx?.action,
    tx?.['transaction-sub-type'],
    tx?.transaction_sub_type,
    tx?.['transaction-type'],
    tx?.transaction_type,
  ]
    .map((v) => String(v || '').toLowerCase())
    .join(' ');
  if (!blob.trim()) return false;
  if (blob.includes('buy to open') || blob.includes('buy_to_open')) return false;
  return (
    blob.includes('sell to close') ||
    blob.includes('sell_to_close') ||
    blob.includes('expiration') ||
    blob.includes('exercise') ||
    blob.includes('assignment') ||
    blob.includes('receive deliver') ||
    blob.includes('sell')
  );
}

/**
 * Latest broker-printed close premium for this OCC. 0 is valid only when the
 * broker sent it — never invented from intrinsic.
 */
export function extractCloseFillFromTransactions(transactions, position) {
  const key = occKey(occForPosition(position));
  if (!key) return null;
  let best = null;
  for (const tx of transactions || []) {
    if (occKey(txSymbol(tx)) !== key) continue;
    if (!isClosingTransaction(tx)) continue;
    const price = txPrice(tx);
    if (!hasConfirmedFillPrice({ fillPrice: price }) && price !== 0) continue;
    if (price == null) continue;
    const when = String(txExecutedAt(tx));
    if (!best || when >= best.when) {
      best = { price, when, tx };
    }
  }
  if (!best) return null;
  return { fillPrice: best.price, source: 'broker_transaction', executedAt: best.when };
}

export function pnlPctFromFill(entryPremium, exitPremium) {
  const entry = Number(entryPremium);
  const exit = Number(exitPremium);
  if (!(Number.isFinite(entry) && entry > 0) || !Number.isFinite(exit)) return null;
  return ((exit - entry) / entry) * 100;
}

export function decideExpiredSweepAction({ brokerQty = 0, closeFill = null } = {}) {
  if (Number(brokerQty) > 0) {
    return { action: 'flatten', reason: 'broker_still_long' };
  }
  if (closeFill && Number.isFinite(Number(closeFill.fillPrice))) {
    return { action: 'book_fill', reason: 'broker_flat_with_fill', closeFill };
  }
  return { action: 'leave_open', reason: 'broker_flat_no_confirmed_fill' };
}

function dateKeyFromTimestamp(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

async function queryExpiredOpen(sql, table, today) {
  if (!Object.values(ALLOWED_TABLES).includes(table)) {
    throw new Error(`expired sweep refused unknown table ${table}`);
  }
  return sql.unsafe(
    `
    SELECT * FROM ${table}
    WHERE status = 'OPEN'
      AND expiration IS NOT NULL
      AND LEFT(expiration::text, 10) < $1
    ORDER BY expiration, id
    `,
    [today]
  );
}

async function loadBrokerBooks(environments) {
  const books = new Map();
  for (const environment of environments) {
    const [positionsResult, txResult] = await Promise.all([
      tastytradeGetOptionPositions({ environment }),
      tastytradeGetRecentTradeTransactions({
        environment,
        startDate: new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10),
      }),
    ]);
    books.set(environment, {
      positions: positionsResult?.positions || [],
      transactions: txResult?.transactions || [],
    });
  }
  return books;
}

async function flattenExpiredOpen(position, { strategy, environment, onFill = null }) {
  const closeQty = position.contracts_open ?? position.quantity ?? 1;
  return syncFlattenUntilClosed(position, {
    flattenBrokerOrder: (pos, price, qty) =>
      closeOptionOrder(pos, price, qty, { environment, strategy }),
    flattenPrice: LADDER_FORCED_FLATTEN_PRICE,
    closeQty,
    getOpenPosition: async () => position,
    settleFilled: onFill,
    logLabel: `ExpiredSweep[${strategy}]`,
  });
}

/**
 * Last-resort sweep. Returns resolved + unresolved. Unresolved rows stay OPEN.
 */
export async function runExpiredPositionSweep({
  loadBooks = loadBrokerBooks,
  flattenOpen = flattenExpiredOpen,
} = {}) {
  const sql = getSql();
  const today = etDateKey();
  const resolved = [];
  const unresolved = [];

  const sources = ['swing', 'orb', 'premarket', 'emavwap'].map((strategy) => ({
    strategy,
    table: ALLOWED_TABLES[strategy],
    close: CLOSERS[strategy],
  }));

  const envByStrategy = {};
  for (const { strategy } of sources) {
    envByStrategy[strategy] = await getStrategyEnvironment(strategy);
  }
  const books = await loadBooks([...new Set(Object.values(envByStrategy))]);

  for (const { strategy, table, close } of sources) {
    const environment = envByStrategy[strategy];
    const book = books.get(environment) || { positions: [], transactions: [] };
    const positions = await queryExpiredOpen(sql, table, today);

    if (positions.length) {
      console.error(
        `[ExpiredSweep] ${positions.length} expired OPEN ${strategy} row(s) — ` +
          `flatten-until-closed should have finished these before expiration`
      );
    }

    for (const position of positions) {
      const expDate = String(position.expiration).slice(0, 10);
      const brokerQty = brokerQtyForPosition(book.positions, position);
      const startDate = dateKeyFromTimestamp(position.opened_at) || expDate;
      let transactions = book.transactions;
      if (startDate && startDate < new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10)) {
        try {
          const extra = await tastytradeGetRecentTradeTransactions({ environment, startDate });
          transactions = extra?.transactions || transactions;
        } catch (err) {
          console.error(
            `[ExpiredSweep] transaction lookup failed ${strategy} #${position.id}:`,
            err.message
          );
        }
      }
      const closeFill = extractCloseFillFromTransactions(transactions, position);
      const decision = decideExpiredSweepAction({ brokerQty, closeFill });

      const base = {
        strategy,
        id: position.id,
        ticker: position.ticker,
        direction: position.direction,
        strike: position.strike,
        expiration: expDate,
        entry_premium: position.entry_premium,
        quantity: position.quantity ?? 1,
        environment,
        broker_qty: brokerQty,
      };

      if (decision.action === 'flatten') {
        const bookFlattenFill = async (filled) => {
          if (!closeFillIsConfirmed(filled)) return;
          const exitPremium = Number(filled.fillPrice);
          const pnlPct = pnlPctFromFill(position.entry_premium, exitPremium);
          await close(position.id, exitPremium, pnlPct, EXPIRED_SWEEP_CLOSE_REASON.FLATTENED);
        };
        let flattenResult;
        try {
          flattenResult = await flattenOpen(position, {
            strategy,
            environment,
            onFill: bookFlattenFill,
          });
        } catch (err) {
          console.error(
            `[ExpiredSweep] flatten threw ${strategy} #${position.id}:`,
            err.message
          );
          await sendCloseFailedTelegram({
            strategy,
            positionId: position.id,
            ticker: position.ticker,
            direction: position.direction,
            strike: position.strike,
            error: err.message,
          }).catch(() => {});
          unresolved.push({ ...base, reason: err.message, action: 'flatten_threw' });
          continue;
        }
        if (closeFillIsConfirmed(flattenResult)) {
          await bookFlattenFill(flattenResult);
          resolved.push({
            ...base,
            exit_premium: Number(flattenResult.fillPrice),
            pnl_pct: pnlPctFromFill(position.entry_premium, flattenResult.fillPrice),
            close_reason: EXPIRED_SWEEP_CLOSE_REASON.FLATTENED,
            action: 'flattened',
          });
          continue;
        }
        console.error(
          `[ExpiredSweep] flatten not yet confirmed ${strategy} #${position.id} ` +
            `reason=${flattenResult?.reason || 'n/a'} ` +
            `background=${Boolean(flattenResult?.backgroundRetry)} — leaving OPEN until fill`
        );
        unresolved.push({
          ...base,
          reason: flattenResult?.reason || 'flatten_unconfirmed',
          action: flattenResult?.backgroundRetry ? 'flatten_pending' : 'flatten_unconfirmed',
        });
        continue;
      }

      if (decision.action === 'book_fill') {
        const exitPremium = Number(decision.closeFill.fillPrice);
        const pnlPct = pnlPctFromFill(position.entry_premium, exitPremium);
        await close(position.id, exitPremium, pnlPct, EXPIRED_SWEEP_CLOSE_REASON.BROKER_FILL);
        resolved.push({
          ...base,
          exit_premium: exitPremium,
          pnl_pct: pnlPct,
          close_reason: EXPIRED_SWEEP_CLOSE_REASON.BROKER_FILL,
          action: 'booked_broker_fill',
        });
        continue;
      }

      console.error(
        `[ExpiredSweep] ${strategy} #${position.id} ${position.ticker} ` +
          `${position.direction} $${position.strike} exp=${expDate} ` +
          `broker_qty=${brokerQty} — no confirmed fill, leaving OPEN`
      );
      unresolved.push({ ...base, reason: decision.reason, action: 'leave_open' });
    }
  }

  console.log(
    `[ExpiredSweep] ${today}: resolved=${resolved.length} unresolved=${unresolved.length}`
  );
  return { sweep_date: today, resolved, unresolved };
}
