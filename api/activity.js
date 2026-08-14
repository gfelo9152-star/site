// Vercel serverless function — إشعارات تلغرام لنشاط الموقع
// يُستدعى من المتصفح عبر sendBeacon — التوكن يبقى بالسيرفر فقط
// التوكن يُقرأ من متغير البيئة (Vercel env) — لا يُكتب في الكود
const { bumpStat, bumpIpVisit, AUTO_BLOCK_THRESHOLD } = require('./stats');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
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

  // علم الدولة من رمز ISO
  const FLAG_OFFSET = 127397;
  const countryCode = req.headers['x-vercel-ip-country'] || '';
  const flag = /^[A-Za-z]{2}$/.test(countryCode)
    ? String.fromCodePoint(...countryCode.toUpperCase().split('').map((c) => c.charCodeAt(0) + FLAG_OFFSET))
    : '';

  const msg = [
    `${emoji} ${typeName} جديدة`,
    `🕐 ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dubai' })} +04`,
    `🌐 ${ip || '?'}`,
    `📍 ${flag ? flag + ' ' : ''}${country || '?'}${city ? ' - ' + city : ''}`,
    `📱 الجهاز: ${device}`,
    keyword ? `🔑 الكلمة: ${escapeHtml(keyword)}` : null,
    keyword ? `🎯 المطابقة: ${mtName}` : null,
    gclid ? `🆔 GCLID: ${gclid.slice(0, 30)}` : null,
    `📄 ${escapeHtml(path.slice(0, 150))}`,
    label ? `🎯 ${escapeHtml(label)}` : null,
    `🔗 ${escapeHtml(ref || 'direct')}`,
  ].filter(Boolean).join('\n');

  // زر حظر الـ IP + زر المحظورات + إحصائيات
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(ip || '');
  const buttons = [];
  if (ipv4) buttons.push([
    { text: '🚫 حظر الـ IP', callback_data: `block:${ip}` },
    { text: '🌐 حظر الشبكة', callback_data: `blocknet:${ip}` },
  ]);
  buttons.push([{ text: '📋 المحظورات', callback_data: 'list' }]);
  buttons.push([{ text: '📊 إحصائيات اليوم', callback_data: 'stats' }]);
  const replyMarkup = { inline_keyboard: buttons };

  try {
    const t = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });
    const tj = await t.json().catch(() => ({}));
    if (!tj.ok) {
      return res.status(502).json({ ok: false, error: 'telegram', detail: tj.description });
    }

    // Daily counters (fire-and-forget)
    bumpStat(type === 'call' ? 'calls' : type === 'whatsapp' ? 'whatsapp' : 'views').catch(() => {});

    // Auto-block على الزيارات المتكررة فقط (نفس الـ IP 3+ مرات باليوم)
    if (type === 'view' && ipv4) {
      const visits = await bumpIpVisit(ip).catch(() => 0);
      if (visits === AUTO_BLOCK_THRESHOLD) {
        autoBlock(ip).catch(() => {});
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'telegram', detail: String(e).slice(0, 120) });
  }
}

// ─── Auto-block: حظر تلقائي لـ IP زائر متكرر ─────────────
async function autoBlock(ip) {
  try {
    const cid = process.env.GOOGLE_ADS_CLIENT_ID;
    const cs = process.env.GOOGLE_ADS_CLIENT_SECRET;
    const rt = process.env.GOOGLE_ADS_REFRESH_TOKEN;
    const dt = process.env.GOOGLE_ADS_DEV_TOKEN;
    const mcc = process.env.GOOGLE_ADS_MCC_ID || '5565578031';
    if (!cid || !cs || !rt || !dt) return;
    const oauth = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=${encodeURIComponent(cid)}&client_secret=${encodeURIComponent(cs)}&refresh_token=${encodeURIComponent(rt)}&grant_type=refresh_token`,
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (!oauth || !oauth.ok) return;
    const tok = (await oauth.json()).access_token;
    if (!tok) return;

    const cust = '9743497891';
    const list = await fetch(`https://googleads.googleapis.com/v24/customers/${cust}/googleAds:searchStream`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tok}`,
        'developer-token': dt,
        'login-customer-id': mcc,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: "SELECT campaign.id FROM campaign WHERE campaign.status = 'ENABLED' AND campaign.advertising_channel_type != 'PERFORMANCE_MAX'",
      }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);
    if (!list || !list.ok) return;
    const data = await list.json();
    const rows = Array.isArray(data) ? data : [data];
    let okCount = 0;
    for (const batch of rows) {
      for (const row of batch.results || []) {
        const rn = row.campaign?.resourceName;
        if (!rn) continue;
        const campaignId = rn.split('/').pop();
        const block = await fetch(`https://googleads.googleapis.com/v24/customers/${cust}/campaignCriteria:mutate`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tok}`,
            'developer-token': dt,
            'login-customer-id': mcc,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            operations: [{ create: { campaign: `customers/${cust}/campaigns/${campaignId}`, negative: true, ipBlock: { ipAddress: `${ip}/32` } } }],
          }),
          signal: AbortSignal.timeout(10000),
        }).catch(() => null);
        if (block && block.ok) okCount++;
      }
    }
    if (okCount > 0) bumpStat('blocked').catch(() => {});
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      const text =
        `🤖 <b>حظر تلقائي (تكرار زيارة)</b>\n` +
        `🌐 IP: <code>${ip}</code>\n` +
        `👀 زار ${AUTO_BLOCK_THRESHOLD} مرات اليوم\n` +
        `✅ انحظر من ${okCount} حملة`;
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
        signal: AbortSignal.timeout(8000),
      });
    }
  } catch {
    // silent
  }
}
