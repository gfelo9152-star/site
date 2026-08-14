// Vercel serverless — تقرير يومي قصير (cron)
const { getTodayStats } = require('./stats');

export default async function handler(req, res) {
  const auth = (req.query && req.query.key) || '';
  const cronHeader = req.headers['x-vercel-cron'];
  const valid =
    cronHeader === '1' ||
    (process.env.CRON_SECRET && auth === process.env.CRON_SECRET) ||
    (process.env.WEBHOOK_SETUP_KEY && auth === process.env.WEBHOOK_SETUP_KEY);
  if (!valid) return res.status(403).json({ ok: false, error: 'unauthorized' });

  const tokenT = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = '7304090625';
  if (!tokenT) return res.status(500).json({ ok: false, error: 'not configured' });

  const s = await getTodayStats();
  const total = s.views + s.calls + s.whatsapp + s.blocked;
  const todayAr = new Date().toLocaleDateString('ar-EG', { timeZone: 'Asia/Dubai', weekday: 'long', day: 'numeric', month: 'long' });

  const text =
    `📊 <b>تقرير اليوم — تنظيف</b>\n` +
    `🗓 ${todayAr}\n\n` +
    `👀 الزيارات: <b>${s.views}</b>\n` +
    `📞 الاتصالات: <b>${s.calls}</b>\n` +
    `💬 واتساب: <b>${s.whatsapp}</b>\n` +
    `🚫 IPs محظورة: <b>${s.blocked}</b>\n` +
    `\nالمجموع: ${total}`;

  const r = await fetch(`https://api.telegram.org/bot${tokenT}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    signal: AbortSignal.timeout(8000),
  });
  const d = await r.json().catch(() => ({}));
  return res.status(200).json({ ok: d.ok === true, sent: d.ok === true });
}
