import { etDateKey } from '../orb/tradierTimesales.js';
import { matchKnownBugWindow } from './bugWindows.js';

const STRATEGY_SIGNAL_TYPES = {
  swing: null,
  orb: 'orb_breakout',
  premarket: 'premarket_breakout',
  ema_vwap: 'ema_vwap_cross',
};

const INTENDED_EXIT_REASONS = {
  swing: new Set(['profit_target', 'stop_loss', 'scale_out_partial', 'trailing_stop']),
  orb: new Set(['profit_target', 'stop_loss', 'time_stop', 'scale_out_partial', 'trailing_stop', 'expired_worthless', 'expired_itm']),
  premarket: new Set(['profit_target', 'stop_loss', 'time_stop', 'scale_out_partial', 'trailing_stop', 'expired_worthless', 'expired_itm']),
  ema_vwap: new Set(['profit_target', 'stop_loss', 'time_stop', 'scale_out_partial', 'trailing_stop', 'expired_worthless', 'expired_itm']),
};

/** MFE/MAE may be stored as fraction (0DTE monitors) or percent — normalize to percent. */
export function excursionToPercent(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const n = Number(value);
  if (Math.abs(n) <= 5) return n * 100;
  return n;
}

export function resolveSignalType(trade, strategy) {
  if (trade.signal_type) return trade.signal_type;
  if (strategy === 'swing') {
    return trade.direction === 'PUT' ? 'tv_trend' : 'tv_breakout';
  }
  return STRATEGY_SIGNAL_TYPES[strategy] || strategy;
}

export function tradeDateFromOpenedAt(openedAt) {
  if (!openedAt) return null;
  const d = new Date(openedAt);
  if (Number.isNaN(d.getTime())) return String(openedAt).slice(0, 10);
  return etDateKey(d);
}

export function computeMfeCaptureRatio(realizedPct, mfePct) {
  if (mfePct == null || mfePct <= 0) return null;
  if (!Number.isFinite(realizedPct)) return null;
  return realizedPct / mfePct;
}

export function computeMaeRatio(realizedPct, maePct) {
  if (maePct == null || maePct >= 0) return null;
  if (!Number.isFinite(realizedPct)) return null;
  return realizedPct / maePct;
}

export function isExitReasonMatch(closeReason, strategy) {
  const allowed = INTENDED_EXIT_REASONS[strategy];
  if (!allowed) return false;
  return allowed.has(String(closeReason || ''));
}

export function buildCorrelatedStackIndex(trades) {
  const groups = new Map();

  for (const trade of trades) {
    const tradeDate = trade.trade_date || tradeDateFromOpenedAt(trade.opened_at);
    const signalType = resolveSignalType(trade, trade.strategy);
    const key = `${trade.strategy}|${trade.ticker}|${trade.direction}|${signalType}|${tradeDate}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }

  const stackedIds = new Set();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const trade of group) {
      stackedIds.add(`${trade.strategy}:${trade.id}`);
    }
  }

  return stackedIds;
}

export function deriveTier({
  mfe_capture_ratio,
  exit_reason_match,
  correlated_stack_flag,
  known_bug_window_flag,
}) {
  if (correlated_stack_flag || known_bug_window_flag) return 'flagged';
  if (!exit_reason_match) return 'D';
  if (mfe_capture_ratio == null) return 'C';
  if (mfe_capture_ratio >= 0.8) return 'A';
  if (mfe_capture_ratio >= 0.5) return 'B';
  return 'C';
}

export function resolveSignalGateCaveat(strategy, signalType) {
  if (strategy === 'swing' && signalType === 'tv_trend') {
    return 'swing_put_ungated';
  }
  return null;
}

export function scoreTrade(trade, { correlatedStackIds } = {}) {
  const strategy = trade.strategy;
  const tradeDate = trade.trade_date || tradeDateFromOpenedAt(trade.opened_at);
  const signalType = resolveSignalType(trade, strategy);
  const realizedPct = Number(trade.pnl_pct);
  const mfePct = excursionToPercent(trade.mfe_pct);
  const maePct = excursionToPercent(trade.mae_pct);

  const mfe_capture_ratio = computeMfeCaptureRatio(realizedPct, mfePct);
  const mae_ratio = computeMaeRatio(realizedPct, maePct);
  const exit_reason_match = isExitReasonMatch(trade.close_reason, strategy);

  const stackKey = `${strategy}:${trade.id}`;
  const correlated_stack_flag = correlatedStackIds?.has(stackKey) ?? false;

  const bug = matchKnownBugWindow({ trade_date: tradeDate }, strategy);
  const known_bug_window_flag = bug.flagged;
  const bug_note = bug.bug_note;

  const signal_gate_caveat = resolveSignalGateCaveat(strategy, signalType);

  const tier = deriveTier({
    mfe_capture_ratio,
    exit_reason_match,
    correlated_stack_flag,
    known_bug_window_flag,
  });

  return {
    strategy,
    source_trade_id: trade.id,
    trade_date: tradeDate,
    ticker: trade.ticker,
    direction: trade.direction,
    signal_type: signalType,
    mfe_capture_ratio,
    mae_ratio,
    exit_reason_match,
    correlated_stack_flag,
    known_bug_window_flag,
    bug_note,
    signal_gate_caveat,
    tier,
    realized_pnl_pct: Number.isFinite(realizedPct) ? realizedPct : null,
    mfe_pct: mfePct,
    mae_pct: maePct,
    close_reason: trade.close_reason ?? null,
  };
}

export function scoreTrades(trades) {
  const enriched = trades.map((t) => ({
    ...t,
    trade_date: t.trade_date || tradeDateFromOpenedAt(t.opened_at),
    signal_type: resolveSignalType(t, t.strategy),
  }));
  const correlatedStackIds = buildCorrelatedStackIndex(enriched);
  return enriched.map((trade) => scoreTrade(trade, { correlatedStackIds }));
}
