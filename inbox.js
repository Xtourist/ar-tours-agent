// inbox.js - conversation store + web inbox for AR Tours.
//
// Fix (2026-08-07): this used to store everything in a JSON file on local
// disk (and media metadata in an in-memory Map), which lives on Render's
// free-tier ephemeral filesystem/process memory and gets wiped on every
// restart, redeploy, or free-tier spin-down. That caused chat history, read
// status, and photo records to silently disappear. Everything now lives in
// a Supabase Postgres database instead — real permanent storage that
// survives restarts, deploys, and sleep cycles.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const OPERATOR_ID = process.env.OPERATOR_ID || 'ar_tours';

const supabase = (SUPABASE_URL && SUPABASE_SECRET_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY)
  : null;

if (!supabase) {
  console.warn('inbox.js: SUPABASE_URL / SUPABASE_SECRET_KEY not set — chat history will not persist across restarts.');
}

// In-memory fallback so the app doesn't crash if Supabase env vars are
// missing (e.g. local dev without a .env) — but this fallback still has the
// same old problem (wiped on restart), so it's a safety net, not the plan.
const fallback = { conversations: new Map(), messages: [], push: new Map(), media: [] };

async function record(phone, name, direction, body) {
  const at = new Date().toISOString();
  if (!supabase) {
    if (!fallback.conversations.has(phone)) fallback.conversations.set(phone, { name: name || phone });
    if (name) fallback.conversations.get(phone).name = name;
    fallback.conversations.get(phone).lastAt = at;
    fallback.messages.push({ phone, dir: direction, body: body || '', at });
    return;
  }
  await supabase.from('conversations').upsert({
    phone,
    name: name || phone,
    last_at: at,
    operator_id: OPERATOR_ID,
  }, { onConflict: 'phone' });
  await supabase.from('messages').insert({ phone, dir: direction, body: body || '', at });
}

async function listConversations() {
  if (!supabase) {
    return Array.from(fallback.conversations.entries()).map(([phone, c]) => {
      const msgs = fallback.messages.filter(m => m.phone === phone);
      return { phone, name: c.name, lastAt: c.lastAt, preview: msgs.length ? msgs[msgs.length - 1].body : '', businessNumberId: c.businessNumberId || null };
    }).sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
  }
  const { data: convos, error } = await supabase
    .from('conversations')
    .select('phone, name, last_at, business_number_id')
    .order('last_at', { ascending: false });
  if (error) { console.warn('listConversations error:', error.message); return []; }

  // Pull the latest message per phone for the preview text.
  const results = await Promise.all((convos || []).map(async (c) => {
    const { data: last } = await supabase
      .from('messages')
      .select('body')
      .eq('phone', c.phone)
      .order('at', { ascending: false })
      .limit(1);
    return {
      phone: c.phone,
      name: c.name,
      lastAt: c.last_at,
      preview: last && last[0] ? last[0].body : '',
      businessNumberId: c.business_number_id || null,
    };
  }));
  return results;
}

async function getMessages(phone) {
  if (!supabase) {
    return fallback.messages.filter(m => m.phone === phone).map(m => ({ dir: m.dir, body: m.body, at: m.at }));
  }
  const { data, error } = await supabase
    .from('messages')
    .select('dir, body, at')
    .eq('phone', phone)
    .order('at', { ascending: true })
    .limit(500);
  if (error) { console.warn('getMessages error:', error.message); return []; }
  return data || [];
}

// 24h window: open if the customer sent an inbound message within the last 24h
async function isWindowOpen(phone) {
  const msgs = await getMessages(phone);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].dir === 'inbound') {
      const diffH = (Date.now() - new Date(msgs[i].at).getTime()) / 36e5;
      return diffH <= 24;
    }
  }
  return false;
}

// Multi-number support: remember which business phone number (Cloud API
// phone_number_id) a conversation belongs to, so replies from /inbox and
// future auto-replies go out from the same number the customer messaged —
// instead of always defaulting to the main number.
async function setBusinessNumber(phone, businessNumberId) {
  if (!businessNumberId) return;
  if (!supabase) {
    if (!fallback.conversations.has(phone)) fallback.conversations.set(phone, { name: phone });
    fallback.conversations.get(phone).businessNumberId = businessNumberId;
    return;
  }
  await supabase.from('conversations').upsert({
    phone,
    business_number_id: businessNumberId,
    operator_id: OPERATOR_ID,
  }, { onConflict: 'phone' });
}

async function getBusinessNumber(phone) {
  if (!supabase) {
    const c = fallback.conversations.get(phone);
    return c ? c.businessNumberId || null : null;
  }
  const { data, error } = await supabase.from('conversations').select('business_number_id').eq('phone', phone).maybeSingle();
  if (error || !data) return null;
  return data.business_number_id || null;
}

// --- Web push subscriptions ---
async function savePushSubscription(sub) {
  if (!sub || !sub.endpoint) return;
  if (!supabase) { fallback.push.set(sub.endpoint, sub); return; }
  await supabase.from('push_subscriptions').upsert({ endpoint: sub.endpoint, keys: sub.keys || sub }, { onConflict: 'endpoint' });
}
async function removePushSubscription(endpoint) {
  if (!supabase) { fallback.push.delete(endpoint); return; }
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
}
async function getPushSubscriptions() {
  if (!supabase) return Array.from(fallback.push.values());
  const { data, error } = await supabase.from('push_subscriptions').select('endpoint, keys');
  if (error) { console.warn('getPushSubscriptions error:', error.message); return []; }
  return (data || []).map(r => ({ endpoint: r.endpoint, ...r.keys }));
}

// --- Media (photos/docs sent by customers) ---
async function recordMedia(phone, messageId, mediaInfo) {
  if (!supabase) {
    fallback.media.push({ phone, messageId, ...mediaInfo, recordedAt: new Date().toISOString() });
    return;
  }
  await supabase.from('media').insert({
    message_id: messageId,
    phone,
    media_id: mediaInfo.id,
    type: mediaInfo.type,
    mime: mediaInfo.mime,
    size: mediaInfo.size,
    filename: mediaInfo.filename,
  });
}

async function getMediaForMessage(phone, messageId) {
  if (!supabase) {
    return fallback.media.filter(m => m.phone === phone && m.messageId === messageId);
  }
  const { data, error } = await supabase
    .from('media')
    .select('media_id, type, mime, size, filename')
    .eq('phone', phone)
    .eq('message_id', messageId);
  if (error) { console.warn('getMediaForMessage error:', error.message); return []; }
  return (data || []).map(m => ({ messageId, id: m.media_id, type: m.type, mime: m.mime, size: m.size, filename: m.filename }));
}

module.exports = {
  record,
  listConversations,
  getMessages,
  isWindowOpen,
  setBusinessNumber,
  getBusinessNumber,
  savePushSubscription,
  removePushSubscription,
  getPushSubscriptions,
  recordMedia,
  getMediaForMessage,
  OPERATOR_ID,
};
