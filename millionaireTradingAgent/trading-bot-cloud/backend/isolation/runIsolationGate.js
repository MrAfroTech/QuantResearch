/**
 * Deploy gate. Exit 1 if this environment's live isolation suite fails.
 * Railway startCommand runs this before the API process starts.
 */
import { assertEnvironmentIsolation } from './isolationChecks.js';
import { shouldRunLiveIsolationGate } from './isolationConfig.js';

if (!shouldRunLiveIsolationGate()) {
  console.log('[isolation] live gate skipped (not Railway and ISOLATION_GATE not set)');
  process.exit(0);
}

try {
  const report = await assertEnvironmentIsolation();
  console.log(
    `[isolation] GATE_OK mode=${report.mode} schema=${report.currentSchema} ` +
      report.results.map((r) => `${r.name}=pass`).join(' ')
  );
  process.exit(0);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
