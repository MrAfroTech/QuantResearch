import 'dotenv/config';
import app from './app.js';
import { startScheduler } from './scheduler.js';
import { getBotState } from './db.js';
import { applyBudgetSplitAdjustmentIfNeeded } from './budget/budgetAllocations.js';
import {
  shouldRunScheduler,
  validateStartupConfig,
  getPublicBaseUrl,
} from './config.js';
import { isPaperTrading } from './brokerageConnector.js';

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const PORT = process.env.PORT || 3001;

async function startServer() {
  const config = validateStartupConfig();
  if (!config.ok) {
    console.error('[Config] Fatal configuration errors — exiting');
    process.exit(1);
  }

  await getBotState();
  await applyBudgetSplitAdjustmentIfNeeded();

  app.listen(PORT, () => {
    console.log(`[API] Railway backend listening on port ${PORT}`);
    console.log(`[API] Public URL: ${getPublicBaseUrl()}`);
    console.log(`[API] Paper trading: ${isPaperTrading() ? 'ENABLED' : 'DISABLED'}`);

    if (shouldRunScheduler()) {
      startScheduler();
    } else {
      console.log(
        '[Scheduler] Disabled — set RUN_SCHEDULER=true locally, or deploy to Railway (auto-enabled)'
      );
    }
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
