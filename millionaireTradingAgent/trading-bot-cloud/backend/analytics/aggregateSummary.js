const STRATEGY_LABELS = {
  swing: 'Swing',
  orb: '0DTE ORB',
  premarket: 'Premarket Breakout',
  ema_vwap: 'EMA/VWAP Cross',
};

export function buildStrategySummary(strategyKey, diagnoses) {
  const anomalous = diagnoses.filter((d) => d.anomalous);
  const clean = diagnoses.filter((d) => !d.anomalous);

  const exitReasonCounts = {};
  for (const d of clean) {
    const reason = d.close_reason || 'unknown';
    exitReasonCounts[reason] = (exitReasonCounts[reason] || 0) + 1;
  }

  const wins = clean.filter((d) => d.outcome === 'win').length;
  const avgPnl =
    clean.length > 0
      ? clean.reduce((sum, d) => sum + (Number(d.pnl_pct) || 0), 0) / clean.length
      : null;

  return {
    strategy: strategyKey,
    label: STRATEGY_LABELS[strategyKey] || strategyKey,
    total_trades: diagnoses.length,
    trades_in_aggregates: clean.length,
    excluded_anomalies: anomalous.length,
    anomaly_summaries: anomalous.map((d) => ({
      id: d.id,
      ticker: d.ticker,
      reason: d.anomaly_reason,
    })),
    win_rate: clean.length > 0 ? wins / clean.length : null,
    win_count: wins,
    loss_count: clean.length - wins,
    average_pnl_pct: avgPnl,
    exit_reason_counts: exitReasonCounts,
  };
}

export function buildDailyAggregates(diagnosesByStrategy) {
  const strategies = {};
  for (const [key, list] of Object.entries(diagnosesByStrategy)) {
    strategies[key] = buildStrategySummary(key, list);
  }

  const allClean = Object.values(diagnosesByStrategy)
    .flat()
    .filter((d) => !d.anomalous);

  return {
    strategies,
    day_totals: {
      total_trades: Object.values(diagnosesByStrategy).flat().length,
      trades_in_aggregates: allClean.length,
      excluded_anomalies: Object.values(diagnosesByStrategy)
        .flat()
        .filter((d) => d.anomalous).length,
      win_rate:
        allClean.length > 0
          ? allClean.filter((d) => d.outcome === 'win').length / allClean.length
          : null,
      average_pnl_pct:
        allClean.length > 0
          ? allClean.reduce((s, d) => s + (Number(d.pnl_pct) || 0), 0) / allClean.length
          : null,
    },
  };
}
