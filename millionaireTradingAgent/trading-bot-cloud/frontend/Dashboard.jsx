import React, { useState, useEffect, useCallback } from 'react';
import { getApiBase, getApiConfigError } from './api.js';

const API_BASE = getApiBase();
const API_CONFIG_ERROR = getApiConfigError();

function formatCurrency(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPct(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

function formatWinRate(budget) {
  const wins = Number(budget?.wins) || 0;
  const losses = Number(budget?.losses) || 0;
  const decided = Number(budget?.closed_trades);
  const total = Number.isFinite(decided) ? decided : wins + losses;
  if (total <= 0 || budget?.win_rate_percent == null) {
    return 'No closed trades yet';
  }
  const pct = Number(budget.win_rate_percent);
  const pctLabel = Number.isFinite(pct) ? `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1)}%` : '—';
  return `${pctLabel} (${wins}W / ${losses}L)`;
}

const STRATEGY_SHORT = {
  swing: 'SW',
  orb: 'ORB',
  premarket: 'PM',
  emavwap: 'EMA',
};

function resolveTickerWinStats(tickerWinRates, row) {
  const map = tickerWinRates || {};
  const candidates = [
    row?.tv_ticker,
    row?.ticker,
    row?.tv_ticker === 'AI' ? 'C3.AI' : null,
    row?.ticker === 'C3.AI' ? 'AI' : null,
  ]
    .filter(Boolean)
    .map((t) => String(t).toUpperCase());
  for (const key of candidates) {
    if (map[key]) return map[key];
  }
  return null;
}

function TickerWinRateCell({ stats }) {
  if (!stats || !stats.closed_trades) {
    return <span style={{ color: '#9ca3af' }}>—</span>;
  }
  const stratParts = Object.entries(stats.by_strategy || {})
    .filter(([, s]) => (s.closed_trades || 0) > 0)
    .map(([strat, s]) => `${STRATEGY_SHORT[strat] || strat} ${s.wins}W/${s.losses}L`);
  return (
    <div style={{ lineHeight: 1.25 }}>
      <div style={{
        fontWeight: 600,
        color: pnlColor(stats.win_rate_percent - 50),
      }}
      >
        {formatWinRate(stats)}
      </div>
      {stratParts.length > 1 && (
        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
          {stratParts.join(' · ')}
        </div>
      )}
    </div>
  );
}

const ET_TZ = 'America/New_York';

/** Parse API/DB timestamps (ISO or Postgres-style) for display only. */
function parseTimestamp(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  let s = String(value).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2} /.test(s) && !s.includes('T')) {
    s = s.replace(' ', 'T');
  }
  if (/\+\d{2}$/.test(s)) s += ':00';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Time-only in US Eastern (EST/EDT via IANA zone). */
function formatTime(iso) {
  const d = parseTimestamp(iso);
  if (!d) return '—';
  return d.toLocaleTimeString('en-US', {
    timeZone: ET_TZ,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
}

/** Date + time in US Eastern (EST/EDT via IANA zone). */
function formatDateTimeEt(iso) {
  const d = parseTimestamp(iso);
  if (!d) return '—';
  return d.toLocaleString('en-US', {
    timeZone: ET_TZ,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
}

function pnlColor(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v === 0) return '#6b7280';
  return v > 0 ? '#16a34a' : '#dc2626';
}

function trendArrows(trend) {
  if (trend === 'UPTREND') return '↑↑↑';
  if (trend === 'DOWNTREND') return '↓↓↓';
  return 'mixed';
}

function trendLabel(trend) {
  if (trend === 'UPTREND') return '↑ UPTREND';
  if (trend === 'DOWNTREND') return '↓ DOWNTREND';
  return '— NEUTRAL';
}

function rowBorderColor(trend) {
  if (trend === 'UPTREND') return '#16a34a';
  if (trend === 'DOWNTREND') return '#dc2626';
  return 'transparent';
}

function resolveEnvironment(status, strategy) {
  const fromMap = status?.strategy_environments?.[strategy];
  if (fromMap === 'live' || fromMap === 'paper') return fromMap;
  const key = `${strategy}_environment`;
  const direct = status?.[key];
  if (direct === 'live' || direct === 'paper') return direct;
  return 'paper';
}

function EnvironmentBadge({ environment }) {
  const isLive = environment === 'live';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: '0.06em',
        background: isLive ? '#fee2e2' : '#dbeafe',
        color: isLive ? '#991b1b' : '#1d4ed8',
        border: isLive ? '1px solid #f87171' : '1px solid #93c5fd',
      }}
    >
      {isLive ? 'LIVE' : 'PAPER'}
    </span>
  );
}

function StrategyBadge({ strategy }) {
  const styles = {
    orb: { bg: '#ede9fe', color: '#6d28d9', label: '0DTE ORB' },
    premarket: { bg: '#ffedd5', color: '#c2410c', label: 'PREMARKET' },
    emavwap: { bg: '#d1fae5', color: '#047857', label: 'EMA/VWAP' },
    swing: { bg: '#dbeafe', color: '#1d4ed8', label: 'SWING' },
  };
  const s = styles[strategy] || styles.swing;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.04em',
        background: s.bg,
        color: s.color,
      }}
    >
      {s.label}
    </span>
  );
}

function ModeToggle({ label, mode, disabled, controlsDisabled, onToggle }) {
  const isAuto = mode === 'AUTO';
  const buttonLabel = controlsDisabled
    ? 'Controls disabled (read-only)'
    : disabled
      ? '...'
      : isAuto
        ? 'Push to switch to Manual'
        : 'Push to switch to Auto';
  const isInactive = controlsDisabled || disabled;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>
        {label} · {isAuto ? 'AUTO' : 'MANUAL'}
      </span>
      <button
        type="button"
        onClick={controlsDisabled ? undefined : onToggle}
        disabled={isInactive}
        title={controlsDisabled ? 'Dashboard controls are temporarily disabled pending authentication' : undefined}
        style={{
          padding: '8px 16px',
          fontSize: 12,
          fontWeight: 700,
          minWidth: 200,
          background: controlsDisabled ? '#9ca3af' : isAuto ? '#16a34a' : '#ca8a04',
          color: 'white',
          border: 'none',
          borderRadius: 8,
          cursor: isInactive ? 'not-allowed' : 'pointer',
          opacity: isInactive ? 0.65 : 1,
        }}
      >
        {buttonLabel}
      </button>
    </div>
  );
}

function PnlBox({ label, value }) {
  const color = pnlColor(value);
  const v = Number(value) || 0;
  const prefix = v > 0 ? '+' : v < 0 ? '-' : '';
  const display = v === 0 ? formatCurrency(0) : `${prefix}${formatCurrency(Math.abs(v))}`;
  return (
    <div style={pnlBoxStyle}>
      <div style={{ color: '#6b7280', fontSize: 12, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{display}</div>
    </div>
  );
}

export default function Dashboard() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);
  const [toggleError, setToggleError] = useState(null);
  const [togglingSwing, setTogglingSwing] = useState(false);
  const [togglingOrb, setTogglingOrb] = useState(false);
  const [togglingPremarket, setTogglingPremarket] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const fetchStatus = useCallback(async () => {
    if (!API_BASE) {
      setFetchError(API_CONFIG_ERROR);
      setLoading(false);
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/api/status`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setStatus(data);
      setLastRefreshed(data.server_time || new Date().toISOString());
      setFetchError(null);
    } catch (err) {
      setFetchError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 15000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  async function toggleStrategyMode(strategy) {
    if (!status || !API_BASE || status.dashboard_controls_enabled !== true) return;
    const modeKey =
      strategy === 'orb' ? 'orb_mode' : strategy === 'premarket' ? 'premarket_mode' : 'swing_mode';
    const currentMode = status[modeKey] || 'AUTO';
    const newMode = currentMode === 'AUTO' ? 'MANUAL' : 'AUTO';
    const setToggling =
      strategy === 'orb'
        ? setTogglingOrb
        : strategy === 'premarket'
          ? setTogglingPremarket
          : setTogglingSwing;

    setToggling(true);
    setToggleError(null);
    setStatus((prev) => (prev ? { ...prev, [modeKey]: newMode } : prev));

    try {
      const res = await fetch(`${API_BASE}/api/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: `${newMode}|${strategy}` }),
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      setStatus((prev) =>
        prev
          ? {
              ...prev,
              swing_mode: body.swing_mode ?? prev.swing_mode,
              orb_mode: body.orb_mode ?? prev.orb_mode,
              premarket_mode: body.premarket_mode ?? prev.premarket_mode,
              execution_mode: body.swing_mode ?? prev.execution_mode,
            }
          : prev
      );
      await fetchStatus();
    } catch (err) {
      setStatus((prev) => (prev ? { ...prev, [modeKey]: currentMode } : prev));
      setToggleError(err.message);
    } finally {
      setToggling(false);
    }
  }

  if (loading) return <p>Loading...</p>;
  if (fetchError && !status) {
    return (
      <div style={{ color: 'crimson' }}>
        <p>Error loading dashboard: {fetchError}</p>
        <button type="button" onClick={fetchStatus} style={retryButtonStyle}>Retry</button>
      </div>
    );
  }

  const controlsDisabled = status.dashboard_controls_enabled !== true;
  const performance = status.performance || {};
  const swingBudget = status.swing_budget || { max: 0, spent: 0, remaining: 0 };
  const orbBudget = status.orb_budget || { max: 0, spent: 0, remaining: 0 };
  const premarketBudget = status.premarket_budget || { max: 0, spent: 0, remaining: 0 };
  const emaVwapBudget = status.emavwap_budget || { max: 0, spent: 0, remaining: 0 };
  const orbStatus = status.orb_status || {};
  const openingRanges = orbStatus.opening_ranges || {};
  const orbSymbols = Object.keys(openingRanges);
  const swingEnv = resolveEnvironment(status, 'swing');
  const orbEnv = resolveEnvironment(status, 'orb');
  const premarketEnv = resolveEnvironment(status, 'premarket');
  const emaVwapEnv = resolveEnvironment(status, 'emavwap');
  const tickerWinRateMap = Object.fromEntries(
    (status.ticker_win_rates || []).map((row) => [String(row.ticker).toUpperCase(), row])
  );
  const liveBudgetCards = [
    { title: 'Swing Budget', budget: swingBudget, env: swingEnv },
    { title: '0DTE ORB Budget', budget: orbBudget, env: orbEnv },
    { title: 'Premarket Breakout Budget', budget: premarketBudget, env: premarketEnv },
    { title: 'EMA/VWAP Budget', budget: emaVwapBudget, env: emaVwapEnv },
  ].filter(({ env }) => env === 'live');
  const liveTradeLog = (status.trade_log || []).filter(
    (t) => resolveEnvironment(status, t.strategy) === 'live'
  );

  return (
    <div>
      <p style={{ color: '#666', margin: '0 0 16px' }}>Tastytrade · Cloud · Tradier</p>

      {/* Section 1 — Status Bar */}
      <div style={statusBarStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: '#374151' }}>
              Swing <EnvironmentBadge environment={swingEnv} />
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: '#374151' }}>
              0DTE ORB <EnvironmentBadge environment={orbEnv} />
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: '#374151' }}>
              Premarket <EnvironmentBadge environment={premarketEnv} />
            </span>
          </div>
          <span style={{ color: '#666', fontSize: 13 }}>
            Last updated: {formatTime(lastRefreshed)} · auto-refresh 15s
          </span>
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          <ModeToggle
            label="Swing"
            mode={status.swing_mode || status.execution_mode || 'AUTO'}
            disabled={togglingSwing}
            controlsDisabled={controlsDisabled}
            onToggle={() => toggleStrategyMode('swing')}
          />
          <ModeToggle
            label="0DTE ORB"
            mode={status.orb_mode || 'AUTO'}
            disabled={togglingOrb}
            controlsDisabled={controlsDisabled}
            onToggle={() => toggleStrategyMode('orb')}
          />
          <ModeToggle
            label="Premarket"
            mode={status.premarket_mode || 'AUTO'}
            disabled={togglingPremarket}
            controlsDisabled={controlsDisabled}
            onToggle={() => toggleStrategyMode('premarket')}
          />
        </div>
      </div>

      {controlsDisabled && (
        <div style={{ background: '#f3f4f6', color: '#4b5563', padding: 12, borderRadius: 8, marginBottom: 16, fontSize: 13 }}>
          Dashboard is read-only. Mode controls are disabled until authentication is added. Use Telegram /STOP and /GO to change execution mode.
        </div>
      )}

      {fetchError && (
        <div style={{ background: '#fef2f2', color: '#991b1b', padding: 12, borderRadius: 8, marginBottom: 16 }}>
          Refresh error: {fetchError}
        </div>
      )}
      {toggleError && (
        <div style={{ background: '#fef2f2', color: '#991b1b', padding: 12, borderRadius: 8, marginBottom: 16 }}>
          Toggle failed: {toggleError}
        </div>
      )}

      {/* Tracking — near top for immediate visibility */}
      {status.watchlist?.length > 0 && (
        <section style={{ ...cardStyle, marginBottom: 16, padding: '14px 16px' }}>
          <h2 style={{ ...sectionTitleStyle, fontSize: 15 }}>
            Tracking ({status.watchlist_count ?? status.watchlist.length} symbols)
          </h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {status.watchlist.map((ticker) => (
              <span key={ticker} style={tickerChipStyle}>{ticker}</span>
            ))}
          </div>
        </section>
      )}

      {/* Section 2 — Performance Summary */}
      <section style={cardStyle}>
        <h2 style={sectionTitleStyle}>Performance Summary</h2>
        <div style={fourColGrid}>
          <PnlBox label="Daily P&L" value={performance.daily_pnl} />
          <PnlBox label="Weekly P&L" value={performance.weekly_pnl} />
          <PnlBox label="Monthly P&L" value={performance.monthly_pnl} />
          <PnlBox label="All-Time P&L" value={performance.alltime_pnl} />
        </div>
        <div style={investedBarStyle}>
          <strong>Currently Invested:</strong>{' '}
          {formatCurrency(performance.currently_invested ?? 0)} across{' '}
          {performance.open_position_count ?? status.open_positions?.length ?? 0} open position
          {(performance.open_position_count ?? status.open_positions?.length ?? 0) === 1 ? '' : 's'}
        </div>
      </section>

      {/* Section 3 — Budget (currently-live strategies only; paper cards stay hidden) */}
      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={sectionTitleStyle}>Budget</h2>
        {!liveBudgetCards.length ? (
          <p style={{ color: '#666', margin: 0 }}>No live strategy budgets</p>
        ) : (
          <div style={threeColGrid}>
            {liveBudgetCards.map(({ title, budget, env }) => (
              <div key={title} style={budgetCardInner}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <h3 style={{ ...budgetCardTitle, margin: 0 }}>{title}</h3>
                  <EnvironmentBadge environment={env} />
                </div>
                <div style={budgetRow}>
                  <span>Remaining</span>
                  <span style={{ color: '#16a34a', fontWeight: 700 }}>{formatCurrency(budget.remaining)}</span>
                </div>
                <div style={budgetRow}>
                  <span>Spent</span>
                  <span>{formatCurrency(budget.spent)}</span>
                </div>
                <div style={budgetRow}>
                  <span>Max</span>
                  <span>{formatCurrency(budget.max)}</span>
                </div>
                <div style={budgetRow}>
                  <span>ROI %</span>
                  <span style={{ color: pnlColor(budget.roiPercent), fontWeight: 600 }}>
                    {formatPct(budget.roiPercent)}
                  </span>
                </div>
                <div style={{ ...budgetRow, borderBottom: 'none' }}>
                  <span>Win Rate</span>
                  <span style={{
                    fontWeight: 600,
                    color: budget.win_rate_percent == null
                      ? '#6b7280'
                      : pnlColor(budget.win_rate_percent - 50),
                  }}
                  >
                    {formatWinRate(budget)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Section 4 — Open Positions */}
      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={sectionTitleStyle}>Open Positions</h2>
        {!status.open_positions?.length ? (
          <p style={{ color: '#666', margin: 0 }}>No open positions</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Strategy</th>
                  <th style={thStyle}>Ticker</th>
                  <th style={thStyle}>Direction</th>
                  <th style={thStyle}>Strike</th>
                  <th style={thStyle}>Expiry</th>
                  <th style={thStyle}>Entry Premium</th>
                  <th style={thStyle}>Current Mid</th>
                  <th style={thStyle}>P&L %</th>
                  <th style={thStyle}>DTE</th>
                </tr>
              </thead>
              <tbody>
                {status.open_positions.map((p) => (
                  <tr key={`${p.strategy}-${p.id ?? `${p.ticker}-${p.strike}-${p.expiry}`}`}>
                    <td style={tdStyle}><StrategyBadge strategy={p.strategy} /></td>
                    <td style={tdStyle}>{p.ticker}</td>
                    <td style={{
                      ...tdStyle,
                      color: p.direction === 'CALL' ? '#16a34a' : '#dc2626',
                      fontWeight: 600,
                    }}>
                      {p.direction}
                    </td>
                    <td style={tdStyle}>{formatCurrency(p.strike)}</td>
                    <td style={tdStyle}>{p.expiry || p.expiration}</td>
                    <td style={tdStyle}>{formatCurrency(p.entry_premium)}</td>
                    <td style={tdStyle}>
                      {p.current_mid != null ? formatCurrency(p.current_mid) : '—'}
                    </td>
                    <td style={{ ...tdStyle, color: pnlColor(p.pnl_pct), fontWeight: 600 }}>
                      {formatPct(p.pnl_pct)}
                    </td>
                    <td style={tdStyle}>{p.dte != null ? p.dte : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Section 5 — Trade Log (currently-live strategies only) */}
      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={sectionTitleStyle}>Trade Log</h2>
        {!liveTradeLog.length ? (
          <p style={{ color: '#666', margin: 0 }}>No closed live trades yet</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Date</th>
                  <th style={thStyle}>Strategy</th>
                  <th style={thStyle}>Ticker</th>
                  <th style={thStyle}>Direction</th>
                  <th style={thStyle}>Entry</th>
                  <th style={thStyle}>Exit</th>
                  <th style={thStyle}>P&L %</th>
                  <th style={thStyle}>Close Reason</th>
                </tr>
              </thead>
              <tbody>
                {liveTradeLog.map((t) => (
                  <tr key={`${t.strategy}-${t.id ?? `${t.date}-${t.ticker}`}`}>
                    <td style={tdStyle}>{formatDateTimeEt(t.date || t.closed_at)}</td>
                    <td style={tdStyle}><StrategyBadge strategy={t.strategy} /></td>
                    <td style={tdStyle}>{t.ticker}</td>
                    <td style={{
                      ...tdStyle,
                      color: t.direction === 'CALL' ? '#16a34a' : '#dc2626',
                    }}>
                      {t.direction}
                    </td>
                    <td style={tdStyle}>{formatCurrency(t.entry_premium)}</td>
                    <td style={tdStyle}>{formatCurrency(t.exit_premium)}</td>
                    <td style={{ ...tdStyle, color: pnlColor(t.pnl_pct) }}>
                      {formatPct(t.pnl_pct)}
                    </td>
                    <td style={tdStyle}>{t.close_reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Divider */}
      <div style={dividerStyle}>Research & Signals ↓</div>

      {/* Section 6 — Last Signal Checked */}
      {status.last_signal_checked && (
        <section style={{ ...cardStyle, marginTop: 16 }}>
          <h2 style={sectionTitleStyle}>Last Signal Checked</h2>
          <table style={tableStyle}>
            <tbody>
              <tr><td style={tdLabel}>Ticker</td><td>{status.last_signal_checked.ticker}</td></tr>
              <tr><td style={tdLabel}>Type</td><td>{status.last_signal_checked.signal_type}</td></tr>
              <tr><td style={tdLabel}>Result</td><td>{status.last_signal_checked.result}</td></tr>
              <tr><td style={tdLabel}>Direction</td><td>{status.last_signal_checked.direction || '—'}</td></tr>
              <tr><td style={tdLabel}>Confidence</td><td>{status.last_signal_checked.confidence || '—'}</td></tr>
              <tr><td style={tdLabel}>Checked</td><td>{formatDateTimeEt(status.last_signal_checked.checked_at)}</td></tr>
            </tbody>
          </table>
        </section>
      )}

      {/* Section 7 — Watchlist Scan */}
      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={sectionTitleStyle}>Watchlist Scan</h2>
        {!status.last_scan_results?.length ? (
          <p style={{ color: '#666' }}>Waiting for next scan cycle</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Ticker</th>
                  <th style={thStyle}>Price</th>
                  <th style={thStyle}>Trend</th>
                  <th style={thStyle}>Daily</th>
                  <th style={thStyle}>Weekly</th>
                  <th style={thStyle}>RSI</th>
                  <th style={thStyle}>Volume</th>
                  <th style={thStyle}>WoW</th>
                  <th style={thStyle}>Signal</th>
                  <th style={thStyle}>Win Rate</th>
                </tr>
              </thead>
              <tbody>
                {status.last_scan_results.map((row) => (
                  <tr
                    key={row.tv_ticker || row.ticker}
                    style={{ borderLeft: `4px solid ${rowBorderColor(row.trend)}` }}
                  >
                    <td style={tdStyle}>{row.tv_ticker || row.ticker}</td>
                    <td style={tdStyle}>
                      {row.curr_px != null ? formatCurrency(row.curr_px) : '—'}
                    </td>
                    <td style={tdStyle}>{trendLabel(row.trend)}</td>
                    <td style={tdStyle}>{trendArrows(row.daily_trend)}</td>
                    <td style={tdStyle}>{trendArrows(row.weekly_trend)}</td>
                    <td style={{
                      ...tdStyle,
                      color: row.rsi_overbought ? '#ea580c' : row.rsi_oversold ? '#2563eb' : undefined,
                    }}>
                      {row.rsi14 != null ? Math.round(row.rsi14) : '—'}
                    </td>
                    <td style={tdStyle}>{row.volume_confirmed ? '✅' : '❌'}</td>
                    <td style={{
                      ...tdStyle,
                      fontWeight: row.wow_momentum === 'expanding' ? 700 : undefined,
                      color: row.wow_momentum === 'contracting' ? '#888' : undefined,
                    }}>
                      {row.wow_momentum || '—'}
                    </td>
                    <td style={{
                      ...tdStyle,
                      color: row.signal === 'CALL' ? '#16a34a' : row.signal === 'PUT' ? '#dc2626' : undefined,
                      fontWeight: row.signal === 'CALL' || row.signal === 'PUT' ? 700 : undefined,
                    }}>
                      {row.signal || '—'}
                    </td>
                    <td style={tdStyle}>
                      <TickerWinRateCell stats={resolveTickerWinStats(tickerWinRateMap, row)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Section 8 — 0DTE ORB Panel */}
      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={sectionTitleStyle}>0DTE ORB</h2>
        {!orbStatus.active ? (
          <p style={{ color: '#666', margin: 0 }}>ORB inactive — market closed</p>
        ) : (
          <>
            <div style={threeColGrid}>
              {orbSymbols.map((symbol) => {
                const range = openingRanges[symbol] || {};
                return (
                  <div key={symbol} style={orbCardStyle}>
                    <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{symbol}</div>
                    <div style={orbRow}>ORB High: {range.high != null ? formatCurrency(range.high) : '—'}</div>
                    <div style={orbRow}>ORB Low: {range.low != null ? formatCurrency(range.low) : '—'}</div>
                    <div style={orbRow}>
                      Range:{' '}
                      {range.high != null && range.low != null
                        ? formatCurrency(range.high - range.low)
                        : '—'}
                    </div>
                    <div style={orbRow}>
                      Price vs range: {range.position || '—'}
                      {range.current_price != null ? ` (${formatCurrency(range.current_price)})` : ''}
                    </div>
                    <div style={orbRow}>
                      FSM: {range.phase || '—'}
                      {range.direction ? ` · ${range.direction}` : ''}
                      {range.breakout_level != null
                        ? ` @ ${formatCurrency(range.breakout_level)}`
                        : ''}
                    </div>
                    <div style={orbRow}>
                      Today&apos;s ORB signal: {range.signal || 'None'}
                    </div>
                  </div>
                );
              })}
            </div>
            {orbStatus.minutes_to_hard_stop != null && (
              <p style={{
                marginTop: 16,
                marginBottom: 0,
                fontWeight: 600,
                color: orbStatus.minutes_to_hard_stop < 30 ? '#dc2626' : '#374151',
              }}>
                Hard Stop Countdown: {orbStatus.minutes_to_hard_stop} min remaining before 3:00pm ET force close
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}

const retryButtonStyle = {
  padding: '8px 16px',
  background: '#2563eb',
  color: 'white',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
};

const cardStyle = {
  background: '#f9fafb',
  border: '1px solid #e5e7eb',
  borderRadius: 12,
  padding: 20,
};

const sectionTitleStyle = {
  margin: '0 0 12px',
  fontSize: 18,
};

const statusBarStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  flexWrap: 'wrap',
  gap: 16,
  marginBottom: 16,
  padding: '14px 16px',
  background: '#f9fafb',
  border: '1px solid #e5e7eb',
  borderRadius: 12,
};

const fourColGrid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
  gap: 12,
};

const threeColGrid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: 12,
};

const pnlBoxStyle = {
  background: '#fff',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  padding: '12px 14px',
};

const investedBarStyle = {
  marginTop: 14,
  padding: '12px 14px',
  background: '#fff',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  fontSize: 14,
  color: '#374151',
};

const budgetCardInner = {
  background: '#fff',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  padding: 16,
};

const budgetCardTitle = {
  margin: '0 0 12px',
  fontSize: 15,
  fontWeight: 600,
};

const budgetRow = {
  display: 'flex',
  justifyContent: 'space-between',
  padding: '6px 0',
  fontSize: 14,
  borderBottom: '1px solid #f3f4f6',
};

const dividerStyle = {
  margin: '28px 0 8px',
  textAlign: 'center',
  fontSize: 14,
  fontWeight: 600,
  color: '#6b7280',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
};

const orbCardStyle = {
  background: '#fff',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  padding: 14,
};

const orbRow = {
  fontSize: 13,
  color: '#374151',
  marginBottom: 4,
};

const tableStyle = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 14,
};

const thStyle = {
  textAlign: 'left',
  padding: '8px 12px',
  borderBottom: '2px solid #e5e7eb',
  color: '#374151',
};

const tdStyle = {
  padding: '8px 12px',
  borderBottom: '1px solid #e5e7eb',
};

const tdLabel = {
  ...tdStyle,
  color: '#666',
  width: 120,
};

const tickerChipStyle = {
  display: 'inline-block',
  padding: '4px 10px',
  fontSize: 12,
  fontWeight: 600,
  color: '#1f2937',
  background: '#fff',
  border: '1px solid #d1d5db',
  borderRadius: 6,
};
