# The305 (Cloud)

The305 — options trading automation that scans a configurable watchlist, evaluates entry signals via **Tradier API**, manages risk, and executes trades via **Tastytrade**. Includes a React dashboard and Telegram alerts with STOP/GO mode control.

Designed to run 24/7 on **Railway** — no TradingView Desktop required.

## Cloud Bot (trading-bot-cloud)

This is the cloud version of the bot. No TradingView required.
Uses Tradier API for market data and signals.
Runs 24/7 on Railway.

### Setup

1. Create Tradier sandbox account at [sandbox.tradier.com](https://sandbox.tradier.com)
2. Get API token from Tradier dashboard
3. Add `TRADIER_API_TOKEN` to Railway environment variables
4. Deploy to Railway via GitHub

### Local dev

```bash
cd trading-bot-cloud
cp .env.example .env
# Fill in TRADIER_API_TOKEN and other vars

npm install
npm run dev:all
```

API: http://localhost:3001 | Dashboard: http://localhost:5173

## Features

- **Signal engine**: Tradier API scanner — daily + weekly trend, breakout (no intraday gates)
- **Trade rules**: Monthly options (≥21 DTE), max 3 positions, 30% profit target, 10% stop loss, $599/month cap
- **Execution modes**: AUTO (default) or MANUAL — toggle via dashboard or Telegram (`STOP` / `GO`)
- **Paper trading**: `PAPER_TRADING=true` logs orders without submitting to brokers
- **Market hours only**: Polls Mon–Fri 9:30am–4:00pm ET (Tradier market clock)

## Quick Start

```bash
cd trading-bot-cloud
cp .env.example .env
# Fill in API keys in .env

npm install
npm run build:frontend
npm start
```

Dashboard: http://localhost:3001

Development (API + frontend with hot reload):

```bash
npm run dev:all
```

## Environment Variables

See `.env.example`. Required for full functionality:

| Variable | Purpose |
|----------|---------|
| `TRADIER_API_TOKEN` | Tradier API token (sandbox or production) |
| `TRADIER_SANDBOX` | `true` (default) = sandbox API |
| `WATCHLIST` | Comma-separated symbols (e.g. `SOFI,AI,^VIX`) |
| `TASTYTRADE_USERNAME` / `TASTYTRADE_PASSWORD` | Live Tastytrade session auth |
| `TASTYTRADE_ACCOUNT_NUMBER` | Optional — skips account lookup if set |
| `TASTYTRADE_SANDBOX` | `true` (default) = certification API |
| `PAPER_TRADING` | `true` (default) = no real orders |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Telegram trade alerts and STOP/GO remote control |
| `RUN_SCHEDULER` | `true` on Railway/local to enable 5-min polling (required for 24/7 bot) |
| `SUPABASE_DB_URL` | Postgres state (positions, budget, trade log) |
| `VITE_API_URL` | Vercel build only — Railway public URL for the dashboard |
| `FRONTEND_URL` | Railway — Vercel dashboard URL(s) for CORS (comma-separated) |

## Separation of concerns

| Layer | Host | Entry | Responsibility |
|-------|------|-------|----------------|
| **Frontend** | Vercel | `frontend/` + `vercel.json` | Static React dashboard only |
| **API + bot** | Railway | `backend/server.js` → `backend/app.js` | REST API, scheduler, trades, Telegram |
| **Database** | Supabase | — | Positions, budget, trade log |

Vercel does **not** run Express, cron, or serverless API routes. Railway does **not** serve the React UI.

```
frontend/
  Dashboard.jsx     UI — polls VITE_API_URL (Railway)
  api.js            API base URL resolution

backend/
  app.js            Express API routes only (no static files)
  server.js         Railway entry — listen + scheduler bootstrap
  scheduler.js      node-cron market-hours polling
  config.js         Watchlist, CORS, Railway detection
  cloudScanner.js   Tradier signal scanner
  tradeExecutor.js  Order execution + budget gates
  ...
```

## Deploying (Vercel frontend + Railway backend)

Production uses a **split deployment**: Vercel serves the static dashboard; Railway runs the API, scheduler, trades, and Telegram webhooks 24/7.

```
┌─────────────────────┐         ┌──────────────────────────────┐
│  Vercel             │  HTTPS  │  Railway                     │
│  miami-trader…      │ ──────► │  *.up.railway.app            │
│  (React dashboard)  │  CORS   │  Express + node-cron         │
└─────────────────────┘         │  /api/status, /api/mode, …   │
                                └──────────────┬───────────────┘
                                               │
                                               ▼
                                    ┌──────────────────┐
                                    │  Supabase Postgres│
                                    └──────────────────┘
```

### Railway (backend — required)

1. Connect this repo (root: `trading-bot-cloud`) to Railway
2. Set **all** trading and DB variables (see below)
3. **Scheduler:** auto-starts on Railway (detects `RAILWAY_*` env). For local dev, set `RUN_SCHEDULER=true`
4. Health check: `GET /api/health` should return `"scheduler_enabled": true`
5. After deploy, register Telegram webhook:

```bash
npm run register:telegram-webhook
```

Or manually point at `https://<railway-host>/api/telegram/webhook`

**Railway environment variables:**

```
SUPABASE_DB_URL=
TRADIER_API_TOKEN=
TRADIER_SANDBOX=true
WATCHLIST=SHOP,NFLX,TOST,DUOL,PII,PTON,PLTM,RIOT,SOUN,RIVN,LYFT,UBER,HOOD,PLTR,SOFI,AI,JBLU
TASTYTRADE_USERNAME=
TASTYTRADE_PASSWORD=
TASTYTRADE_ACCOUNT_NUMBER=
TASTYTRADE_SANDBOX=true
PAPER_TRADING=true
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
FRONTEND_URL=https://miami-trader.mauricethefirst.com,http://localhost:5173
PORT=3001
```

`RUN_SCHEDULER` is optional on Railway — the scheduler auto-starts when `RAILWAY_*` env vars are present.

### Vercel (frontend only)

1. Import the same repo; root directory `trading-bot-cloud`
2. Set **one** build-time variable:

```
VITE_API_URL=https://<your-railway-service>.up.railway.app
```

3. Deploy — Vercel builds `frontend/dist` only (no serverless cron, no API routes)
4. Optional custom domain: `miami-trader.mauricethefirst.com`

The dashboard calls Railway for `/api/status` and `/api/mode`. Do **not** set trading secrets on Vercel.

### Telegram webhook

Point the webhook at **Railway**, not Vercel:

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<railway-host>/api/telegram/webhook
```

### Local development

```bash
cp .env.example .env
# Set RUN_SCHEDULER=true, TRADIER_API_TOKEN, SUPABASE_DB_URL, etc.

npm run dev:all
```

API: http://localhost:3001 | Dashboard: http://localhost:5173 (Vite dev server; API calls go to Railway URL or localhost:3001 via `VITE_API_URL` / `frontend/api.js`)

## Broker: Tastytrade

```
Sandbox: set TASTYTRADE_SANDBOX=true (default)
Production: set TASTYTRADE_SANDBOX=false

Sandbox credentials: developer.tastytrade.com/sandbox
Production account: tastytrade.com

The bot authenticates via session token on first trade.
No OAuth flow required — username/password in .env is sufficient.
```

## Broker Authentication

- **Tastytrade**: Set `TASTYTRADE_USERNAME` and `TASTYTRADE_PASSWORD` in `.env` (no OAuth flow)
- **E*Trade**: Visit http://localhost:3001/auth/etrade (OAuth scaffold only — live orders use Tastytrade)
- **Schwab**: Disabled (code preserved in `brokerageConnector.js` as comments)

## Telegram Webhook

After Railway is deployed, register the bot webhook manually via Telegram's `setWebhook` API. Point it at your **Railway** host (not Vercel):

```
https://<railway-host>/api/telegram/webhook
```

Example (replace `<BOT_TOKEN>` and `<RAILWAY_HOST>`):

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<RAILWAY_HOST>/api/telegram/webhook
```

Inbound commands (from `TELEGRAM_CHAT_ID` only; other chats are ignored):

- `STOP` → MANUAL mode
- `GO` → AUTO mode
- Any other text → status reply (mode, positions, budget, paper-trading flag)

## Architecture

See **Separation of concerns** above for the deployment split.

## Constraints

- No live orders when `PAPER_TRADING=true`
- Max 3 open positions, $599 monthly spend
- Only executes when signal confidence is `HIGH` (PASS = HIGH)
- VIX options are cash-settled (no assignment logic)

## Disclaimer

This software is for educational purposes. Options trading involves substantial risk. Always test in paper mode before live trading.
