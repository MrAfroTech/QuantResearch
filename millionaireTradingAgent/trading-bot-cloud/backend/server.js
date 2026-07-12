import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildStatusResponse,
  switchExecutionMode,
} from './handlers.js';
import {
  getEtradeAuthUrl,
  isPaperTrading,
} from './brokerageConnector.js';
import { handleInboundSms } from './smsHandler.js';
import { startScheduler } from './scheduler.js';
import { getBotState } from './db.js';

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(frontendDist));

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
    timestamp: new Date().toISOString(),
    paper_trading: isPaperTrading(),
  });
});

app.post('/api/mode', async (req, res) => {
  try {
    const result = await switchExecutionMode(req.body?.mode);
    res.json(result);
  } catch (err) {
    const status = err.message.includes('AUTO or MANUAL') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.post('/api/sms/webhook', async (req, res) => {
  const body = req.body.Body || req.body.body || '';
  await handleInboundSms(body);
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});

// Schwab OAuth disabled — using Tastytrade
// app.get('/auth/schwab', ...)
// app.get('/auth/schwab/callback', ...)

app.get('/auth/etrade', (req, res) => {
  res.redirect(getEtradeAuthUrl());
});

app.get('*', (req, res) => {
  const indexPath = path.join(frontendDist, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.json({
        message: 'Trading bot API running. Build frontend with: npm run build:frontend',
        endpoints: ['/api/status', '/api/mode', '/api/sms/webhook', '/auth/etrade'],
      });
    }
  });
});

const isVercel = process.env.VERCEL === '1';

if (!isVercel) {
  const PORT = process.env.PORT || 3001;

  async function startServer() {
    await getBotState();
    app.listen(PORT, () => {
      console.log(`Trading bot server running on http://localhost:${PORT}`);
      console.log(`Paper trading: ${isPaperTrading() ? 'ENABLED' : 'DISABLED'}`);
      startScheduler();
    });
  }

  startServer().catch((err) => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });
}

export default app;
