import { getSql } from '../sqlClient.js';

let schemaReady;

function rowToObject(row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row));
}

export async function ensureAnalyticsSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const sql = getSql();

    await sql`
      CREATE TABLE IF NOT EXISTS daily_diagnosis_reports (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        report_date TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        report_json TEXT NOT NULL,
        UNIQUE (report_date)
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS suggested_changes (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        report_date TEXT NOT NULL,
        strategy TEXT NOT NULL,
        parameter TEXT NOT NULL,
        current_value TEXT NOT NULL,
        suggested_value TEXT NOT NULL,
        rationale TEXT NOT NULL,
        confidence TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS trade_scores (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        strategy TEXT NOT NULL,
        source_trade_id INTEGER NOT NULL,
        trade_date TEXT NOT NULL,
        ticker TEXT NOT NULL,
        direction TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        mfe_capture_ratio DOUBLE PRECISION,
        mae_ratio DOUBLE PRECISION,
        exit_reason_match INTEGER NOT NULL,
        correlated_stack_flag INTEGER NOT NULL,
        known_bug_window_flag INTEGER NOT NULL,
        bug_note TEXT,
        signal_gate_caveat TEXT,
        tier TEXT NOT NULL,
        realized_pnl_pct DOUBLE PRECISION,
        mfe_pct DOUBLE PRECISION,
        mae_pct DOUBLE PRECISION,
        close_reason TEXT,
        scored_at TEXT NOT NULL,
        UNIQUE (strategy, source_trade_id)
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS analytics_scoring_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
  })();
  return schemaReady;
}

export async function saveDiagnosisReport(reportDate, report) {
  await ensureAnalyticsSchema();
  const sql = getSql();
  const json = JSON.stringify(report);
  const [row] = await sql`
    INSERT INTO daily_diagnosis_reports (report_date, generated_at, report_json)
    VALUES (${reportDate}, NOW()::text, ${json})
    ON CONFLICT (report_date) DO UPDATE SET
      generated_at = NOW()::text,
      report_json = EXCLUDED.report_json
    RETURNING id, report_date, generated_at
  `;
  return rowToObject(row);
}

export async function getDiagnosisReport(reportDate) {
  await ensureAnalyticsSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM daily_diagnosis_reports WHERE report_date = ${reportDate}
  `;
  const row = rowToObject(rows[0]);
  if (!row) return null;
  try {
    row.report = JSON.parse(row.report_json);
  } catch {
    row.report = null;
  }
  return row;
}

export async function insertSuggestedChange(change) {
  await ensureAnalyticsSchema();
  const sql = getSql();
  const [row] = await sql`
    INSERT INTO suggested_changes (
      report_date, strategy, parameter, current_value, suggested_value,
      rationale, confidence, status, created_at
    )
    VALUES (
      ${change.report_date},
      ${change.strategy},
      ${change.parameter},
      ${change.current_value},
      ${change.suggested_value},
      ${change.rationale},
      ${change.confidence},
      'pending',
      NOW()::text
    )
    RETURNING *
  `;
  return rowToObject(row);
}

export async function getSuggestedChanges({ status, reportDate } = {}) {
  await ensureAnalyticsSchema();
  const sql = getSql();

  if (status && reportDate) {
    const rows = await sql`
      SELECT * FROM suggested_changes
      WHERE status = ${status} AND report_date = ${reportDate}
      ORDER BY created_at DESC
    `;
    return rows.map(rowToObject);
  }

  if (status) {
    const rows = await sql`
      SELECT * FROM suggested_changes WHERE status = ${status} ORDER BY created_at DESC
    `;
    return rows.map(rowToObject);
  }

  if (reportDate) {
    const rows = await sql`
      SELECT * FROM suggested_changes WHERE report_date = ${reportDate} ORDER BY created_at DESC
    `;
    return rows.map(rowToObject);
  }

  const rows = await sql`SELECT * FROM suggested_changes ORDER BY created_at DESC`;
  return rows.map(rowToObject);
}

/** Remove prior pending suggestions for this report date before inserting fresh ones. */
export async function clearPendingSuggestionsForDate(reportDate) {
  await ensureAnalyticsSchema();
  const sql = getSql();
  await sql`
    DELETE FROM suggested_changes
    WHERE report_date = ${reportDate} AND status = 'pending'
  `;
}

export async function upsertTradeScores(scores) {
  await ensureAnalyticsSchema();
  const sql = getSql();
  const stored = [];

  for (const score of scores) {
    const [row] = await sql`
      INSERT INTO trade_scores (
        strategy, source_trade_id, trade_date, ticker, direction, signal_type,
        mfe_capture_ratio, mae_ratio, exit_reason_match, correlated_stack_flag,
        known_bug_window_flag, bug_note, signal_gate_caveat, tier,
        realized_pnl_pct, mfe_pct, mae_pct, close_reason, scored_at
      )
      VALUES (
        ${score.strategy},
        ${score.source_trade_id},
        ${score.trade_date},
        ${score.ticker},
        ${score.direction},
        ${score.signal_type},
        ${score.mfe_capture_ratio},
        ${score.mae_ratio},
        ${score.exit_reason_match ? 1 : 0},
        ${score.correlated_stack_flag ? 1 : 0},
        ${score.known_bug_window_flag ? 1 : 0},
        ${score.bug_note},
        ${score.signal_gate_caveat},
        ${score.tier},
        ${score.realized_pnl_pct},
        ${score.mfe_pct},
        ${score.mae_pct},
        ${score.close_reason},
        NOW()::text
      )
      ON CONFLICT (strategy, source_trade_id) DO UPDATE SET
        trade_date = EXCLUDED.trade_date,
        ticker = EXCLUDED.ticker,
        direction = EXCLUDED.direction,
        signal_type = EXCLUDED.signal_type,
        mfe_capture_ratio = EXCLUDED.mfe_capture_ratio,
        mae_ratio = EXCLUDED.mae_ratio,
        exit_reason_match = EXCLUDED.exit_reason_match,
        correlated_stack_flag = EXCLUDED.correlated_stack_flag,
        known_bug_window_flag = EXCLUDED.known_bug_window_flag,
        bug_note = EXCLUDED.bug_note,
        signal_gate_caveat = EXCLUDED.signal_gate_caveat,
        tier = EXCLUDED.tier,
        realized_pnl_pct = EXCLUDED.realized_pnl_pct,
        mfe_pct = EXCLUDED.mfe_pct,
        mae_pct = EXCLUDED.mae_pct,
        close_reason = EXCLUDED.close_reason,
        scored_at = EXCLUDED.scored_at
      RETURNING *
    `;
    stored.push(rowToObject(row));
  }

  return stored;
}

export async function getUnscoredTradesInRange({ trades }) {
  await ensureAnalyticsSchema();
  if (!trades.length) return [];

  const sql = getSql();
  const existing = await sql`SELECT strategy, source_trade_id FROM trade_scores`;
  const scored = new Set(existing.map((r) => `${r.strategy}:${r.source_trade_id}`));

  return trades.filter((t) => !scored.has(`${t.strategy}:${t.id}`));
}

export async function getTradeScores({ tradeDate, strategy, tier } = {}) {
  await ensureAnalyticsSchema();
  const sql = getSql();

  let rows;
  if (tradeDate && strategy && tier) {
    rows = await sql`
      SELECT * FROM trade_scores
      WHERE trade_date = ${tradeDate} AND strategy = ${strategy} AND tier = ${tier}
      ORDER BY scored_at DESC
    `;
  } else if (tradeDate && strategy) {
    rows = await sql`
      SELECT * FROM trade_scores
      WHERE trade_date = ${tradeDate} AND strategy = ${strategy}
      ORDER BY scored_at DESC
    `;
  } else if (tradeDate) {
    rows = await sql`
      SELECT * FROM trade_scores WHERE trade_date = ${tradeDate} ORDER BY scored_at DESC
    `;
  } else if (strategy) {
    rows = await sql`
      SELECT * FROM trade_scores WHERE strategy = ${strategy} ORDER BY scored_at DESC
    `;
  } else if (tier) {
    rows = await sql`
      SELECT * FROM trade_scores WHERE tier = ${tier} ORDER BY scored_at DESC
    `;
  } else {
    rows = await sql`SELECT * FROM trade_scores ORDER BY scored_at DESC`;
  }

  return rows.map((row) => {
    const obj = rowToObject(row);
    return {
      ...obj,
      exit_reason_match: Boolean(obj.exit_reason_match),
      correlated_stack_flag: Boolean(obj.correlated_stack_flag),
      known_bug_window_flag: Boolean(obj.known_bug_window_flag),
    };
  });
}

export async function getScoringMeta(key) {
  await ensureAnalyticsSchema();
  const sql = getSql();
  const rows = await sql`SELECT value FROM analytics_scoring_meta WHERE key = ${key}`;
  return rows[0]?.value ?? null;
}

export async function setScoringMeta(key, value) {
  await ensureAnalyticsSchema();
  const sql = getSql();
  await sql`
    INSERT INTO analytics_scoring_meta (key, value, updated_at)
    VALUES (${key}, ${value}, NOW()::text)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `;
}
