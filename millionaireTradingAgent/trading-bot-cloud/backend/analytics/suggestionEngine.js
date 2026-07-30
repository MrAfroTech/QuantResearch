import { ORB_PROFIT_PCT, ORB_STOP_LOSS_PCT } from '../orb/orbConfig.js';
import { PREMARKET_PROFIT_PCT, PREMARKET_STOP_LOSS_PCT } from '../premarketBreakout/premarketConfig.js';
import { EMA_VWAP_PROFIT_PCT, EMA_VWAP_STOP_LOSS_PCT } from '../emaVwapCross/emaVwapConfig.js';
import { PROFIT_TARGET_PCT, STOP_LOSS_PCT } from '../positionManager.js';
import { diagnoseTrades } from './tradeDiagnosis.js';
import { flagDuplicateAnomalies } from './anomalyDetector.js';

const PARAM_CONFIG = {
  swing: {
    profit_pct: { parameter: 'PROFIT_TARGET_PCT', current: PROFIT_TARGET_PCT },
    stop_loss_pct: { parameter: 'STOP_LOSS_PCT', current: STOP_LOSS_PCT },
  },
  orb: {
    profit_pct: { parameter: 'ORB_PROFIT_PCT', current: ORB_PROFIT_PCT },
    stop_loss_pct: { parameter: 'ORB_STOP_LOSS_PCT', current: ORB_STOP_LOSS_PCT },
  },
  premarket: {
    profit_pct: { parameter: 'PREMARKET_PROFIT_PCT', current: PREMARKET_PROFIT_PCT },
    stop_loss_pct: { parameter: 'PREMARKET_STOP_LOSS_PCT', current: PREMARKET_STOP_LOSS_PCT },
  },
  ema_vwap: {
    profit_pct: { parameter: 'EMA_VWAP_PROFIT_PCT', current: EMA_VWAP_PROFIT_PCT },
    stop_loss_pct: { parameter: 'EMA_VWAP_STOP_LOSS_PCT', current: EMA_VWAP_STOP_LOSS_PCT },
  },
};

const STRATEGY_LABELS = {
  swing: 'Swing',
  orb: '0DTE ORB',
  premarket: 'Premarket Breakout',
  ema_vwap: 'EMA/VWAP Cross',
};

function confidenceLabel(sampleSize) {
  if (sampleSize >= 30) return 'HIGH';
  if (sampleSize >= 15) return 'MEDIUM';
  return 'LOW';
}

function formatPct(fraction) {
  return `${(fraction * 100).toFixed(1)}%`;
}

function excursionToPercent(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const n = Number(value);
  if (Math.abs(n) <= 5) return n * 100;
  return n;
}

function prepareLookbackDiagnoses(lookbackTradesByStrategy) {
  const result = {};
  for (const [key, trades] of Object.entries(lookbackTradesByStrategy)) {
    const flagged = flagDuplicateAnomalies(trades);
    result[key] = diagnoseTrades(flagged).filter((d) => !d.anomalous);
  }
  return result;
}

function suggestProfitTarget(strategyKey, diagnoses) {
  const config = PARAM_CONFIG[strategyKey]?.profit_pct;
  if (!config) return null;

  const targetPct = config.current * 100;
  const winners = diagnoses.filter(
    (d) =>
      d.outcome === 'win' &&
      d.close_reason === 'profit_target' &&
      d.exit_quality.mfe_pct != null
  );

  if (winners.length < 3) return null;

  const leftGains = winners.filter(
    (d) => d.exit_quality.mfe_pct > targetPct * 1.35
  );
  if (leftGains.length < Math.ceil(winners.length * 0.6)) return null;

  const avgMfe =
    leftGains.reduce((s, d) => s + d.exit_quality.mfe_pct, 0) / leftGains.length;
  const suggestedFraction = Math.min(0.5, Math.round((avgMfe * 0.7) / 10) / 10);
  const suggested = Math.max(config.current * 1.25, suggestedFraction);

  return {
    strategy: strategyKey,
    parameter: config.parameter,
    current_value: formatPct(config.current),
    suggested_value: `consider ${formatPct(suggested)}`,
    rationale: `${leftGains.length} of ${winners.length} ${STRATEGY_LABELS[strategyKey]} profit-target winners (last 7 days) reached MFE well above the ${formatPct(config.current)} target (avg MFE +${avgMfe.toFixed(1)}%) before closing at target`,
    confidence: confidenceLabel(winners.length),
  };
}

function suggestStopTightening(strategyKey, diagnoses) {
  const config = PARAM_CONFIG[strategyKey]?.stop_loss_pct;
  if (!config) return null;

  const stopPct = config.current * 100;
  const stopped = diagnoses.filter(
    (d) =>
      d.close_reason === 'stop_loss' &&
      d.exit_quality.mae_pct != null
  );

  if (stopped.length < 3) return null;

  const deepDrawdown = stopped.filter(
    (d) => d.exit_quality.mae_pct < -stopPct * 1.4
  );
  if (deepDrawdown.length < Math.ceil(stopped.length * 0.5)) return null;

  const avgMae =
    deepDrawdown.reduce((s, d) => s + d.exit_quality.mae_pct, 0) / deepDrawdown.length;

  return {
    strategy: strategyKey,
    parameter: config.parameter,
    current_value: formatPct(config.current),
    suggested_value: `review tightening below ${formatPct(config.current)}`,
    rationale: `${deepDrawdown.length} of ${stopped.length} ${STRATEGY_LABELS[strategyKey]} stop-loss exits (last 7 days) had MAE worse than ${formatPct(config.current)} (avg MAE ${avgMae.toFixed(1)}%) — stops may be too wide or polling too slow for 0DTE`,
    confidence: confidenceLabel(stopped.length),
  };
}

function suggestDuplicateGuard(strategyKey, dayDiagnoses) {
  const dupes = dayDiagnoses.filter((d) => d.anomalous);
  if (dupes.length < 2) return null;

  return {
    strategy: strategyKey,
    parameter: 'execution_idempotency',
    current_value: 'guards active after fix',
    suggested_value: 'verify guards holding',
    rationale: `${dupes.length} anomalous duplicate entries detected on this day for ${STRATEGY_LABELS[strategyKey]} — confirm catch-up/idempotency guards are deployed and no manual re-runs fired duplicate orders`,
    confidence: 'LOW',
  };
}

export function generateSuggestions(reportDate, dayDiagnosesByStrategy, lookbackTradesByStrategy) {
  const suggestions = [];
  const lookback = prepareLookbackDiagnoses(lookbackTradesByStrategy);

  for (const strategyKey of Object.keys(dayDiagnosesByStrategy)) {
    const dayList = dayDiagnosesByStrategy[strategyKey] || [];
    const weekList = lookback[strategyKey] || [];

    const profitSuggestion = suggestProfitTarget(strategyKey, weekList);
    if (profitSuggestion) {
      suggestions.push({ ...profitSuggestion, report_date: reportDate });
    }

    const stopSuggestion = suggestStopTightening(strategyKey, weekList);
    if (stopSuggestion) {
      suggestions.push({ ...stopSuggestion, report_date: reportDate });
    }

    const dupeSuggestion = suggestDuplicateGuard(strategyKey, dayList);
    if (dupeSuggestion) {
      suggestions.push({ ...dupeSuggestion, report_date: reportDate });
    }
  }

  return suggestions;
}
