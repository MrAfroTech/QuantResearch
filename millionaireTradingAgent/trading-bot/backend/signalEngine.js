import { logSignal } from './db.js';
import { runScan } from './tvScanner.js';

export { logSignal };

export async function runSignalScan() {
  const result = await runScan();
  return result.signals ?? [];
}
