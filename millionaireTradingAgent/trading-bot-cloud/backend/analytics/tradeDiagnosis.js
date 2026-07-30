import { ORB_PROFIT_PCT, ORB_STOP_LOSS_PCT } from '../orb/orbConfig.js';
import { PREMARKET_PROFIT_PCT, PREMARKET_STOP_LOSS_PCT } from '../premarketBreakout/premarketConfig.js';
import { EMA_VWAP_PROFIT_PCT, EMA_VWAP_STOP_LOSS_PCT } from '../emaVwapCross/emaVwapConfig.js';
import { PROFIT_TARGET_PCT, STOP_LOSS_PCT } from '../positionManager.js';

const STRATEGY_THRESHOLDS = {
  swing: { profit_pct: PROFIT_TARGET_PCT, stop_loss_pct: STOP_LOSS_PCT },
  orb: { profit_pct: ORB_PROFIT_PCT, stop_loss_pct: ORB_STOP_LOSS_PCT },
  premarket: { profit_pct: PREMARKET_PROFIT_PCT, stop_loss_pct: PREMARKET_STOP_LOSS_PCT },
  ema_vwap: { profit_pct: EMA_VWAP_PROFIT_PCT, stop_loss_pct: EMA_VWAP_STOP_LOSS_PCT },
};

function parseJsonSafe(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** MFE/MAE stored as fraction in position monitor; pnl_pct in trade_log is percent. */
function excursionToPercent(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const n = Number(value);
  if (Math.abs(n) <= 5) return n * 100;
  return n;
}

function buildEntrySummary(trade) {
  const strategy = trade.strategy;

  if (strategy === 'swing') {
    return {
      ticker: trade.ticker,
      direction: trade.direction,
      strike: trade.strike,
      expiration: trade.expiration,
      entry_premium: trade.entry_premium,
    };
  }

  if (strategy === 'orb') {
    return {
      opening_range_high: trade.opening_range_high,
      opening_range_low: trade.opening_range_low,
      breakout_level: trade.breakout_level,
      breakout_direction: trade.breakout_direction,
      confirmation_candles: parseJsonSafe(trade.confirmation_candles_json),
      strike_bucket: trade.strike_bucket,
      entry_iv: trade.entry_iv,
      entry_delta: trade.entry_delta,
    };
  }

  if (strategy === 'premarket') {
    return {
      premarket_high: trade.premarket_high,
      premarket_low: trade.premarket_low,
      breakout_level: trade.breakout_level,
      breakout_direction: trade.breakout_direction,
      confirmation_candles: parseJsonSafe(trade.confirmation_candles_json),
      strike_bucket: trade.strike_bucket,
      entry_iv: trade.entry_iv,
      entry_delta: trade.entry_delta,
    };
  }

  if (strategy === 'ema_vwap') {
    return {
      vwap_at_entry: trade.vwap_at_entry,
      ema_at_entry: trade.ema_at_entry,
      cross_direction: trade.cross_direction,
      cross_candle: parseJsonSafe(trade.cross_candle_json),
      strike_bucket: trade.strike_bucket,
      entry_iv: trade.entry_iv,
      entry_delta: trade.entry_delta,
    };
  }

  return {};
}

function assessExitQuality(trade) {
  const thresholds = STRATEGY_THRESHOLDS[trade.strategy];
  const realizedPct = Number(trade.pnl_pct);
  const mfePct = excursionToPercent(trade.mfe_pct);
  const maePct = excursionToPercent(trade.mae_pct);
  const notes = [];

  if (mfePct == null && maePct == null) {
    return {
      mfe_pct: null,
      mae_pct: null,
      notes: ['MFE/MAE not recorded for this strategy trade log — exit quality limited to realized P/L'],
    };
  }

  const profitTargetPct = (thresholds?.profit_pct ?? 0) * 100;
  const stopLossPct = (thresholds?.stop_loss_pct ?? 0) * 100;

  if (
    trade.close_reason === 'profit_target' &&
    mfePct != null &&
    mfePct > profitTargetPct * 1.25 &&
    mfePct > realizedPct + 1
  ) {
    const leftOnTable = mfePct - realizedPct;
    notes.push(
      `MFE was +${mfePct.toFixed(1)}% but closed at +${realizedPct.toFixed(1)}% (${trade.close_reason}) — profit target (${profitTargetPct.toFixed(1)}%) may be leaving ~${leftOnTable.toFixed(1)}pp on the table`
    );
  }

  if (
    maePct != null &&
    maePct < -stopLossPct * 1.25 &&
    realizedPct > -stopLossPct
  ) {
    notes.push(
      `MAE reached ${maePct.toFixed(1)}% (worse than ${stopLossPct.toFixed(1)}% stop) before exit at ${realizedPct.toFixed(1)}% — stop may have been too wide or exit delayed`
    );
  }

  if (
    trade.close_reason === 'stop_loss' &&
    mfePct != null &&
    mfePct > profitTargetPct * 0.5
  ) {
    notes.push(
      `Trade hit stop (${realizedPct.toFixed(1)}%) but had favorable excursion to +${mfePct.toFixed(1)}% earlier — entry may have been valid but exit/stop placement worth reviewing`
    );
  }

  if (trade.close_reason === 'expired_worthless') {
    notes.push('0DTE option expired worthless — full premium loss');
  }

  if (notes.length === 0) {
    notes.push('Exit aligned with recorded excursion profile');
  }

  return { mfe_pct: mfePct, mae_pct: maePct, notes };
}

export function diagnoseTrade(trade) {
  const realizedPct = Number(trade.pnl_pct);
  const realizedPnl = trade.realized_pnl != null ? Number(trade.realized_pnl) : null;
  const isWin = Number.isFinite(realizedPct) ? realizedPct > 0 : (realizedPnl ?? 0) > 0;

  return {
    id: trade.id,
    strategy: trade.strategy,
    ticker: trade.ticker,
    direction: trade.direction,
    strike: trade.strike,
    expiration: trade.expiration,
    quantity: trade.quantity ?? 1,
    entry_premium: trade.entry_premium,
    exit_premium: trade.exit_premium,
    opened_at: trade.opened_at,
    closed_at: trade.closed_at,
    close_reason: trade.close_reason,
    outcome: isWin ? 'win' : 'loss',
    pnl_pct: realizedPct,
    realized_pnl: realizedPnl,
    entry_conditions: buildEntrySummary(trade),
    exit_quality: assessExitQuality(trade),
    anomalous: Boolean(trade.anomalous),
    anomaly_reason: trade.anomaly_reason ?? null,
  };
}

export function diagnoseTrades(trades) {
  return trades.map(diagnoseTrade);
}
