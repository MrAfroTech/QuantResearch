# AI Options Trading Bot (Cloud)

An AI-powered options trading bot that scans a configurable watchlist, evaluates entry signals via **Tradier API**, manages risk, and executes trades via **Tastytrade**. Includes a React dashboard and Twilio SMS + Telegram alerts with STOP/GO mode control.

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
- **Execution modes**: AUTO (default) or MANUAL — toggle via dashboard or SMS (`STOP` / `GO`)
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
| `TWILIO_*` / `ALERT_TO_NUMBER` | SMS alerts and STOP/GO |
| `TASTYTRADE_USERNAME` / `TASTYTRADE_PASSWORD` | Live Tastytrade session auth |
| `TASTYTRADE_ACCOUNT_NUMBER` | Optional — skips account lookup if set |
| `TASTYTRADE_SANDBOX` | `true` (default) = certification API |
| `PAPER_TRADING` | `true` (default) = no real orders |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Telegram trade alerts (parallel to Twilio SMS) |

### Railway required variables

```
TASTYTRADE_USERNAME=
TASTYTRADE_PASSWORD=
TASTYTRADE_ACCOUNT_NUMBER=
TASTYTRADE_SANDBOX=true
PAPER_TRADING=true
TRADIER_API_TOKEN=
TRADIER_SANDBOX=true
WATCHLIST=SHOP,NFLX,TOST,DUOL,PII,PTON,PLTM,RIOT,SOUN,RIVN,LYFT,UBER,HOOD,PLTR,SOFI,^VIX,AI,JBLU
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
ALERT_TO_NUMBER=
PORT=3001
```

Optional: `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` for persistent DB on serverless hosts.

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

## SMS Webhook

Configure Twilio inbound webhook to:

```
POST http://your-host/api/sms/webhook
```

Commands:
- `STOP` → MANUAL mode
- `GO` → AUTO mode
- Any other text → status reply

## Architecture

```
backend/
  server.js           Express API + static frontend + /api/health
  scheduler.js        node-cron market-hours polling
  cloudScanner.js     Tradier API signal scanner
  tradierClient.js    Tradier REST client
  telegramHandler.js  Telegram trade alerts (parallel to SMS)
  tradeExecutor.js    Order execution + constraints
  positionManager.js  P&L monitoring, sizing, budget
  smsHandler.js       Twilio outbound + inbound
  brokerageConnector.js  Tastytrade orders + Tradier quotes
  db.js               SQLite state + trade log

frontend/
  App.jsx
  Dashboard.jsx
```

## Deploying to Railway

1. Connect this repo (root directory: `trading-bot-cloud`) to Railway
2. Set environment variables from the list above
3. Railway uses `railway.json` — health check at `/api/health`
4. The in-process scheduler runs via `node-cron` when the server starts

```bash
railway up
```

Or deploy via GitHub integration.

## Constraints

- No live orders when `PAPER_TRADING=true`
- Max 3 open positions, $599 monthly spend
- Only executes when signal confidence is `HIGH` (PASS = HIGH)
- VIX options are cash-settled (no assignment logic)

## Disclaimer

This software is for educational purposes. Options trading involves substantial risk. Always test in paper mode before live trading.
