// Vercel serverless function — إشعارات تلغرام لنشاط الموقع
// يُستدعى من المتصفح عبر sendBeacon — التوكن يبقى بالسيرفر فقط
const TELEGRAM_BOT_TOKEN = '8814260556:AAGxQ9_tdJaewYAJYbfA2PBp7a_UXQ9oNcA';
const TELEGRAM_CHAT_ID = '7304090625'; // Bilal home channel
const ALLOWED_ORIGIN = 'https://site-iota-five-75.vercel.app';

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export default async function handler(req, res) {
  // CORS + origin validation
  const origin = req.headers.origin || '';
  if (origin && origin !== ALLOWED_ORIGIN && !origin.endsWith('.vercel.app')) {
    return res.status(403).json({ ok: false, error: 'origin' });
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method' });

  let body = {};
  try {
    if (req.headers['content-type']?.includes('application/json')) {
      body = req.body || {};
    } else {
      const raw = req.body || '';
      body = Object.fromEntries(new URLSearchParams(raw));
    }
  } catch (e) { body = {}; }

  const type = body.type || 'view';
  const path = body.path || '/';
  const label = body.label || '';
  const title = body.title || '';
  const ua = req.headers['user-agent'] || '';
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-vercel-ip'] || '?';
  const country = req.headers['x-vercel-ip-country'] || '';
  const city = req.headers['x-vercel-ip-city'] || '';
  const region = req.headers['x-vercel-ip-country-region'] || '';
  const ref = req.headers.referer || '';

  // استخراج الكلمة المفتاحية ومعاملات ValueTrack من الـ URL
  let keyword = '', gclid = '', matchType = '', campaignId = '', adGroupId = '';
  try {
    const qs = new URLSearchParams(path.split('?')[1] || '');
    keyword = qs.get('keyword') || '';
    gclid = qs.get('gclid') || '';
    matchType = qs.get('match_type') || '';
    campaignId = qs.get('campaign_id') || '';
    adGroupId = qs.get('ad_group_id') || '';
    if (keyword) keyword = decodeURIComponent(keyword);
  } catch (e) {}

  const mtName = matchType === 'e' ? 'مطابقة تامة' : matchType === 'p' ? 'مطابقة عبارة' : matchType === 'b' ? 'مطابقة واسعة' : (matchType || '?');

  // نوع الجهاز من User-Agent
  let device = '?';
  try {
    if (/android/i.test(ua) || /iphone|ipod|mobile/i.test(ua)) device = '📱 موبايل';
    else if (/ipad|tablet/i.test(ua)) device = '💻 تابلت';
    else if (/windows|macintosh|linux|ubuntu|chrome\/\d+\.\d+\s*safari/i.test(ua) && !/mobile/i.test(ua)) device = '🖥️ كمبيوتر';
    else device = '❓ غير معروف';
    if (/ios|iphone|ipad|ipod/i.test(ua)) device += ' (iOS)';
    else if (/android/i.test(ua)) device += ' (Android)';
    else if (/windows/i.test(ua)) device += ' (Windows)';
    else if (/macintosh|mac os/i.test(ua)) device += ' (macOS)';
  } catch (e) {}

  const emoji = type === 'call' ? '📞' : type === 'whatsapp' ? '💬' : '👀';
  const typeName = type === 'call' ? 'نقرة اتصال' : type === 'whatsapp' ? 'نقرة واتساب' : 'زيارة صفحة';

  const msg = [
    `${emoji} ${typeName} جديدة`,
    `🕐 ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dubai' })} +04`,
    `🌐 ${ip || '?'}`,
    `📍 ${country || '?'}${city ? ' - ' + city : ''}`,
    `📱 الجهاز: ${device}`,
    keyword ? `🔑 الكلمة: ${escapeHtml(keyword)}` : null,
    keyword ? `🎯 المطابقة: ${mtName}` : null,
    gclid ? `🆔 GCLID: ${gclid.slice(0, 30)}` : null,
    `📄 ${escapeHtml(path.slice(0, 150))}`,
    label ? `🎯 ${escapeHtml(label)}` : null,
    `🔗 ${escapeHtml(ref || 'direct')}`,
  ].filter(Boolean).join('\n');

  try {
    const t = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(8000),
    });
    const tj = await t.json().catch(() => ({}));
    if (!tj.ok) {
      return res.status(502).json({ ok: false, error: 'telegram', detail: tj.description });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'telegram', detail: String(e).slice(0, 120) });
  }
}
