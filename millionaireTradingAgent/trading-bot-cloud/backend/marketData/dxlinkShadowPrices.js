/**
 * Shadow comparison prices. Never coerce SQL NULL / missing into 0.
 * A 0 close is not a real SPY/QQQ/IWM print — treat it as absent.
 */

export function parseShadowPrice(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}

export function barTimeKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const iso = raw.includes(' ') && !raw.includes('T') ? raw.replace(' ', 'T') : raw;
  return iso.slice(0, 19);
}

export function tradierOhlcFromRow(row) {
  if (!row) return null;
  const close = parseShadowPrice(row.close);
  if (close == null) return null;
  return {
    open: parseShadowPrice(row.open),
    high: parseShadowPrice(row.high),
    low: parseShadowPrice(row.low),
    close,
    volume: row.volume != null && Number.isFinite(Number(row.volume)) ? Number(row.volume) : null,
  };
}

export function shadowBarLookupKey(ticker, barTime) {
  return `${String(ticker || '').toUpperCase()}|${barTimeKey(barTime)}`;
}
