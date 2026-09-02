import express from 'express';
import cors from 'cors';
import {
  buildStatusResponse,
  switchExecutionMode,
  getBreakoutEventLog,
} from './handlers.js';
import {
  getEtradeAuthUrl,
  isPaperTrading,
} from './brokerageConnector.js';
import { handleInboundTelegramCommand } from './telegramHandler.js';
import {
  shouldRunScheduler,
  isRailway,
  getPublicBaseUrl,
  getCorsOrigins,
  areDashboardControlsEnabled,
  DASHBOARD_CONTROLS_DISABLED_MESSAGE,
} from './config.js';
import { buildDiagnosticsHealthReport } from './diagnostics/healthCheck.js';
import { runPollCycle } from './scheduler.js';
import { runDailyDiagnosis, listSuggestions } from './analytics/runDiagnosis.js';
import {
  runDailyTradeScoring,
  runTradeScoringRange,
  previewBackfill,
  listTradeScores,
  getScoringStatus,
} from './analytics/runTradeScoring.js';
import { getAllBudgetAllocations } from './budget/budgetAllocations.js';
import { runExpiredPositionSweep } from './budget/expiredPositionSweep.js';
import { etDateKey } from './orb/tradierTimesales.js';

const app = express();

const corsOrigins = getCorsOrigins();

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (corsOrigins.allowed(origin)) return callback(null, true);
      callback(new Error(`CORS blocked for origin: ${origin}`));
    },
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/api/status', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await buildStatusResponse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    role: 'api',
    timestamp: new Date().toISOString(),
    paper_trading: isPaperTrading(),
    scheduler_enabled: shouldRunScheduler(),
    railway: isRailway(),
    public_url: getPublicBaseUrl(),
  });
});

app.get('/api/diagnostics/health', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await buildDiagnosticsHealthReport());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/mode', async (req, res) => {
  if (!areDashboardControlsEnabled()) {
    return res.status(403).json({ error: DASHBOARD_CONTROLS_DISABLED_MESSAGE });
  }
  try {
    const result = await switchExecutionMode(req.body?.mode ?? req.body);
    res.json(result);
  } catch (err) {
    const status =
      err.message.includes('AUTO or MANUAL') || err.message.includes('paper or live')
        ? 400
        : 500;
    res.status(status).json({ error: err.message });
  }
});

app.post('/api/scan', async (req, res) => {
  try {
    const result = await runPollCycle();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/analytics/run-diagnosis', async (req, res) => {
  try {
    const date = req.query.date || etDateKey();
    const report = await runDailyDiagnosis(date);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/suggestions', async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const reportDate = req.query.date || undefined;
    const suggestions = await listSuggestions({ status, reportDate });
    res.json({ status, count: suggestions.length, suggestions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/analytics/run-scoring', async (req, res) => {
  try {
    const dryRun = req.query.dry_run === 'true' || req.query.dry_run === '1';
    const rescored = req.query.rescore === 'true' || req.query.rescore === '1';
    const backfillPreview = req.query.backfill_preview === 'true' || req.query.backfill_preview === '1';

    if (backfillPreview) {
      const preview = await previewBackfill();
      return res.json({ mode: 'backfill_preview', dry_run: true, ...preview });
    }

    const startDate = req.query.start;
    const endDate = req.query.end;
    if (startDate && endDate) {
      const result = await runTradeScoringRange({
        startDate,
        endDate,
        dryRun,
        rescored,
      });
      return res.json(result);
    }

    const date = req.query.date || etDateKey();
    const result = await runDailyTradeScoring({ reportDate: date, dryRun });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/trade-scores', async (req, res) => {
  try {
    const tradeDate = req.query.date || undefined;
    const strategy = req.query.strategy || undefined;
    const tier = req.query.tier || undefined;
    const scores = await listTradeScores({ tradeDate, strategy, tier });
    res.json({
      count: scores.length,
      filters: { date: tradeDate, strategy, tier },
      scores,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/scoring-status', async (req, res) => {
  try {
    res.json(await getScoringStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/budget/allocations', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await getAllBudgetAllocations());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/budget/expired-sweep', async (req, res) => {
  try {
    const result = await runExpiredPositionSweep();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/event-log', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    res.setHeader('Cache-Control', 'no-store');
    const events = await getBreakoutEventLog(limit);
    res.json({ events, count: events.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/telegram/webhook', async (req, res) => {
  const chatId = req.body?.message?.chat?.id;
  const text = req.body?.message?.text;
  const expectedChatId = process.env.TELEGRAM_CHAT_ID;

  if (expectedChatId && String(chatId) !== String(expectedChatId)) {
    return res.status(200).end();
  }

  if (text) {
    await handleInboundTelegramCommand(text);
  }

  res.status(200).end();
});

app.get('/auth/etrade', (req, res) => {
  res.redirect(getEtradeAuthUrl());
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    hint: 'This host is the API server. Use the Vercel dashboard URL for the UI.',
    endpoints: ['/api/health', '/api/diagnostics/health', '/api/status', '/api/mode', '/api/scan', '/api/analytics/run-diagnosis', '/api/analytics/suggestions', '/api/analytics/run-scoring', '/api/analytics/trade-scores', '/api/analytics/scoring-status', '/api/budget/allocations', '/api/budget/expired-sweep', '/api/telegram/webhook'],
  });
});

export default app;
