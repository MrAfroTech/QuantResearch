const DUPLICATE_WINDOW_MS = 30_000;

function parseTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function tradeFingerprint(trade) {
  return [
    trade.ticker,
    trade.direction,
    Number(trade.strike).toFixed(2),
    Number(trade.entry_premium).toFixed(4),
  ].join('|');
}

/**
 * Tag trades opened within DUPLICATE_WINDOW_MS of another with the same fingerprint.
 * All matching trades are flagged (not hidden).
 */
export function flagDuplicateAnomalies(trades) {
  const byFingerprint = new Map();

  for (const trade of trades) {
    const fp = tradeFingerprint(trade);
    const openedAt = parseTimestamp(trade.opened_at);
    if (!byFingerprint.has(fp)) byFingerprint.set(fp, []);
    byFingerprint.get(fp).push({ trade, openedAt });
  }

  const flaggedIds = new Set();

  for (const group of byFingerprint.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => (a.openedAt?.getTime() ?? 0) - (b.openedAt?.getTime() ?? 0));

    for (let i = 1; i < group.length; i++) {
      const prev = group[i - 1];
      const curr = group[i];
      if (!prev.openedAt || !curr.openedAt) continue;
      const deltaMs = curr.openedAt.getTime() - prev.openedAt.getTime();
      if (deltaMs >= 0 && deltaMs <= DUPLICATE_WINDOW_MS) {
        flaggedIds.add(curr.trade.id);
        flaggedIds.add(prev.trade.id);
      }
    }
  }

  return trades.map((trade) => {
    if (!flaggedIds.has(trade.id)) {
      return { ...trade, anomalous: false, anomaly_reason: null };
    }
    return {
      ...trade,
      anomalous: true,
      anomaly_reason: `Duplicate entry: same ${trade.ticker} ${trade.direction} $${trade.strike} @ $${trade.entry_premium} within ${DUPLICATE_WINDOW_MS / 1000}s of another trade`,
    };
  });
}
