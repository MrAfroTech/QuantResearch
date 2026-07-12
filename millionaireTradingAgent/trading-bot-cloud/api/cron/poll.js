import 'dotenv/config';
import { runPollCycle } from '../backend/scheduler.js';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await runPollCycle();
    res.status(200).json(result);
  } catch (err) {
    console.error('[Cron] Poll failed:', err.message);
    res.status(500).json({ error: err.message });
  }
}
