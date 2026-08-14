// Vercel serverless — ضبط Webhook (مرة واحدة) لبوت Cleaning/Avavine
export default async function handler(req, res) {
  const key = (req.query && req.query.key) || '';
  if (!process.env.WEBHOOK_SETUP_KEY || key !== process.env.WEBHOOK_SETUP_KEY) {
    return res.status(403).json({ ok: false, error: 'unauthorized' });
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'no bot token' });

  const host = req.headers.host || '';
  const webhookUrl = `https://${host}/api/bot`;

  const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, drop_pending_updates: true }),
    signal: AbortSignal.timeout(8000),
  });
  const d = await r.json().catch(() => ({}));

  const info = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, { signal: AbortSignal.timeout(8000) })
    .then((x) => x.json())
    .catch(() => ({}));

  return res.status(200).json({ ok: d.ok === true, set: d, info: info.result || info });
}
