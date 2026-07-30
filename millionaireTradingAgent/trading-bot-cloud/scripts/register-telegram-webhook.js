#!/usr/bin/env node
/**
 * Registers Telegram webhook to the Railway public URL.
 * Usage: node scripts/register-telegram-webhook.js
 */
import 'dotenv/config';
import { getPublicBaseUrl } from '../backend/config.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

const base = getPublicBaseUrl();
if (base.includes('localhost')) {
  console.error(
    'Public URL is localhost. Set RAILWAY_PUBLIC_DOMAIN on Railway or BASE_URL before registering webhook.'
  );
  process.exit(1);
}

const webhookUrl = `${base}/api/telegram/webhook`;
const url = `https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;

const res = await fetch(url);
const body = await res.json();

if (!body.ok) {
  console.error('setWebhook failed:', body);
  process.exit(1);
}

console.log('Telegram webhook registered:', webhookUrl);
console.log(body);
