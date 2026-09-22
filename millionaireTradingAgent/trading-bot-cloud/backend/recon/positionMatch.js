/**
 * THE3-2 — pure matching helpers for Tastytrade ↔ Supabase position/fill recon.
 */

export const RECON_MISMATCH = Object.freeze({
  BROKER_ORPHAN: 'broker_orphan',
  DB_ORPHAN: 'db_orphan',
  QTY_MISMATCH: 'qty_mismatch',
  PREMIUM_MISMATCH: 'premium_mismatch',
  FILL_PRICE_MISMATCH: 'fill_price_mismatch',
  BROKER_FILL_UNLOGGED: 'broker_fill_unlogged',
});

export const DEFAULT_PREMIUM_TOLERANCE = 0.05;

/**
 * OCC: 6-char root (space-padded) + YYMMDD + C/P + strike*1000 (8 digits).
 * Mirrors brokerageConnector.buildOccSymbol.
 */
export function buildOccSymbol(symbol, expiration, direction, strike) {
  const root = String(symbol || '')
    .toUpperCase()
    .padEnd(6, ' ')
    .slice(0, 6);
  const exp = String(expiration || '')
    .replace(/-/g, '')
    .slice(2);
  const type = String(direction || '').toUpperCase() === 'CALL' ? 'C' : 'P';
  const strikeStr = String(Math.round(Number(strike) * 1000)).padStart(8, '0');
  return `${root}${exp}${type}${strikeStr}`;
}

export function normalizeOcc(symbol) {
  return String(symbol || '').toUpperCase().replace(/\s+/g, ' ');
}

export function occKey(symbol) {
  return normalizeOcc(symbol).replace(/ /g, '');
}

export function toTastyRoot(ticker) {
  if (ticker === 'C3.AI') return 'AI';
  return String(ticker || '').toUpperCase();
}

export function occForDbPosition(row) {
  return buildOccSymbol(
    toTastyRoot(row?.ticker),
    row?.expiration,
    row?.direction,
    row?.strike
  );
}

export function brokerQtyForOcc(brokerPositions, occ) {
  const key = occKey(occ);
  if (!key) return 0;
  let qty = 0;
  for (const p of brokerPositions || []) {
    if (occKey(p.symbol) === key) qty += Math.abs(Number(p.quantity) || 0);
  }
  return qty;
}

export function txSymbol(tx) {
  return (
    tx?.symbol ||
    tx?.['instrument-symbol'] ||
    tx?.instrument_symbol ||
    tx?.['underlying-symbol'] ||
    null
  );
}

export function txPrice(tx) {
  const n = Number(
    tx?.price ?? tx?.['fill-price'] ?? tx?.fill_price ?? tx?.['average-fill-price'] ?? tx?.value
  );
  return Number.isFinite(n) ? Math.abs(n) : null;
}

export function isSellToCloseAction(tx) {
  const action = String(tx?.action || tx?.['order-action'] || '').toLowerCase();
  return /sell\s*to\s*close|sell_to_close|^stc$/.test(action);
}

export function isBuyToOpenAction(tx) {
  const action = String(tx?.action || tx?.['order-action'] || '').toLowerCase();
  return /buy\s*to\s*open|buy_to_open|^bto$/.test(action);
}

export function latestSellToCloseFromTransactions(transactions, occ) {
  const key = occKey(occ);
  if (!key) return null;
  let best = null;
  for (const tx of transactions || []) {
    if (!isSellToCloseAction(tx)) continue;
    if (occKey(txSymbol(tx)) !== key) continue;
    const price = txPrice(tx);
    if (price == null) continue;
    const t = Date.parse(tx['executed-at'] || tx.executed_at || tx['transaction-date'] || 0);
    const when = Number.isFinite(t) ? t : 0;
    if (!best || when >= best.t) {
      best = {
        price,
        orderId: tx['order-id'] || tx.order_id || null,
        t: when,
        tx,
      };
    }
  }
  return best;
}

/**
 * OPEN rows must not suppress a Sell-to-Close. #88 stayed DB OPEN after the
 * broker stop filled; treating that OCC as "logged" hid BROKER_FILL_UNLOGGED.
 * Unknown actions: only a closed trade_log row counts as logged (fail toward alert).
 */
export function classifyBrokerFillLogStatus(tx, { openOccKeys, closedOccKeys } = {}) {
  const open = openOccKeys || new Set();
  const closed = closedOccKeys || new Set();
  const key = occKey(txSymbol(tx) || tx?.symbol);
  if (!key || !/[0-9]{6}[CP][0-9]{8}/.test(key)) return 'ignore';
  const itype = String(tx?.['instrument-type'] || tx?.instrument_type || '').toLowerCase();
  if (itype && !itype.includes('option')) return 'ignore';

  if (isSellToCloseAction(tx)) {
    return closed.has(key) ? 'logged' : 'unlogged_close';
  }
  if (isBuyToOpenAction(tx)) {
    return open.has(key) || closed.has(key) ? 'logged' : 'unlogged_open';
  }
  if (closed.has(key)) return 'logged';
  return 'unlogged_open';
}

export function collectUnloggedBrokerFills(transactions, { openOccKeys, closedOccKeys } = {}) {
  const mismatches = [];
  for (const tx of transactions || []) {
    const status = classifyBrokerFillLogStatus(tx, { openOccKeys, closedOccKeys });
    if (status !== 'unlogged_close' && status !== 'unlogged_open') continue;
    const sym = txSymbol(tx);
    mismatches.push({
      type: RECON_MISMATCH.BROKER_FILL_UNLOGGED,
      severity: 'critical',
      occ: sym,
      detail:
        status === 'unlogged_close'
          ? `Broker STC with no matching closed trade_log row: ${sym}`
          : `Broker fill/transaction with no matching Supabase trade/open row: ${sym}`,
      db: null,
      broker: tx,
    });
  }
  return mismatches;
}

export function dbPositionQty(row) {
  const open = row?.contracts_open;
  if (open != null && Number.isFinite(Number(open))) return Math.abs(Number(open));
  return Math.abs(Number(row?.quantity) || 0);
}

/**
 * @param {{ symbol: string, quantity: number, averageOpenPrice?: number|null }[]} brokerPositions
 * @param {{ strategy: string, id: number|string, ticker: string, direction: string, strike: number, expiration: string, entry_premium?: number, quantity?: number, contracts_open?: number, order_id?: string|null, occ?: string }[]} dbPositions
 * @param {{ mutedUnderlyings?: Set<string>, premiumTolerance?: number, underlyingFromOptionSymbol?: (s: string) => string|null }} [opts]
 */
export function compareOpenBooks(brokerPositions, dbPositions, opts = {}) {
  const muted = opts.mutedUnderlyings || new Set(['VIX']);
  const tol = opts.premiumTolerance ?? DEFAULT_PREMIUM_TOLERANCE;
  const underlyingFrom =
    opts.underlyingFromOptionSymbol ||
    ((sym) => {
      const m = String(sym || '')
        .trim()
        .match(/^\/?([A-Za-z0-9.]+)/);
      return m ? m[1].toUpperCase() : null;
    });

  const brokerByOcc = new Map();
  for (const p of brokerPositions || []) {
    const key = occKey(p.symbol);
    if (!key) continue;
    const prev = brokerByOcc.get(key);
    const qty = Math.abs(Number(p.quantity) || 0);
    if (prev) {
      prev.quantity += qty;
    } else {
      brokerByOcc.set(key, {
        symbol: p.symbol,
        quantity: qty,
        averageOpenPrice:
          p.averageOpenPrice != null
            ? Number(p.averageOpenPrice)
            : p['average-open-price'] != null
              ? Number(p['average-open-price'])
              : null,
      });
    }
  }

  const dbByOcc = new Map();
  for (const row of dbPositions || []) {
    const occ =
      row.occ ||
      buildOccSymbol(row.ticker, row.expiration, row.direction, row.strike);
    const key = occKey(occ);
    if (!key) continue;
    const list = dbByOcc.get(key) || [];
    list.push({ ...row, occ });
    dbByOcc.set(key, list);
  }

  const mismatches = [];
  const matchedOcc = new Set();

  for (const [key, rows] of dbByOcc) {
    const broker = brokerByOcc.get(key);
    const dbQty = rows.reduce((s, r) => s + dbPositionQty(r), 0);
    const label = rows
      .map((r) => `${r.strategy}#${r.id} ${r.ticker} ${r.direction} $${r.strike}`)
      .join('; ');

    if (!broker || broker.quantity <= 0) {
      mismatches.push({
        type: RECON_MISMATCH.DB_ORPHAN,
        severity: 'critical',
        occ: rows[0].occ,
        detail: `DB OPEN with no matching broker position: ${label}`,
        db: rows,
        broker: null,
      });
      continue;
    }

    matchedOcc.add(key);

    if (Math.abs(broker.quantity - dbQty) > 1e-9) {
      mismatches.push({
        type: RECON_MISMATCH.QTY_MISMATCH,
        severity: 'critical',
        occ: rows[0].occ,
        detail: `Qty mismatch broker=${broker.quantity} db=${dbQty}: ${label}`,
        db: rows,
        broker,
      });
    }

    const premiums = rows
      .map((r) => Number(r.entry_premium))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (premiums.length && broker.averageOpenPrice != null && Number.isFinite(broker.averageOpenPrice)) {
      const dbPrem = premiums.reduce((s, x) => s + x, 0) / premiums.length;
      // Tastytrade average-open-price is often per-share premium (same units as entry_premium).
      if (Math.abs(dbPrem - Math.abs(broker.averageOpenPrice)) > tol) {
        mismatches.push({
          type: RECON_MISMATCH.PREMIUM_MISMATCH,
          severity: 'warning',
          occ: rows[0].occ,
          detail:
            `Entry premium mismatch db≈$${dbPrem.toFixed(3)} broker≈$${Math.abs(broker.averageOpenPrice).toFixed(3)} ` +
            `(tol $${tol}): ${label}`,
          db: rows,
          broker,
        });
      }
    }
  }

  for (const [key, broker] of brokerByOcc) {
    if (matchedOcc.has(key)) continue;
    if (broker.quantity <= 0) continue;
    const und = underlyingFrom(broker.symbol);
    if (und && muted.has(und)) {
      mismatches.push({
        type: RECON_MISMATCH.BROKER_ORPHAN,
        severity: 'muted',
        occ: broker.symbol,
        detail: `Muted broker-only position (${und}): ${broker.symbol} qty=${broker.quantity}`,
        db: null,
        broker,
        muted: true,
      });
      continue;
    }
    mismatches.push({
      type: RECON_MISMATCH.BROKER_ORPHAN,
      severity: 'critical',
      occ: broker.symbol,
      detail: `Broker position with no matching DB OPEN row: ${broker.symbol} qty=${broker.quantity}`,
      db: null,
      broker,
    });
  }

  return {
    mismatches,
    actionable: mismatches.filter((m) => m.severity !== 'muted'),
    muted: mismatches.filter((m) => m.severity === 'muted'),
    brokerCount: brokerByOcc.size,
    dbCount: [...dbByOcc.values()].reduce((s, rows) => s + rows.length, 0),
  };
}

/**
 * Compare a closed trade_log fill premium against a broker order fill price.
 */
export function compareFillPremium(dbPremium, brokerFillPrice, tol = DEFAULT_PREMIUM_TOLERANCE) {
  const a = Number(dbPremium);
  const b = Number(brokerFillPrice);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return { ok: true, reason: 'missing_price' };
  }
  const delta = Math.abs(a - Math.abs(b));
  if (delta > tol) {
    return { ok: false, delta, dbPremium: a, brokerFillPrice: Math.abs(b) };
  }
  return { ok: true, delta };
}
