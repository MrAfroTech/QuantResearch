import { buildStatusResponse } from '../backend/handlers.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const data = await buildStatusResponse();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(data);
  } catch (err) {
    console.error('[GET /api/status]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
