import React, { useState, useEffect, useCallback } from 'react';
import { getApiBase, getApiConfigError } from './api.js';
import { theme } from './theme.js';

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
    return <span style={{ color: theme.textMuted }}>—</span>;
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
        <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 2 }}>
          {stratParts.join(' · ')}
        </div>
      )}
    </div>
  );
}

const ET_TZ = 'America/New_York';
const DATE_TEXT = theme.text;
const LIVE_UNDERLYINGS = ['IWM', 'SPY', 'QQQ'];
const POSITION_EVENT_TYPES = new Set([
  'mfe_advance',
  'partial_lock_stop_replace',
  'partial_lock_stop_replace_failed',
  'partial_lock_trail',
  'hard_stop_slippage',
]);

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

function etDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  return {
    year,
    month,
    day,
    key: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

function etDateKeyFromValue(value) {
  const d = parseTimestamp(value);
  if (!d) return null;
  return etDateParts(d).key;
}

function shiftMonth(year, month, delta) {
  const next = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function mondayIndex(year, month, day) {
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

function calendarShade(dollars) {
  const n = Number(dollars);
  if (!Number.isFinite(n) || n === 0) return 'flat';
  return n > 0 ? 'up' : 'down';
}

function formatCompactDollars(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return '$0';
  const sign = n > 0 ? '+' : '-';
  const abs = Math.abs(n);
  const body = abs >= 100
    ? abs.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}$${body}`;
}

function scanStatusColor(label) {
  if (label === 'Scanned — no breakout' || label === 'No scan state recorded') return theme.textMuted;
  if (label === 'Breakout detected — awaiting confirmation — no trade') return theme.light;
  return theme.text;
}

function eventStatusColor(row) {
  if (row?.outcome === 'filled') return theme.light;
  if (row?.outcome === 'invalidated' || row?.outcome === 'abandoned') return theme.textMuted;
  return theme.text;
}

function resultColor(trades) {
  const vals = (trades || []).map((trade) => Number(trade.pnl_pct)).filter((v) => Number.isFinite(v));
  if (!vals.length) return theme.textMuted;
  if (vals.every((v) => v > 0)) return theme.positive;
  if (vals.every((v) => v < 0)) return theme.negative;
  if (vals.every((v) => v === 0)) return theme.textMuted;
  return theme.text;
}

function currentScanLabel(range) {
  if (!range || (range.phase == null && range.high == null && range.low == null)) {
    return 'No scan state recorded';
  }
  if (range.phase === 'watching' && !range.direction && range.breakout_level == null) {
    return 'Scanned — no breakout';
  }
  if (range.phase === 'awaiting_confirmation') {
    return 'Breakout detected — awaiting confirmation — no trade';
  }
  if (range.phase) return String(range.phase);
  return 'No scan state recorded';
}

function pnlColor(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v === 0) return theme.textMuted;
  return v > 0 ? theme.positive : theme.negative;
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
  if (trend === 'UPTREND') return theme.positive;
  if (trend === 'DOWNTREND') return theme.negative;
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
        background: isLive ? theme.negative : theme.panelAlt,
        color: theme.text,
        border: isLive ? `1px solid ${theme.negative}` : `1px solid ${theme.accent}`,
      }}
    >
      {isLive ? 'LIVE' : 'PAPER'}
    </span>
  );
}

function StrategyBadge({ strategy }) {
  const styles = {
    orb: { bg: theme.primary, color: theme.text, border: theme.primary, label: '0DTE ORB' },
    premarket: { bg: theme.panelAlt, color: theme.light, border: theme.accent, label: 'PREMARKET' },
    emavwap: { bg: theme.panelAlt, color: theme.text, border: theme.light, label: 'EMA/VWAP' },
    swing: { bg: theme.panel, color: theme.textMuted, border: theme.primary, label: 'SWING' },
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
        border: `1px solid ${s.border}`,
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
      <span style={{ fontSize: 12, fontWeight: 600, color: theme.textMuted }}>
        {label} · {isAuto ? 'AUTO' : 'MANUAL'}
      </span>
      <button
        type="button"
        onClick={controlsDisabled ? undefined : onToggle}
        disabled={isInactive}
        title={controlsDisabled ? 'Dashboard controls are temporarily disabled pending authentication' : undefined}
        className="desk-btn"
        style={{
          padding: '8px 16px',
          fontSize: 12,
          fontWeight: 700,
          minWidth: 200,
          background: controlsDisabled ? theme.panelAlt : isAuto ? theme.positive : theme.primary,
          color: controlsDisabled ? theme.textMuted : theme.text,
          border: controlsDisabled ? `1px solid ${theme.border}` : 'none',
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

function DailyPnlCalendar({ dailyByKey }) {
  const today = etDateParts();
  const [cursor, setCursor] = useState({ year: today.year, month: today.month });
  const days = daysInMonth(cursor.year, cursor.month);
  const lead = mondayIndex(cursor.year, cursor.month, 1);
  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push({ key: `lead-${i}`, empty: true });
  for (let day = 1; day <= days; day += 1) {
    const key = `${cursor.year}-${String(cursor.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    cells.push({
      key,
      day,
      today: key === today.key,
      stats: dailyByKey?.[key] || null,
    });
  }
  while (cells.length % 7 !== 0) cells.push({ key: `trail-${cells.length}`, empty: true });
  const title = new Date(Date.UTC(cursor.year, cursor.month - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <section style={{ ...cardStyle, marginBottom: 0, height: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: DATE_TEXT }}>Daily P&L</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>{title}</span>
          <button type="button" className="desk-btn" aria-label="Previous month" onClick={() => setCursor((c) => shiftMonth(c.year, c.month, -1))} style={calNavStyle}>‹</button>
          <button type="button" className="desk-btn" aria-label="Next month" onClick={() => setCursor((c) => shiftMonth(c.year, c.month, 1))} style={calNavStyle}>›</button>
        </div>
      </div>
      <div style={calWeekdayRow}>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((label, i) => (
          <div key={`${label}-${i}`} style={calWeekdayStyle}>{label}</div>
        ))}
      </div>
      <div style={calGrid}>
        {cells.map((cell) => {
          if (cell.empty) return <div key={cell.key} style={{ ...calCellStyle, background: 'transparent', borderColor: 'transparent' }} />;
          const dollars = cell.stats?.dollars;
          const shade = cell.stats ? calendarShade(dollars) : 'flat';
          const background = shade === 'up' ? theme.positive : shade === 'down' ? theme.negative : theme.panelAlt;
          const amountColor = shade === 'flat' ? theme.textMuted : theme.text;
          return (
            <div
              key={cell.key}
              style={{
                ...calCellStyle,
                background,
                border: cell.today ? `1px solid ${theme.light}` : `1px solid ${theme.border}`,
                boxShadow: cell.today ? `inset 0 0 0 1px ${theme.light}` : 'none',
              }}
            >
              <div style={{ textAlign: 'left', fontSize: 12, fontWeight: 700, color: DATE_TEXT, lineHeight: 1.1, textShadow: shade === 'flat' ? 'none' : '0 1px 1px rgba(7, 26, 51, 0.45)' }}>
                {cell.day}
              </div>
              {cell.stats && (
                <div style={{ fontSize: 10, fontWeight: 700, color: amountColor, marginTop: 4, lineHeight: 1.2, textShadow: shade === 'flat' ? 'none' : '0 1px 1px rgba(7, 26, 51, 0.45)' }}>
                  {formatCompactDollars(dollars)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BreakoutLog({ status }) {
  const ranges = status?.orb_status?.opening_ranges || {};
  const sessionDate = status?.orb_status?.trade_date || null;
  const events = (status?.breakout_event_log || []).filter(
    (row) => !POSITION_EVENT_TYPES.has(String(row.event_type || ''))
  );
  const linkedTradeIds = new Set(
    events.map((row) => row.trade_id).filter((id) => id != null).map((id) => String(id))
  );
  const trades = (status?.trade_log || []).filter((trade) => {
    const ticker = String(trade.ticker || '').toUpperCase();
    if (!LIVE_UNDERLYINGS.includes(ticker)) return false;
    if (linkedTradeIds.has(String(trade.id))) return false;
    return trade.strategy === 'orb' || trade.strategy === 'premarket' || trade.strategy === 'emavwap';
  });

  return (
    <section style={{ ...cardStyle, marginTop: 16 }}>
      <h2 style={sectionTitleStyle}>Breakout Log</h2>
      <p style={{ color: theme.textMuted, fontSize: 13, margin: '0 0 12px', maxWidth: 820 }}>
        Current opening-range state for the live universe, plus recorded breakout and entry events from the last week.
        A quiet scan that never leaves the range is not stored, so past “no breakout” rows are not listed.
        Position-management events are left out of this table.
      </p>
      <h3 style={subheadStyle}>Current scan{sessionDate ? ` · ${sessionDate}` : ''}</h3>
      <div style={{ overflowX: 'auto', marginBottom: 16 }}>
        <table className="desk-table" style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Ticker</th>
              <th style={thStyle}>Direction</th>
              <th style={thStyle}>Breakout level</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Entry today</th>
              <th style={thStyle}>Result</th>
            </tr>
          </thead>
          <tbody>
            {LIVE_UNDERLYINGS.map((ticker) => {
              const range = ranges[ticker] || null;
              const todaysTrades = (status?.trade_log || []).filter((trade) => {
                if (String(trade.ticker || '').toUpperCase() !== ticker) return false;
                if (trade.strategy !== 'orb') return false;
                return etDateKeyFromValue(trade.opened_at) === sessionDate;
              });
              const result = todaysTrades.map((trade) => {
                const pct = formatPct(trade.pnl_pct);
                return [trade.close_reason, pct !== '—' ? pct : null].filter(Boolean).join(' ');
              }).filter(Boolean).join(' · ');
              return (
                <tr key={ticker}>
                  <td style={tdStyle}>{ticker}</td>
                  <td style={tdStyle}>{range?.direction || '—'}</td>
                  <td style={tdStyle}>
                    {range?.breakout_level != null ? formatCurrency(range.breakout_level) : '—'}
                  </td>
                  <td style={{ ...tdStyle, color: scanStatusColor(currentScanLabel(range)) }}>{currentScanLabel(range)}</td>
                  <td style={{ ...tdStyle, color: todaysTrades.length ? theme.text : theme.textMuted, fontWeight: todaysTrades.length ? 700 : 400 }}>{todaysTrades.length ? 'Yes' : 'No'}</td>
                  <td style={{ ...tdStyle, color: resultColor(todaysTrades) }}>{result || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <h3 style={subheadStyle}>Recorded events</h3>
      {!events.length && !trades.length ? (
        <p style={{ color: theme.textMuted, margin: 0 }}>No breakout or entry events in the current log.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="desk-table" style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Time</th>
                <th style={thStyle}>Ticker</th>
                <th style={thStyle}>Strategy</th>
                <th style={thStyle}>Direction</th>
                <th style={thStyle}>Breakout level</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Entry taken</th>
                <th style={thStyle}>Result</th>
              </tr>
            </thead>
            <tbody>
              {events.map((row) => {
                const resultBits = [
                  row.close_reason,
                  row.pnl_pct != null ? formatPct(row.pnl_pct) : null,
                ].filter(Boolean);
                return (
                  <tr key={`${row.strategy}-${row.id}`}>
                    <td style={tdStyle}>{formatDateTimeEt(row.created_at)}</td>
                    <td style={tdStyle}>{row.ticker}</td>
                    <td style={tdStyle}><StrategyBadge strategy={row.strategy} /></td>
                    <td style={tdStyle}>{row.direction || '—'}</td>
                    <td style={tdStyle}>
                      {row.breakout_level != null ? formatCurrency(row.breakout_level) : '—'}
                    </td>
                    <td style={{ ...tdStyle, color: eventStatusColor(row) }}>{row.outcome_label || row.event_type || '—'}</td>
                    <td style={{ ...tdStyle, color: row.outcome === 'filled' ? theme.text : theme.textMuted, fontWeight: row.outcome === 'filled' ? 700 : 400 }}>{row.outcome === 'filled' ? 'Yes' : 'No'}</td>
                    <td style={{ ...tdStyle, color: row.pnl_pct != null ? pnlColor(row.pnl_pct) : theme.text }}>{resultBits.join(' ') || '—'}</td>
                  </tr>
                );
              })}
              {trades.map((trade) => (
                <tr key={`trade-${trade.strategy}-${trade.id}`}>
                  <td style={tdStyle}>{formatDateTimeEt(trade.opened_at || trade.closed_at)}</td>
                  <td style={tdStyle}>{trade.ticker}</td>
                  <td style={tdStyle}><StrategyBadge strategy={trade.strategy} /></td>
                  <td style={tdStyle}>{trade.direction || '—'}</td>
                  <td style={tdStyle}>—</td>
                  <td style={{ ...tdStyle, color: theme.light, fontWeight: 700 }}>Trade</td>
                  <td style={{ ...tdStyle, color: theme.text, fontWeight: 700 }}>Yes</td>
                  <td style={{ ...tdStyle, color: pnlColor(trade.pnl_pct) }}>
                    {[trade.close_reason, formatPct(trade.pnl_pct)].filter((part) => part && part !== '—').join(' ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PnlBox({ label, value }) {
  const color = pnlColor(value);
  const v = Number(value) || 0;
  const prefix = v > 0 ? '+' : v < 0 ? '-' : '';
  const display = v === 0 ? formatCurrency(0) : `${prefix}${formatCurrency(Math.abs(v))}`;
  return (
    <div style={pnlBoxStyle}>
      <div style={{ color: theme.textMuted, fontSize: 12, marginBottom: 4 }}>{label}</div>
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
      <div style={{ color: theme.negative }}>
        <p>Error loading dashboard: {fetchError}</p>
        <button type="button" className="desk-btn" onClick={fetchStatus} style={retryButtonStyle}>Retry</button>
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
      <p style={{ color: theme.textMuted, margin: '0 0 16px' }}>Tastytrade · Cloud · Tradier</p>

      <div style={topGridStyle}>
      <div style={{ minWidth: 0 }}>
      {/* Section 1 — Status Bar */}
      <div style={statusBarStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: theme.text }}>
              Swing <EnvironmentBadge environment={swingEnv} />
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: theme.text }}>
              0DTE ORB <EnvironmentBadge environment={orbEnv} />
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: theme.text }}>
              Premarket <EnvironmentBadge environment={premarketEnv} />
            </span>
          </div>
          <span style={{ color: theme.textMuted, fontSize: 13 }}>
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
        <div style={{ background: theme.panelAlt, color: theme.textMuted, border: `1px solid ${theme.border}`, padding: 12, borderRadius: 8, marginBottom: 16, fontSize: 13 }}>
          Dashboard is read-only. Mode controls are disabled until authentication is added. Use Telegram /STOP and /GO to change execution mode.
        </div>
      )}

      {fetchError && (
        <div style={{ background: theme.panelAlt, color: theme.text, border: `1px solid ${theme.negative}`, padding: 12, borderRadius: 8, marginBottom: 16 }}>
          Refresh error: {fetchError}
        </div>
      )}
      {toggleError && (
        <div style={{ background: theme.panelAlt, color: theme.text, border: `1px solid ${theme.negative}`, padding: 12, borderRadius: 8, marginBottom: 16 }}>
          Toggle failed: {toggleError}
        </div>
      )}

      <section style={{ ...cardStyle, marginBottom: 0, padding: '14px 16px' }}>
        <h2 style={{ ...sectionTitleStyle, fontSize: 15 }}>
          Tracking ({LIVE_UNDERLYINGS.length} symbols)
        </h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {LIVE_UNDERLYINGS.map((ticker) => (
            <span key={ticker} style={tickerChipStyle}>{ticker}</span>
          ))}
        </div>
      </section>
      </div>
      <div style={{ minWidth: 0 }}>
        <DailyPnlCalendar dailyByKey={status.daily_pnl_by_key} />
      </div>
      </div>

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
          <p style={{ color: theme.textMuted, margin: 0 }}>No live strategy budgets</p>
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
                  <span style={{ color: pnlColor(budget.remaining), fontWeight: 700 }}>{formatCurrency(budget.remaining)}</span>
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
                      ? theme.textMuted
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
          <p style={{ color: theme.textMuted, margin: 0 }}>No open positions</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="desk-table" style={tableStyle}>
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
                      color: p.direction === 'CALL' ? theme.positive : theme.negative,
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
          <p style={{ color: theme.textMuted, margin: 0 }}>No closed live trades yet</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="desk-table" style={tableStyle}>
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
                      color: t.direction === 'CALL' ? theme.positive : theme.negative,
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
          <table className="desk-table" style={tableStyle}>
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
          <p style={{ color: theme.textMuted }}>Waiting for next scan cycle</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="desk-table" style={tableStyle}>
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
                      color: row.rsi_overbought ? theme.negative : row.rsi_oversold ? theme.light : undefined,
                    }}>
                      {row.rsi14 != null ? Math.round(row.rsi14) : '—'}
                    </td>
                    <td style={tdStyle}>{row.volume_confirmed ? '✅' : '❌'}</td>
                    <td style={{
                      ...tdStyle,
                      fontWeight: row.wow_momentum === 'expanding' ? 700 : undefined,
                      color: row.wow_momentum === 'contracting' ? theme.textMuted : undefined,
                    }}>
                      {row.wow_momentum || '—'}
                    </td>
                    <td style={{
                      ...tdStyle,
                      color: row.signal === 'CALL' ? theme.positive : row.signal === 'PUT' ? theme.negative : undefined,
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
          <p style={{ color: theme.textMuted, margin: 0 }}>ORB inactive — market closed</p>
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
                color: orbStatus.minutes_to_hard_stop < 30 ? theme.negative : theme.text,
              }}>
                Hard Stop Countdown: {orbStatus.minutes_to_hard_stop} min remaining before 3:00pm ET force close
              </p>
            )}
          </>
        )}
      </section>

      <BreakoutLog status={status} />
    </div>
  );
}

const retryButtonStyle = {
  padding: '8px 16px',
  background: theme.primary,
  color: theme.text,
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
};

const cardStyle = {
  background: theme.panel,
  border: `1px solid ${theme.border}`,
  borderRadius: 12,
  padding: 20,
  color: theme.text,
};

const sectionTitleStyle = {
  margin: '0 0 12px',
  fontSize: 18,
  color: theme.text,
  fontWeight: 650,
};

const topGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
  gap: 16,
  alignItems: 'stretch',
  marginBottom: 16,
};

const calNavStyle = {
  border: `1px solid ${theme.border}`,
  background: theme.panelAlt,
  borderRadius: 6,
  width: 28,
  height: 28,
  cursor: 'pointer',
  fontSize: 16,
  lineHeight: 1,
  color: theme.text,
};

const calWeekdayRow = {
  display: 'grid',
  gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
  gap: 4,
  marginBottom: 4,
};

const calWeekdayStyle = {
  textAlign: 'center',
  fontSize: 11,
  fontWeight: 700,
  color: theme.light,
};

const calGrid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
  gap: 4,
};

const calCellStyle = {
  minHeight: 52,
  borderRadius: 6,
  padding: '4px 5px',
  boxSizing: 'border-box',
};

const subheadStyle = {
  margin: '0 0 8px',
  fontSize: 14,
  fontWeight: 700,
  color: theme.light,
};

const statusBarStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  flexWrap: 'wrap',
  gap: 16,
  marginBottom: 16,
  padding: '14px 16px',
  background: theme.panel,
  border: `1px solid ${theme.border}`,
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
  background: theme.panelAlt,
  border: `1px solid ${theme.border}`,
  borderRadius: 8,
  padding: '12px 14px',
};

const investedBarStyle = {
  marginTop: 14,
  padding: '12px 14px',
  background: theme.panelAlt,
  border: `1px solid ${theme.border}`,
  borderLeft: `3px solid ${theme.accent}`,
  borderRadius: 8,
  fontSize: 14,
  color: theme.text,
};

const budgetCardInner = {
  background: theme.panelAlt,
  border: `1px solid ${theme.border}`,
  borderRadius: 8,
  padding: 16,
};

const budgetCardTitle = {
  margin: '0 0 12px',
  fontSize: 15,
  fontWeight: 600,
  color: theme.text,
};

const budgetRow = {
  display: 'flex',
  justifyContent: 'space-between',
  padding: '6px 0',
  fontSize: 14,
  borderBottom: `1px solid ${theme.divider}`,
};

const dividerStyle = {
  margin: '28px 0 8px',
  textAlign: 'center',
  fontSize: 14,
  fontWeight: 600,
  color: theme.light,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
};

const orbCardStyle = {
  background: theme.panelAlt,
  border: `1px solid ${theme.border}`,
  borderRadius: 8,
  padding: 14,
  color: theme.text,
};

const orbRow = {
  fontSize: 13,
  color: theme.textMuted,
  marginBottom: 4,
};

const tableStyle = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 14,
  color: theme.text,
};

const thStyle = {
  textAlign: 'left',
  padding: '8px 12px',
  borderBottom: `2px solid ${theme.border}`,
  color: theme.light,
  fontWeight: 650,
};

const tdStyle = {
  padding: '8px 12px',
  borderBottom: `1px solid ${theme.divider}`,
  color: theme.text,
};

const tdLabel = {
  ...tdStyle,
  color: theme.textMuted,
  width: 120,
};

const tickerChipStyle = {
  display: 'inline-block',
  padding: '4px 10px',
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.04em',
  color: theme.text,
  background: theme.panelAlt,
  border: `1px solid ${theme.accent}`,
  borderRadius: 6,
};
