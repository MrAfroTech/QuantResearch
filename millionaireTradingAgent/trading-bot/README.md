# The305

An AI-powered options trading bot that monitors **VIX**, **SOFI**, and **C3.AI**. It evaluates entry signals via TradingView MCP, manages risk, and executes trades via **Tastytrade**. Includes a React dashboard and Twilio SMS alerts with STOP/GO mode control.

## Features

- **Signal engine**: TradingView MCP scanner — daily + intraday breakout (replaces Yahoo/Claude signal checks)
- **Trade rules**: Monthly options (≥21 DTE), max 3 positions, 30% profit target, 10% stop loss, $599/month cap
- **Execution modes**: AUTO (default) or MANUAL — toggle via dashboard or SMS (`STOP` / `GO`)
- **Paper trading**: `PAPER_TRADING=true` logs orders without submitting to brokers
- **Market hours only**: Polls Mon–Fri 9:30am–4:00pm ET

## Quick Start

```bash
cd trading-bot
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
| `ANTHROPIC_API_KEY` | Legacy — no longer used for signal detection |
| `TWILIO_*` / `ALERT_TO_NUMBER` | SMS alerts and STOP/GO |
| `TASTYTRADE_USERNAME` / `TASTYTRADE_PASSWORD` | Live Tastytrade session auth |
| `TASTYTRADE_ACCOUNT_NUMBER` | Optional — skips account lookup if set |
| `TASTYTRADE_SANDBOX` | `true` (default) = certification API |
| `PAPER_TRADING` | `true` (default) = no real orders |
| `TV_WATCHLIST` | Comma-separated TradingView symbols (e.g. `SOFI,AI,^VIX`) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Telegram trade alerts (parallel to Twilio SMS) |

Optional: `TASTYTRADE_ACCOUNT_NUMBER` if you have multiple accounts.

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
  server.js           Express API + static frontend
  scheduler.js        node-cron market-hours polling
  tvScanner.js        TradingView MCP breakout scanner
  tvMcpClient.js      MCP/CLI bridge to TradingView Desktop
  signalEngine.js     Signal log re-exports (legacy entry point)
  telegramHandler.js  Telegram trade alerts (parallel to SMS)
  tradeExecutor.js    Order execution + constraints
  positionManager.js  P&L monitoring, sizing, budget
  smsHandler.js       Twilio outbound + inbound
  brokerageConnector.js  Tastytrade orders + Yahoo Finance quotes
  db.js               SQLite state + trade log

frontend/
  App.jsx
  Dashboard.jsx
```

## Constraints

- No live orders when `PAPER_TRADING=true`
- Max 3 open positions, $599 monthly spend
- Only executes when signal confidence is `HIGH` (TradingView PASS = HIGH)
- VIX options are cash-settled (no assignment logic)

## TradingView MCP Setup (Cursor)

The bot uses TradingView MCP in **two ways**:

| Layer | Config | Purpose |
|-------|--------|---------|
| **Cursor IDE** | `.cursor/mcp.json` | Agent can call TV tools in chat (`tv_health_check`, charts, etc.) |
| **Trading bot** | `backend/tvMcpClient.js` | Scheduler polls TV directly at runtime (does not go through Cursor) |

Both use the same local install at `~/tradingview-mcp`.

```
1. Run: bash scripts/setup-tradingview-mcp.sh
   (clones ~/tradingview-mcp, npm install, writes .cursor/mcp.json in 3 places)
2. Reload Cursor: Cmd+Shift+P → Developer: Reload Window
3. Open Settings → MCP — "tradingview" should appear
```

**Important:** Cursor only loads `.cursor/mcp.json` from your **workspace root**. If you open `QuantResearch/` in Cursor, the config must be at `QuantResearch/.cursor/mcp.json` (the setup script writes this automatically). Opening only the `trading-bot/` subfolder uses `trading-bot/.cursor/mcp.json` instead.

```
4. Launch TradingView Desktop: open -a TradingView --args --remote-debugging-port=9222
5. Open a real chart tab in TradingView (not the welcome screen)
6. In Cursor, ask the agent to run tv_health_check → confirm cdp_connected: true
7. Install catchup launchd job:
   cp scripts/com.tradingbot.catchup.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.tradingbot.catchup.plist
8. Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env
9. Add TV_WATCHLIST to .env (comma-separated tickers matching your TradingView watchlist)
```

Edit `com.tradingbot.catchup.plist` before loading: replace `REPLACE_WITH_ABSOLUTE_PATH` and `REPLACE_USERNAME` with your paths.

Template for manual MCP setup: `.cursor/mcp.json.example`

If the MCP server entry point differs, set `TV_MCP_ROOT` or `TV_MCP_SERVER` in `.env` (defaults to `~/tradingview-mcp`).

## Disclaimer

This software is for educational purposes. Options trading involves substantial risk. Always test in paper mode before live trading.

## Deploying to Vercel

This app is configured for Vercel serverless deployment. Local dev uses a file-based SQLite DB; **production requires Turso** (libSQL) because Vercel has no persistent filesystem.

### 1. Create a Turso database

```bash
turso db create trading-bot
turso db show trading-bot --url
turso db tokens create trading-bot
```

Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in Vercel env vars.

### 2. Set environment variables in Vercel

Copy all vars from `.env.example`. Also set:

| Variable | Notes |
|----------|-------|
| `CRON_SECRET` | Random string — Vercel Cron sends this as Bearer token |
| `TASTYTRADE_USERNAME` / `TASTYTRADE_PASSWORD` | Required for live orders on Vercel |
| `TASTYTRADE_SANDBOX` | `true` for certification API (default) |
| `ETRADE_REDIRECT_URI` | `https://your-domain.vercel.app/auth/etrade/callback` (scaffold only) |

OAuth redirect URIs are auto-derived from `VERCEL_URL` if left blank.

### 3. Deploy

```bash
vercel --prod
```

Or connect the repo in the Vercel dashboard. Root directory: `trading-bot`.

### 4. Post-deploy config

- **Twilio webhook**: `POST https://your-domain.vercel.app/api/sms/webhook`
- **Tastytrade**: set credentials in Vercel env vars (no OAuth callback needed)
- **Cron**: runs every 5 min Mon–Fri via `/api/cron/poll` — requires **Vercel Pro** (Hobby only supports daily crons)

### Vercel vs local

| | Local | Vercel |
|---|-------|--------|
| Database | `data/trading-bot.db` (file) | Turso (required) |
| Scheduler | `node-cron` in-process | Vercel Cron → `/api/cron/poll` |
| Server | Express `app.listen()` | Serverless via `api/index.js` |

