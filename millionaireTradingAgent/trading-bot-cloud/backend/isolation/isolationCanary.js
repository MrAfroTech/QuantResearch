/**
 * Recurring isolation canary. Schema-aware: uses this process's connection only.
 * Failures page at the same severity as an unprotected-position alert.
 */
import { runLiveIsolationChecks } from './isolationChecks.js';
import { sendIsolationBreachTelegram } from '../telegramHandler.js';

let lastSnapshot = {
  ok: null,
  checkedAt: null,
  mode: null,
  schema: null,
  detail: null,
};

export function getIsolationCanarySnapshot() {
  return { ...lastSnapshot };
}

export function recordIsolationSnapshot(report) {
  lastSnapshot = {
    ok: report?.ok ?? null,
    checkedAt: new Date().toISOString(),
    mode: report?.mode ?? null,
    schema: report?.currentSchema ?? null,
    detail: report?.ok
      ? (report.results || []).map((r) => r.name).join(',')
      : report?.detail || null,
  };
  return getIsolationCanarySnapshot();
}

export async function runIsolationCanaryCycle() {
  const report = await runLiveIsolationChecks();
  recordIsolationSnapshot(report);

  if (!report.ok) {
    console.error(`[isolation] CANARY_FAIL mode=${report.mode} ${report.detail}`);
    await sendIsolationBreachTelegram({
      mode: report.mode,
      schema: report.currentSchema,
      detail: report.detail,
    });
    return { ok: false, report };
  }

  console.log(
    `[isolation] CANARY_OK mode=${report.mode} schema=${report.currentSchema}`
  );
  return { ok: true, report };
}
