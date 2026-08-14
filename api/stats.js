// عدّادات يومية عبر Vercel Blob — إحصائيات اليوم (زيارات/اتصالات/واتساب/محظورات)

const EMPTY = { views: 0, calls: 0, whatsapp: 0, blocked: 0 };

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function storeId() {
  return (process.env.BLOB_READ_WRITE_TOKEN || '').split('_')[2] || '';
}

async function readStats() {
  const sid = storeId();
  if (!sid) return { ...EMPTY };
  const url = `https://${sid}.public.blob.vercel-storage.com/stats/${todayKey()}.json`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { ...EMPTY };
    const d = await r.json();
    return { ...EMPTY, ...d };
  } catch {
    return { ...EMPTY };
  }
}

async function writeStats(stats) {
  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) return;
    const r = await fetch(`https://api.vercel.com/v1/blob?path=stats/${todayKey()}.json`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(stats),
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) console.error('[stats] write failed', r.status, await r.text().catch(() => ''));
  } catch (e) {
    console.error('[stats] write error', String(e).slice(0, 120));
  }
}

async function bumpStat(type) {
  const stats = await readStats();
  stats[type] = (stats[type] || 0) + 1;
  await writeStats(stats);
}

async function getTodayStats() {
  return readStats();
}

// ─── تتبع زيارات IPs (للحظر التلقائي بالتكرار) ──────────

async function readIpVisits() {
  const sid = storeId();
  if (!sid) return {};
  const url = `https://${sid}.public.blob.vercel-storage.com/stats/ipvisits-${todayKey()}.json`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return {};
    return await r.json();
  } catch {
    return {};
  }
}

async function writeIpVisits(map) {
  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) return;
    await fetch(`https://api.vercel.com/v1/blob?path=stats/ipvisits-${todayKey()}.json`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(map),
      signal: AbortSignal.timeout(6000),
    });
  } catch (e) {
    console.error('[stats] ipvisits write error', String(e).slice(0, 120));
  }
}

async function bumpIpVisit(ip) {
  const map = await readIpVisits();
  const next = (map[ip] || 0) + 1;
  map[ip] = next;
  await writeIpVisits(map);
  return next;
}

const AUTO_BLOCK_THRESHOLD = 3;

module.exports = { bumpStat, getTodayStats, bumpIpVisit, AUTO_BLOCK_THRESHOLD };
