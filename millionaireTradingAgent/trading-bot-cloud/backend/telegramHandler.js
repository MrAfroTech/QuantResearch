async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('[Telegram SKIPPED - not configured]');
    return null;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Telegram send failed:', errText.slice(0, 200));
      return null;
    }

    return await res.json();
  } catch (err) {
    console.error('Telegram send failed:', err.message);
    return null;
  }
}

export async function sendTradeOpenedTelegram(signal, tradeParams, paper) {
  const paperLabel = paper ? ' [PAPER]' : '';
  const price = tradeParams?.premium ?? signal?.curr_px ?? 0;
  await sendTelegram(
    `🟢 TRADE OPENED${paperLabel} ${signal.ticker} ${signal.direction} @ $${Number(price).toFixed(2)}`
  );
}

export async function sendTradeClosedTelegram(position, reason, pnlPct, exitPremium) {
  const pct = (pnlPct * 100).toFixed(1);
  await sendTelegram(
    `🔴 TRADE CLOSED ${position.ticker} — ${reason} | P&L: ${pct}%`
  );
}

export async function sendSignalNotExecutedTelegram(signal, reason) {
  await sendTelegram(
    `📡 SIGNAL ${signal.ticker} ${signal.direction || 'N/A'} — not executed: ${reason}`
  );
}

export async function sendModeSwitchTelegram(mode) {
  await sendTelegram(`🔄 Mode changed to ${mode}`);
}

export async function sendBudgetExhaustedTelegram(maxBudget = 599) {
  await sendTelegram(`⚠️ Monthly budget exhausted ($${maxBudget})`);
}

export async function sendTradingViewOfflineTelegram() {
  await sendTelegram('⚠️ TradingView MCP offline — scan skipped');
}
