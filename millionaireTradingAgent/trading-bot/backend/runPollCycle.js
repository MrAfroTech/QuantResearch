import 'dotenv/config';
import { runPollCycle, isMarketOpen } from './scheduler.js';
import { getLastSignal } from './db.js';

const DEBOUNCE_MS = 5 * 60 * 1000;

function parseCheckedAt(checkedAt) {
  if (!checkedAt) return null;
  const normalized = String(checkedAt).includes('T')
    ? String(checkedAt)
    : `${String(checkedAt).replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

async function shouldRunCatchup() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) {
    console.log('[Catchup] Weekend — skipping');
    return false;
  }

  if (!isMarketOpen()) {
    console.log('[Catchup] Outside market hours — skipping');
    return false;
  }

  const last = await getLastSignal();
  const lastMs = parseCheckedAt(last?.checked_at);
  if (lastMs != null && Date.now() - lastMs < DEBOUNCE_MS) {
    console.log('[Catchup] Last scan < 5 minutes ago — skipping');
    return false;
  }

  return true;
}

async function main() {
  try {
    if (!(await shouldRunCatchup())) {
      process.exit(0);
    }

    const result = await runPollCycle();
    console.log('[Catchup] Poll complete:', JSON.stringify(result));
    process.exit(0);
  } catch (err) {
    console.error('[Catchup] Poll failed:', err.message);
    process.exit(1);
  }
}

main();
