import 'dotenv/config';
import { handleInboundSms } from '../backend/smsHandler.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body?.Body || req.body?.body || '';
    await handleInboundSms(body);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } catch (err) {
    console.error('[POST /api/sms/webhook]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
