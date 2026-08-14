// Vercel serverless — Webhook زر «حظر/فك حظر/قائمة IP» (Cleaning/Avavine)
// يستقبل ضغطة زر التلغرام ويحظر/يفك/يعرض على حساب 9743497891 (Avavine)
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
      query: "SELECT campaign_criterion.ip_block.ip_address FROM campaign_criterion WHERE campaign_criterion.type = 'IP_BLOCK' AND campaign_criterion.status = 'ENABLED'",
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
  const queries = [
    `SELECT campaign_criterion.resource_name FROM campaign_criterion WHERE campaign_criterion.type = 'IP_BLOCK' AND campaign_criterion.ip_block.ip_address = '${ip}/32'`,
    `SELECT campaign_criterion.resource_name FROM campaign_criterion WHERE campaign_criterion.type = 'IP_BLOCK' AND campaign_criterion.ip_block.ip_address = '${network}'`,
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

  // ─── List ───────────────────────────────────────
  if (data === 'list') {
    await answerCallback(tokenT, cq.id, '⏳ جارٍ جلب القائمة...');
    const token = await getGadsToken();
    if (!token) {
      await editMessage(tokenT, chatId, messageId, `❌ تعذر الحصول على توكن Google Ads`);
      return res.status(200).json({ ok: true });
    }
    const items = await listBlockedIps(token);
    if (items.length === 0) {
      await editMessage(tokenT, chatId, messageId, `📋 <b>لا توجد IPs محظورة</b> في الحسابات المستهدفة.`);
      return res.status(200).json({ ok: true, count: 0 });
    }
    const lines = items.map((x) => `• <code>${x.ip}</code> — ${x.count} حملة`);
    const chunks = [];
    let chunk = `📋 <b>المحظورات (${items.length})</b>\n`;
    for (const line of lines) {
      if ((chunk + line).length > 3800) {
        chunks.push(chunk);
        chunk = line + '\n';
      } else {
        chunk += line + '\n';
      }
    }
    chunks.push(chunk);
    await editMessage(tokenT, chatId, messageId, chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await tgApi(tokenT, 'sendMessage', { chat_id: chatId, text: chunks[i], parse_mode: 'HTML' });
    }
    return res.status(200).json({ ok: true, count: items.length });
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
    ],
  };
  await editMessage(tokenT, chatId, messageId, summary, replyMarkup);
  return res.status(200).json({ ok: true, blocked: ip, okCount, failCount, details });
}
