// Vercel serverless — Webhook زر «حظر/فك حظر/قائمة IP» (Cleaning/Avavine)
// يستقبل ضغطة زر التلغرام ويحظر/يفك/يعرض على حساب 9743497891 (Avavine)
const { bumpStat, getTodayStats } = require('./stats');
const { runCampaignReview } = require('./review');
const TARGET_CIDS = ['9743497891'];
const MCC_ID = '5565578031';
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

async function tgApi(token, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  return r.json().catch(() => ({}));
}

async function answerCallback(token, id, text) {
  await tgApi(token, 'answerCallbackQuery', { callback_query_id: id, text, show_alert: false });
}

async function editMessage(token, chatId, messageId, text, replyMarkup) {
  await tgApi(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function getGadsToken() {
  const cid = process.env.GOOGLE_ADS_CLIENT_ID;
  const cs = process.env.GOOGLE_ADS_CLIENT_SECRET;
  const rt = process.env.GOOGLE_ADS_REFRESH_TOKEN;
  if (!cid || !cs || !rt) return null;
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=${encodeURIComponent(cid)}&client_secret=${encodeURIComponent(cs)}&refresh_token=${encodeURIComponent(rt)}&grant_type=refresh_token`,
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.access_token || null;
  } catch { return null; }
}

async function gadsRaw(token, customerId, path, body) {
  const dt = process.env.GOOGLE_ADS_DEV_TOKEN;
  if (!dt) return { ok: false, detail: 'no dev token' };
  try {
    const r = await fetch(`https://googleads.googleapis.com/v24/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'developer-token': dt,
        'login-customer-id': MCC_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ok: false, status: r.status, detail: txt.slice(0, 300) };
    }
    return { ok: true, data: await r.json().catch(() => undefined) };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 200) };
  }
}

async function getEnabledCampaigns(token, customerId) {
  const res = await gadsRaw(token, customerId, `customers/${customerId}/googleAds:searchStream`, {
    query: "SELECT campaign.id FROM campaign WHERE campaign.status = 'ENABLED' AND campaign.advertising_channel_type != 'PERFORMANCE_MAX'",
  });
  if (!res.ok) return [];
  const batches = Array.isArray(res.data) ? res.data : [];
  const ids = [];
  for (const batch of batches) {
    for (const row of batch.results || []) {
      const rn = row.campaign?.resourceName;
      if (rn) ids.push(rn.split('/').pop());
    }
  }
  return ids;
}

async function blockIpOnCampaign(token, customerId, campaignId, ip) {
  const res = await gadsRaw(token, customerId, `customers/${customerId}/campaignCriteria:mutate`, {
    operations: [
      {
        create: {
          campaign: `customers/${customerId}/campaigns/${campaignId}`,
          negative: true,
          ipBlock: { ipAddress: `${ip}/32` },
        },
      },
    ],
  });
  return { ok: res.ok, detail: res.detail };
}

async function blockNetworkOnCampaign(token, customerId, campaignId, ip) {
  const parts = ip.split('.');
  const network = `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  const res = await gadsRaw(token, customerId, `customers/${customerId}/campaignCriteria:mutate`, {
    operations: [
      {
        create: {
          campaign: `customers/${customerId}/campaigns/${campaignId}`,
          negative: true,
          ipBlock: { ipAddress: network },
        },
      },
    ],
  });
  return { ok: res.ok, detail: res.detail };
}

async function listBlockedIps(token) {
  const map = new Map();
  for (const cid of TARGET_CIDS) {
    const res = await gadsRaw(token, cid, `customers/${cid}/googleAds:searchStream`, {
      query: "SELECT campaign_criterion.ip_block.ip_address FROM campaign_criterion WHERE campaign_criterion.type = 'IP_BLOCK' AND campaign_criterion.status = 'ENABLED' AND campaign.status != 'REMOVED'",
    });
    if (!res.ok) continue;
    const batches = Array.isArray(res.data) ? res.data : [];
    for (const batch of batches) {
      for (const row of batch.results || []) {
        const addr = row.campaignCriterion?.ipBlock?.ipAddress;
        if (addr) {
          const bare = addr.replace(/\/32$/, '');
          map.set(bare, (map.get(bare) || 0) + 1);
        }
      }
    }
  }
  return Array.from(map.entries())
    .map(([ip, count]) => ({ ip, count }))
    .sort((a, b) => a.ip.localeCompare(b.ip, 'en', { numeric: true }));
}

async function unblockIp(token, ip) {
  let ok = 0;
  let fail = 0;
  const details = [];
  const parts = ip.split('.');
  const network = `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  // نستبعد الحملات المحذوفة: Google يرفض mutate على موارد حملة REMOVED (OPERATION_NOT_PERMITTED_FOR_REMOVED_RESOURCE)
  const queries = [
    `SELECT campaign_criterion.resource_name FROM campaign_criterion WHERE campaign_criterion.type = 'IP_BLOCK' AND campaign.status != 'REMOVED' AND campaign_criterion.ip_block.ip_address = '${ip}/32'`,
    `SELECT campaign_criterion.resource_name FROM campaign_criterion WHERE campaign_criterion.type = 'IP_BLOCK' AND campaign.status != 'REMOVED' AND campaign_criterion.ip_block.ip_address = '${network}'`,
  ];
  for (const cid of TARGET_CIDS) {
    const resources = [];
    let searchFailed = false;
    for (const query of queries) {
      const searchRes = await gadsRaw(token, cid, `customers/${cid}/googleAds:searchStream`, { query });
      if (!searchRes.ok) {
        searchFailed = true;
        continue;
      }
      const batches = Array.isArray(searchRes.data) ? searchRes.data : [];
      for (const batch of batches) {
        for (const row of batch.results || []) {
          const rn = row.campaignCriterion?.resourceName;
          if (rn) resources.push(rn);
        }
      }
    }
    if (searchFailed && resources.length === 0) {
      fail++;
      details.push(`<b>${cid}</b>: search failed`);
      continue;
    }
    if (resources.length === 0) {
      details.push(`<b>${cid}</b>: غير محظور`);
      continue;
    }
    const removeRes = await gadsRaw(token, cid, `customers/${cid}/campaignCriteria:mutate`, {
      operations: resources.map((rn) => ({ remove: rn })),
    });
    if (removeRes.ok) {
      ok += resources.length;
      details.push(`<b>${cid}</b>: فُك من ${resources.length} حملة`);
    } else {
      fail += resources.length;
      details.push(`<b>${cid}</b>: ${(removeRes.detail || 'error').slice(0, 80)}`);
    }
  }
  return { ok, fail, details };
}

async function listSearchTerms(token, customerId) {
  const res = await gadsRaw(token, customerId, `customers/${customerId}/googleAds:searchStream`, {
    query: `SELECT search_term_view.search_term, search_term_view.keyword_info.match_type,
                   metrics.impressions, metrics.clicks, metrics.cost_micros
            FROM search_term_view
            WHERE segments.date DURING TODAY
            ORDER BY metrics.impressions DESC`,
  });
  if (!res.ok) return { ok: false, detail: res.detail };
  const batches = Array.isArray(res.data) ? res.data : [];
  const terms = [];
  for (const batch of batches) {
    for (const row of batch.results || []) {
      const st = row.searchTermView?.searchTerm;
      if (!st) continue;
      terms.push({
        term: st,
        match: row.searchTermView?.keywordInfo?.matchType || '?',
        impressions: Number(row.metrics?.impressions || 0),
        clicks: Number(row.metrics?.clicks || 0),
        cost: Number(row.metrics?.costMicros || 0) / 1e6,
      });
    }
  }
  terms.sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks);
  return { ok: true, terms };
}

async function addNegativeKeyword(token, customerId, campaignId, term) {
  const res = await gadsRaw(token, customerId, `customers/${customerId}/campaignCriteria:mutate`, {
    operations: [
      {
        create: {
          campaign: `customers/${customerId}/campaigns/${campaignId}`,
          negative: true,
          keyword: { text: term, matchType: 'EXACT' },
        },
      },
    ],
  });
  return { ok: res.ok, detail: res.detail };
}

export default async function handler(req, res) {
  const tokenT = process.env.TELEGRAM_BOT_TOKEN;
  const allowedChat = Number('7304090625');
  if (!tokenT) return res.status(500).json({ ok: false });

  let update;
  try { update = req.body || {}; } catch { return res.status(400).json({ ok: false }); }

  const cq = update.callback_query;
  if (!cq) return res.status(200).json({ ok: true });

  const fromId = cq.from?.id;
  if (fromId !== allowedChat) {
    await answerCallback(tokenT, cq.id, 'غير مصرح');
    return res.status(200).json({ ok: true });
  }

  const data = cq.data || '';
  const msg = cq.message;
  const chatId = msg?.chat?.id;
  const messageId = msg?.message_id;

  // ─── زر الرجوع ────────────────────────────────
  if (data === 'back') {
    await answerCallback(tokenT, cq.id, '');
    const menu = {
      inline_keyboard: [
        [{ text: '📊 إحصائيات اليوم', callback_data: 'stats' }, { text: '📋 المحظورات', callback_data: 'list' }],
        [{ text: '🔍 مراجعة أداء الحملة', callback_data: 'review' }],
        [{ text: '🔎 كلمات الظهور اليوم', callback_data: 'terms' }],
      ],
    };
    await editMessage(tokenT, chatId, messageId, `🧭 <b>القائمة</b>\nاختر إجراءً:`, menu);
    return res.status(200).json({ ok: true });
  }

  // ─── زر العد الإجمالي (بلا حركة) ────────────────
  if (data === 'noop') {
    await answerCallback(tokenT, cq.id, '');
    return res.status(200).json({ ok: true });
  }

  // ─── مراجعة أداء الحملة ──────────────────────────
  if (data === 'review') {
    await answerCallback(tokenT, cq.id, '⏳ جارٍ مراجعة أداء الحملة...');
    const review = await runCampaignReview();
    if (!review.ok) {
      await editMessage(tokenT, chatId, messageId, `❌ <b>فشلت المراجعة</b>\n${review.error || 'خطأ غير معروف'}`);
      return res.status(200).json({ ok: true, error: review.error });
    }
    const backBtn = { inline_keyboard: [[{ text: '📊 إحصائيات اليوم', callback_data: 'stats' }, { text: '📋 المحظورات', callback_data: 'list' }]] };
    await editMessage(tokenT, chatId, messageId, review.text, backBtn);
    return res.status(200).json({ ok: true });
  }

  // ─── كلمات الظهور اليوم ─────────────────────────
  if (data === 'terms') {
    await answerCallback(tokenT, cq.id, '⏳ جارٍ جلب كلمات الظهور...');
    const token = await getGadsToken();
    if (!token) {
      await editMessage(tokenT, chatId, messageId, `❌ تعذر الحصول على توكن Google Ads`);
      return res.status(200).json({ ok: true });
    }
    const res = await listSearchTerms(token, TARGET_CIDS[0]);
    if (!res.ok) {
      await editMessage(tokenT, chatId, messageId, `❌ فشل جلب كلمات الظهور: ${res.detail || ''}`);
      return res.status(200).json({ ok: true });
    }
    const terms = res.terms.slice(0, 15);
    if (terms.length === 0) {
      const backBtn = { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'back' }]] };
      await editMessage(tokenT, chatId, messageId, `🔎 <b>لا كلمات ظهور لليوم</b>`, backBtn);
      return res.status(200).json({ ok: true, count: 0 });
    }
    const todayAr = new Date().toLocaleDateString('ar-EG', { timeZone: 'Asia/Dubai', weekday: 'long', day: 'numeric', month: 'long' });
    const matchName = (m) => m === 'EXACT' ? 'تامة' : m === 'PHRASE' ? 'عبارة' : m === 'BROAD' ? 'واسعة' : '?';
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const lines = [`🔎 <b>كلمات الظهور اليوم — تنظيف</b>`, `🗓 ${todayAr}`, ''];
    const keyboard = [];
    terms.forEach((t, i) => {
      lines.push(
        `${i + 1}. <b>${esc(t.term)}</b>\n` +
        `   👀 ${t.impressions} 🙌 ${t.clicks} 💰 ${t.cost.toFixed(1)}درهم · ${matchName(t.match)}`
      );
      keyboard.push([{ text: `🚫 حظر #${i + 1} — ${t.term.slice(0, 30)}`, callback_data: `negterm:${i}` }]);
    });
    keyboard.push([{ text: '🔙 رجوع', callback_data: 'back' }]);
    await editMessage(tokenT, chatId, messageId, lines.join('\n'), { inline_keyboard: keyboard });
    return res.status(200).json({ ok: true, count: terms.length });
  }

  // ─── حظر كلمة سلبية ────────────────────────────
  if (data.startsWith('negterm:')) {
    const idx = Number(data.slice(8).trim());
    await answerCallback(tokenT, cq.id, '⏳ جارٍ حظر الكلمة...');
    const token = await getGadsToken();
    if (!token) {
      await editMessage(tokenT, chatId, messageId, `❌ تعذر الحصول على توكن Google Ads`);
      return res.status(200).json({ ok: true });
    }
    const res = await listSearchTerms(token, TARGET_CIDS[0]);
    if (!res.ok || !res.terms[idx]) {
      await editMessage(tokenT, chatId, messageId, `❌ انتهت صلاحية القائمة — اضغط «🔎 كلمات الظهور» من جديد`);
      return res.status(200).json({ ok: true });
    }
    const term = res.terms[idx].term;
    const customerId = TARGET_CIDS[0];
    const campaigns = await getEnabledCampaigns(token, customerId);
    let okCount = 0, failCount = 0;
    const details = [];
    if (campaigns.length === 0) {
      await editMessage(tokenT, chatId, messageId, `⚠️ لا حملات نشطة لإضافة الكلمة السلبية`);
      return res.status(200).json({ ok: true });
    }
    for (const campaignId of campaigns) {
      const r = await addNegativeKeyword(token, customerId, campaignId, term);
      if (r.ok) okCount++;
      else { failCount++; details.push(`<b>${customerId}</b>/${campaignId}: ${(r.detail || 'error').slice(0, 80)}`); }
    }
    const summary =
      `🚫 <b>تمت إضافة كلمة سلبية (تامة)</b>\n` +
      `🔑 <b>${esc(term)}</b>\n` +
      `✅ ${okCount} حملة\n` +
      (failCount ? `❌ ${failCount} فشل\n${details.slice(0, 5).join('\n')}` : '');
    const replyMarkup = {
      inline_keyboard: [
        [{ text: '🔎 كلمات الظهور اليوم', callback_data: 'terms' }],
        [{ text: '🔙 رجوع', callback_data: 'back' }],
      ],
    };
    await editMessage(tokenT, chatId, messageId, summary, replyMarkup);
    return res.status(200).json({ ok: true, term, okCount, failCount });
  }

  // ─── Today's stats ─────────────────────────────
  if (data === 'stats') {
    await answerCallback(tokenT, cq.id, '⏳ جارٍ جلب الإحصائيات...');
    const s = await getTodayStats();
    const total = s.views + s.calls + s.whatsapp + s.blocked;
    const todayAr = new Date().toLocaleDateString('ar-EG', { timeZone: 'Asia/Dubai', weekday: 'long', day: 'numeric', month: 'long' });
    const text =
      `📊 <b>إحصائيات اليوم — تنظيف</b>\n` +
      `🗓 ${todayAr}\n\n` +
      `👀 الزيارات: <b>${s.views}</b>\n` +
      `📞 الاتصالات: <b>${s.calls}</b>\n` +
      `💬 واتساب: <b>${s.whatsapp}</b>\n` +
      `🚫 IPs محظورة: <b>${s.blocked}</b>\n` +
      `\nالمجموع: ${total}`;
    await editMessage(tokenT, chatId, messageId, text);
    return res.status(200).json({ ok: true, stats: s });
  }

  // ─── List (5 نتائج لكل صفحة + تنقّل) ──────────────
  if (data === 'list' || data.startsWith('listp:')) {
    const page = data === 'list' ? 0 : Math.max(0, parseInt(data.split(':')[1], 10) || 0);
    await answerCallback(tokenT, cq.id, '⏳ جارٍ جلب القائمة...');
    const token = await getGadsToken();
    if (!token) {
      await editMessage(tokenT, chatId, messageId, `❌ تعذر الحصول على توكن Google Ads`);
      return res.status(200).json({ ok: true });
    }
    const items = await listBlockedIps(token);
    const total = items.length;
    if (total === 0) {
      const emptyBtn = { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'back' }]] };
      await editMessage(tokenT, chatId, messageId, `📋 <b>لا توجد IPs محظورة</b> في الحسابات المستهدفة.`, emptyBtn);
      return res.status(200).json({ ok: true, count: 0 });
    }
    const PER = 5;
    const pages = Math.ceil(total / PER);
    const cur = Math.min(page, pages - 1);
    const start = cur * PER;
    const slice = items.slice(start, start + PER);
    const lines = slice.map((x) => `• <code>${x.ip}</code> — ${x.count} حملة`).join('\n');
    const end = Math.min(start + PER, total);
    const text = `📋 <b>المحظورات</b>\nالنتائج ${start + 1}–${end} من <b>${total}</b>\n\n${lines}`;
    const keyboard = [];
    const nav = [];
    if (cur > 0) nav.push({ text: '⬅️ السابق', callback_data: `listp:${cur - 1}` });
    if (cur < pages - 1) nav.push({ text: 'التالي ➡️', callback_data: `listp:${cur + 1}` });
    if (nav.length) keyboard.push(nav);
    keyboard.push([{ text: `🔢 الإجمالي: ${total}`, callback_data: 'noop' }]);
    keyboard.push([{ text: '🔙 رجوع', callback_data: 'back' }]);
    await editMessage(tokenT, chatId, messageId, text, { inline_keyboard: keyboard });
    return res.status(200).json({ ok: true, count: total, page: cur, pages });
  }

  // ─── Unblock ────────────────────────────────────
  if (data.startsWith('unblock:')) {
    const ip = data.slice(8).trim();
    if (!IPV4.test(ip)) {
      await answerCallback(tokenT, cq.id, 'IP غير صالح');
      return res.status(200).json({ ok: true });
    }
    await answerCallback(tokenT, cq.id, `⏳ جارٍ فك حظر ${ip}...`);
    const token = await getGadsToken();
    if (!token) {
      await editMessage(tokenT, chatId, messageId, `❌ فشل: تعذر الحصول على توكن Google Ads`);
      return res.status(200).json({ ok: true });
    }
    const res2 = await unblockIp(token, ip);
    const summary =
      `✅ <b>تم فك حظر ${ip}</b>\n` +
      (res2.ok ? `↩️ أُزيل من ${res2.ok} موقع\n` : '') +
      (res2.details.length ? res2.details.slice(0, 6).join('\n') : '');
    await editMessage(tokenT, chatId, messageId, summary);
    return res.status(200).json({ ok: true, unblocked: ip, removed: res2.ok, failed: res2.fail });
  }

  // ─── Block network /24 ─────────────────────────
  if (data.startsWith('blocknet:')) {
    const ip = data.slice(9).trim();
    if (!IPV4.test(ip)) {
      await answerCallback(tokenT, cq.id, 'IP غير صالح');
      return res.status(200).json({ ok: true });
    }
    await answerCallback(tokenT, cq.id, `⏳ جارٍ حظر الشبكة ${ip.slice(0, ip.lastIndexOf('.'))}.0/24...`);
    const token = await getGadsToken();
    if (!token) {
      await editMessage(tokenT, chatId, messageId, `❌ فشل: تعذر الحصول على توكن Google Ads`);
      return res.status(200).json({ ok: true });
    }
    let okCount = 0;
    let failCount = 0;
    const details = [];
    for (const cid of TARGET_CIDS) {
      const campaigns = await getEnabledCampaigns(token, cid);
      if (campaigns.length === 0) {
        details.push(`<b>${cid}</b>: لا حملات نشطة`);
        continue;
      }
      for (const campaignId of campaigns) {
        const r = await blockNetworkOnCampaign(token, cid, campaignId, ip);
        if (r.ok) okCount++;
        else {
          failCount++;
          details.push(`<b>${cid}</b>/${campaignId}: ${(r.detail || 'error').slice(0, 80)}`);
        }
      }
    }
    const summary =
      `🚫 <b>تم حظر الشبكة ${ip.slice(0, ip.lastIndexOf('.'))}.0/24</b>\n` +
      `✅ ${okCount} حملة تم الحظر فيها\n` +
      (failCount ? `❌ ${failCount} فشل\n${details.slice(0, 5).join('\n')}` : '');
    const replyMarkup = { inline_keyboard: [[{ text: '📋 المحظورات', callback_data: 'list' }]] };
    await editMessage(tokenT, chatId, messageId, summary, replyMarkup);
    return res.status(200).json({ ok: true, blockedNet: ip, okCount, failCount });
  }

  // ─── Block ──────────────────────────────────────
  if (!data.startsWith('block:')) {
    await answerCallback(tokenT, cq.id, 'إجراء غير معروف');
    return res.status(200).json({ ok: true });
  }

  const ip = data.slice(6).trim();
  if (!IPV4.test(ip)) {
    await answerCallback(tokenT, cq.id, 'IP غير صالح');
    return res.status(200).json({ ok: true });
  }

  await answerCallback(tokenT, cq.id, `⏳ جارٍ حظر ${ip}...`);

  const token = await getGadsToken();
  if (!token) {
    await editMessage(tokenT, chatId, messageId, `❌ فشل الحظر: تعذر الحصول على توكن Google Ads`);
    return res.status(200).json({ ok: true });
  }

  let okCount = 0;
  let failCount = 0;
  const details = [];

  for (const cid of TARGET_CIDS) {
    const campaigns = await getEnabledCampaigns(token, cid);
    if (campaigns.length === 0) {
      details.push(`<b>${cid}</b>: لا حملات نشطة`);
      continue;
    }
    for (const campaignId of campaigns) {
      const r = await blockIpOnCampaign(token, cid, campaignId, ip);
      if (r.ok) okCount++;
      else {
        failCount++;
        details.push(`<b>${cid}</b>/${campaignId}: ${(r.detail || 'error').slice(0, 80)}`);
      }
    }
  }

  const summary =
    `🚫 <b>تم حظر ${ip}</b>\n` +
    `✅ ${okCount} حملة تم الحظر فيها\n` +
    (failCount ? `❌ ${failCount} فشل\n${details.slice(0, 5).join('\n')}` : '');

  const replyMarkup = {
    inline_keyboard: [
      [{ text: '↩️ فك الحظر', callback_data: `unblock:${ip}` }, { text: '📋 المحظورات', callback_data: 'list' }],
      [{ text: '📊 إحصائيات اليوم', callback_data: 'stats' }],
    ],
  };
  await editMessage(tokenT, chatId, messageId, summary, replyMarkup);
  if (okCount > 0) { try { await bumpStat('blocked'); } catch (e) {} }
  return res.status(200).json({ ok: true, blocked: ip, okCount, failCount, details });
}
