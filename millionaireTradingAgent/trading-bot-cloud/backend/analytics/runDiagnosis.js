import { etDateKey } from '../orb/tradierTimesales.js';
import { collectTradesClosedOnDate, collectTradesForLookback } from './tradeCollector.js';
import { flagDuplicateAnomalies } from './anomalyDetector.js';
import { diagnoseTrades } from './tradeDiagnosis.js';
import { buildDailyAggregates } from './aggregateSummary.js';
import { generateSuggestions } from './suggestionEngine.js';
import {
  saveDiagnosisReport,
  clearPendingSuggestionsForDate,
  insertSuggestedChange,
  getSuggestedChanges,
  getDiagnosisReport,
} from './analyticsDb.js';
import { runDailyTradeScoring } from './runTradeScoring.js';

export async function runDailyDiagnosis(reportDate = etDateKey()) {
  const generatedAt = new Date().toISOString();

  const collected = await collectTradesClosedOnDate(reportDate);
  const lookback = await collectTradesForLookback(reportDate, 7);

  const diagnosesByStrategy = {};
  const rawTradesByStrategy = {};

  for (const [key, trades] of Object.entries(collected.strategies)) {
    const flagged = flagDuplicateAnomalies(trades);
    rawTradesByStrategy[key] = flagged;
    diagnosesByStrategy[key] = diagnoseTrades(flagged);
  }

  const aggregates = buildDailyAggregates(diagnosesByStrategy);
  const suggestions = generateSuggestions(
    reportDate,
    diagnosesByStrategy,
    lookback
  );

  const report = {
    report_date: reportDate,
    generated_at: generatedAt,
    summary: aggregates,
    trades: diagnosesByStrategy,
    suggestions_preview: suggestions,
    meta: {
      total_trades: collected.total_count,
      lookback_days: 7,
      note: 'Suggestions are pending manual review — nothing is auto-applied to strategy config',
    },
  };

  await saveDiagnosisReport(reportDate, report);
  await clearPendingSuggestionsForDate(reportDate);

  const storedSuggestions = [];
  for (const suggestion of suggestions) {
    const row = await insertSuggestedChange(suggestion);
    storedSuggestions.push(row);
  }

  let tradeScoring = null;
  try {
    tradeScoring = await runDailyTradeScoring({ reportDate, dryRun: false });
  } catch (err) {
    console.error('[Analytics] Daily trade scoring error:', err.message);
    tradeScoring = { error: err.message };
  }

  return {
    ...report,
    stored_suggestions: storedSuggestions,
    trade_scoring: tradeScoring
      ? {
          trades_scored: tradeScoring.trades_scored,
          summary: tradeScoring.summary,
          dry_run: tradeScoring.dry_run,
          error: tradeScoring.error,
        }
      : null,
  };
}

export async function listSuggestions({ status = 'pending', reportDate } = {}) {
  return getSuggestedChanges({ status, reportDate });
}

export async function fetchDiagnosisReport(reportDate) {
  return getDiagnosisReport(reportDate);
}
