import { switchExecutionMode } from '../backend/handlers.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const mode = req.body?.mode;
    const result = await switchExecutionMode(mode);
    return res.status(200).json(result);
  } catch (err) {
    console.error('[POST /api/mode]', err.message);
    const status = err.message.includes('AUTO or MANUAL') ? 400 : 500;
    return res.status(status).json({ error: err.message });
  }
}
