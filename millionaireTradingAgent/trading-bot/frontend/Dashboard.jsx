import React, { useState, useEffect, useCallback } from 'react';

const API_BASE = 'http://localhost:3001';

function formatCurrency(n) {
  return `$${Number(n).toFixed(2)}`;
}

function formatPct(n) {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${Number(n).toFixed(1)}%`;
}

function formatSignedCurrency(n) {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(Number(n)).toFixed(2)}`;
}

function pnlColor(n) {
  if (n == null) return undefined;
  if (n > 0) return '#16a34a';
  if (n < 0) return '#dc2626';
  return undefined;
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString();
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

export default function Dashboard() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);
  const [toggleError, setToggleError] = useState(null);
  const [toggling, setToggling] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const fetchStatus = useCallback(async () => {
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

  async function toggleMode() {
    if (!status || toggling) return;

    setToggling(true);
    setToggleError(null);
    const newMode = status.execution_mode === 'AUTO' ? 'MANUAL' : 'AUTO';
    const previousMode = status.execution_mode;

    setStatus((prev) => (prev ? { ...prev, execution_mode: newMode } : prev));

    try {
      const res = await fetch(`${API_BASE}/api/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode }),
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      setStatus((prev) => (prev ? { ...prev, execution_mode: body.mode || newMode } : prev));
      await fetchStatus();
    } catch (err) {
      setStatus((prev) => (prev ? { ...prev, execution_mode: previousMode } : prev));
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
        <button onClick={fetchStatus} style={retryButtonStyle}>Retry</button>
      </div>
    );
  }

  const modeColor = status.execution_mode === 'AUTO' ? '#16a34a' : '#ca8a04';
  const isPaper = status.paper_trading === true;

  return (
    <div>
      <p style={{ color: '#666', margin: '0 0 4px' }}>
        Tastytrade · Paper Trading
      </p>
      {status.watchlist?.length > 0 && (
        <p style={{ color: '#888', fontSize: 13, margin: '0 0 16px' }}>
          {status.watchlist.join(', ')}
        </p>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <span style={{
          background: isPaper ? '#dbeafe' : '#fef3c7',
          color: isPaper ? '#1d4ed8' : '#92400e',
          padding: '4px 12px',
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: '0.03em',
        }}>
          {isPaper ? 'PAPER TRADING' : 'LIVE TRADING'}
        </span>
        <span style={{ color: '#666', fontSize: 13 }}>
          Last updated: {formatTime(lastRefreshed)} · auto-refresh 15s
        </span>
      </div>

      {fetchError && (
        <div style={{ background: '#fef2f2', color: '#991b1b', padding: 12, borderRadius: 8, marginBottom: 16 }}>
          Refresh error: {fetchError}
        </div>
      )}

      <section style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>Execution Mode</h2>
            <p style={{ margin: '4px 0 0', fontSize: 28, fontWeight: 700, color: modeColor }}>
              {status.execution_mode}
            </p>
          </div>
          <div>
            <button
              type="button"
              onClick={toggleMode}
              disabled={toggling}
              style={{
                padding: '12px 24px',
                fontSize: 16,
                fontWeight: 600,
                background: status.execution_mode === 'AUTO' ? '#ca8a04' : '#16a34a',
                color: 'white',
                border: 'none',
                borderRadius: 8,
                cursor: toggling ? 'wait' : 'pointer',
                opacity: toggling ? 0.7 : 1,
              }}
            >
              {toggling ? 'Switching...' : status.execution_mode === 'AUTO' ? 'Switch to MANUAL' : 'Switch to AUTO'}
            </button>
            {toggleError && (
              <p style={{ color: '#dc2626', fontSize: 13, margin: '8px 0 0' }}>
                Toggle failed: {toggleError}
              </p>
            )}
          </div>
        </div>
        <p style={{ margin: '12px 0 0', color: '#666', fontSize: 14 }}>
          SMS: text STOP for MANUAL, GO for AUTO
        </p>
      </section>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 18 }}>Monthly Budget</h2>
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
          <div>
            <div style={{ color: '#666', fontSize: 13 }}>Remaining</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: status.budget_remaining > 0 ? '#16a34a' : '#dc2626' }}>
              {formatCurrency(status.budget_remaining)}
            </div>
          </div>
          <div>
            <div style={{ color: '#666', fontSize: 13 }}>Spent</div>
            <div style={{ fontSize: 24, fontWeight: 700 }}>{formatCurrency(status.monthly_spend)}</div>
          </div>
          <div>
            <div style={{ color: '#666', fontSize: 13 }}>Max</div>
            <div style={{ fontSize: 24, fontWeight: 700 }}>{formatCurrency(status.max_budget)}</div>
          </div>
        </div>
      </section>

      {status.portfolio && (
        <section style={{ ...cardStyle, marginTop: 16 }}>
          <h2 style={{ margin: '0 0 12px', fontSize: 18 }}>Portfolio</h2>
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', marginBottom: 20 }}>
            <div>
              <div style={{ color: '#666', fontSize: 13 }}>Cash on Hand</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: '#16a34a' }}>
                {formatCurrency(status.portfolio.cash_on_hand)}
              </div>
              <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>Available for new trades</div>
            </div>
            <div>
              <div style={{ color: '#666', fontSize: 13 }}>Portfolio Value</div>
              <div style={{ fontSize: 24, fontWeight: 700 }}>
                {formatCurrency(status.portfolio.portfolio_value)}
              </div>
              <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
                Cash + {status.portfolio.open_position_count} open option
                {status.portfolio.open_position_count === 1 ? '' : 's'} (
                {formatCurrency(status.portfolio.positions_market_value)})
              </div>
            </div>
            <div>
              <div style={{ color: '#666', fontSize: 13 }}>Open Positions P&L</div>
              <div style={{
                fontSize: 24,
                fontWeight: 700,
                color: pnlColor(status.portfolio.unrealized_pnl),
              }}>
                {formatSignedCurrency(status.portfolio.unrealized_pnl)}
              </div>
              <div style={{
                fontSize: 14,
                fontWeight: 600,
                color: pnlColor(status.portfolio.unrealized_pnl_pct),
                marginTop: 4,
              }}>
                {formatPct(status.portfolio.unrealized_pnl_pct)}
              </div>
            </div>
            <div>
              <div style={{ color: '#666', fontSize: 13 }}>Total P&L</div>
              <div style={{
                fontSize: 24,
                fontWeight: 700,
                color: pnlColor(status.portfolio.total_pnl),
              }}>
                {formatSignedCurrency(status.portfolio.total_pnl)}
              </div>
              <div style={{
                fontSize: 14,
                fontWeight: 600,
                color: pnlColor(status.portfolio.total_pnl_pct),
                marginTop: 4,
              }}>
                {formatPct(status.portfolio.total_pnl_pct)} of{' '}
                {formatCurrency(status.portfolio.starting_capital)}
              </div>
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Period</th>
                  <th style={thStyle}>P&L $</th>
                  <th style={thStyle}>Return %</th>
                </tr>
              </thead>
              <tbody>
                {['day', 'week', 'month', 'year'].map((period) => (
                  <tr key={period}>
                    <td style={{ ...tdStyle, textTransform: 'capitalize', fontWeight: 600 }}>
                      {period}
                    </td>
                    <td style={{
                      ...tdStyle,
                      color: pnlColor(status.portfolio.returns_pnl?.[period]),
                      fontWeight: 600,
                    }}>
                      {formatSignedCurrency(status.portfolio.returns_pnl?.[period])}
                    </td>
                    <td style={{
                      ...tdStyle,
                      color: pnlColor(status.portfolio.returns_pct?.[period]),
                      fontWeight: 600,
                    }}>
                      {formatPct(status.portfolio.returns_pct?.[period])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ color: '#888', fontSize: 12, margin: '12px 0 0' }}>
            Returns include realized closes in each period plus current open-position P&L.
          </p>
        </section>
      )}

      {status.last_signal_checked && (
        <section style={{ ...cardStyle, marginTop: 16 }}>
          <h2 style={{ margin: '0 0 12px', fontSize: 18 }}>Last Signal Checked</h2>
          <table style={tableStyle}>
            <tbody>
              <tr><td style={tdLabel}>Ticker</td><td>{status.last_signal_checked.ticker}</td></tr>
              <tr><td style={tdLabel}>Type</td><td>{status.last_signal_checked.signal_type}</td></tr>
              <tr><td style={tdLabel}>Result</td><td>{status.last_signal_checked.result}</td></tr>
              <tr><td style={tdLabel}>Direction</td><td>{status.last_signal_checked.direction || '—'}</td></tr>
              <tr><td style={tdLabel}>Confidence</td><td>{status.last_signal_checked.confidence || '—'}</td></tr>
              <tr><td style={tdLabel}>Checked</td><td>{status.last_signal_checked.checked_at}</td></tr>
            </tbody>
          </table>
        </section>
      )}

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 18 }}>Watchlist Scan</h2>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 18 }}>
          Open Positions ({status.open_positions.length}/3)
        </h2>
        {status.open_positions.length === 0 ? (
          <p style={{ color: '#666' }}>No open positions — waiting for HIGH confidence signal in AUTO mode</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Ticker</th>
                  <th style={thStyle}>Direction</th>
                  <th style={thStyle}>Strike</th>
                  <th style={thStyle}>Expiry</th>
                  <th style={thStyle}>Entry Premium</th>
                  <th style={thStyle}>P&L %</th>
                </tr>
              </thead>
              <tbody>
                {status.open_positions.map((p) => (
                  <tr key={p.id}>
                    <td style={tdStyle}>{p.ticker}</td>
                    <td style={tdStyle}>{p.direction}</td>
                    <td style={tdStyle}>{formatCurrency(p.strike)}</td>
                    <td style={tdStyle}>{p.expiration}</td>
                    <td style={tdStyle}>{formatCurrency(p.entry_premium)}</td>
                    <td style={{
                      ...tdStyle,
                      color: p.pnlPct >= 0 ? '#16a34a' : '#dc2626',
                      fontWeight: 600,
                    }}>
                      {formatPct(p.pnlPct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 18 }}>Trade Log</h2>
        {status.trade_log.length === 0 ? (
          <p style={{ color: '#666' }}>No closed trades yet</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Ticker</th>
                  <th style={thStyle}>Direction</th>
                  <th style={thStyle}>Strike</th>
                  <th style={thStyle}>Entry</th>
                  <th style={thStyle}>Exit</th>
                  <th style={thStyle}>P&L %</th>
                  <th style={thStyle}>Reason</th>
                  <th style={thStyle}>Closed</th>
                </tr>
              </thead>
              <tbody>
                {status.trade_log.map((t) => (
                  <tr key={t.id}>
                    <td style={tdStyle}>{t.ticker}</td>
                    <td style={tdStyle}>{t.direction}</td>
                    <td style={tdStyle}>{formatCurrency(t.strike)}</td>
                    <td style={tdStyle}>{formatCurrency(t.entry_premium)}</td>
                    <td style={tdStyle}>{formatCurrency(t.exit_premium)}</td>
                    <td style={{
                      ...tdStyle,
                      color: t.pnl_pct >= 0 ? '#16a34a' : '#dc2626',
                    }}>
                      {formatPct(t.pnl_pct)}
                    </td>
                    <td style={tdStyle}>{t.close_reason}</td>
                    <td style={tdStyle}>{t.closed_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
