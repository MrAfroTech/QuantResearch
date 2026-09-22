import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOSED_TRADE_ICON_FLAT,
  CLOSED_TRADE_ICON_LOSS,
  CLOSED_TRADE_ICON_WIN,
  closedTradeTelegramIcon,
  formatClosedPnlPct,
  formatClosedTradeTelegramText,
} from './telegramCloseOutcome.js';

describe('closedTradeTelegramIcon', () => {
  it('uses win/loss/flat from displayed P&L percent, not open vs closed', () => {
    assert.equal(closedTradeTelegramIcon({ pnlPct: 0.20, reason: 'profit_target' }), CLOSED_TRADE_ICON_WIN);
    assert.equal(closedTradeTelegramIcon({ pnlPct: -0.078, reason: 'hard_stop' }), CLOSED_TRADE_ICON_LOSS);
    assert.equal(closedTradeTelegramIcon({ pnlPct: 0, reason: 'time_stop' }), CLOSED_TRADE_ICON_FLAT);
  });

  it('routes cancelled and never-filled closes to flat even if a leftover pct is present', () => {
    assert.equal(
      closedTradeTelegramIcon({ pnlPct: -0.078, reason: 'entry_unfilled_cancelled' }),
      CLOSED_TRADE_ICON_FLAT
    );
    assert.equal(
      closedTradeTelegramIcon({ pnlPct: 0.12, reason: 'entry_never_filled' }),
      CLOSED_TRADE_ICON_FLAT
    );
  });

  it('treats displayed 0.0% (including tiny rounding) as flat', () => {
    assert.equal(closedTradeTelegramIcon({ pnlPct: 0.0004, reason: 'time_stop' }), CLOSED_TRADE_ICON_FLAT);
    assert.equal(closedTradeTelegramIcon({ pnlPct: -0.0004, reason: 'time_stop' }), CLOSED_TRADE_ICON_FLAT);
    assert.equal(formatClosedPnlPct(-0.0004), '-0.0');
    assert.equal(formatClosedPnlPct(0.0004), '0.0');
  });

  it('falls back to realized dollar sign when percent is zero', () => {
    assert.equal(
      closedTradeTelegramIcon({ pnlPct: 0, realizedPnl: 12.5, reason: 'profit_target' }),
      CLOSED_TRADE_ICON_WIN
    );
    assert.equal(
      closedTradeTelegramIcon({ pnlPct: 0, realizedPnl: -8, reason: 'hard_stop' }),
      CLOSED_TRADE_ICON_LOSS
    );
  });

  it('formats the four strategy close lines with the outcome icon', () => {
    assert.equal(
      formatClosedTradeTelegramText({
        label: '0DTE ORB',
        ticker: 'SPY',
        reason: 'profit_target',
        pnlPct: 0.20,
      }),
      '✅ 0DTE ORB CLOSED SPY — profit_target | P&L: 20.0%'
    );
    assert.equal(
      formatClosedTradeTelegramText({
        label: 'PREMARKET BREAKOUT',
        ticker: 'QQQ',
        reason: 'hard_stop',
        pnlPct: -0.078,
      }),
      '❌ PREMARKET BREAKOUT CLOSED QQQ — hard_stop | P&L: -7.8%'
    );
    assert.equal(
      formatClosedTradeTelegramText({
        label: 'EMA/VWAP CROSS',
        ticker: 'IWM',
        reason: 'entry_unfilled_cancelled',
        pnlPct: 0,
      }),
      '⚪ EMA/VWAP CROSS CLOSED IWM — entry_unfilled_cancelled | P&L: 0.0%'
    );
    assert.equal(
      formatClosedTradeTelegramText({
        label: 'TRADE',
        ticker: 'SPY',
        reason: 'time_stop',
        pnlPct: 0,
      }),
      '⚪ TRADE CLOSED SPY — time_stop | P&L: 0.0%'
    );
  });
});
