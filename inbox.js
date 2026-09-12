// inbox.js - conversation store + web inbox for AR Tours.
//
// Fix (2026-08-07): this used to store everything in a JSON file on local
// disk (and media metadata in an in-memory Map), which lives on Render's
// free-tier ephemeral filesystem/process memory and gets wiped on every
// restart, redeploy, or free-tier spin-down. That caused chat history, read
// status, and photo records to silently disappear. Everything now lives in
// a Supabase Postgres database instead — real permanent storage that
// survives restarts, deploys, and sleep cycles.

require('dotenv').config();
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
const fallback = { conversations: new Map(), messages: [], push: new Map(), media: [], aiHistory: new Map(), handoffs: new Map() };

async function record(phone, name, direction, body, messageId = null) {
  const at = new Date().toISOString();
  if (!supabase) {
    if (!fallback.conversations.has(phone)) fallback.conversations.set(phone, { name: name || phone });
    // Only update name if a valid non-empty real name is provided
    if (name && name !== phone) fallback.conversations.get(phone).name = name;
    fallback.conversations.get(phone).lastAt = at;
    fallback.messages.push({ phone, dir: direction, body: body || '', at, message_id: messageId });
    return;
  }

  // 1. Fetch existing conversation to avoid overwriting name with null/phone
  const { data: existing } = await supabase
    .from('conversations')
    .select('name')
    .eq('phone', phone)
    .maybeSingle();

  let finalName = existing?.name;
  if (name && name !== phone) {
    finalName = name;
  } else if (!finalName) {
    finalName = phone;
  }

  await supabase.from('conversations').upsert({
    phone,
    name: finalName,
    last_at: at,
    operator_id: OPERATOR_ID,
  }, { onConflict: 'phone' });

  const msgPayload = { phone, dir: direction, body: body || '', at };
  if (messageId) msgPayload.message_id = messageId;
  await supabase.from('messages').insert(msgPayload);
}

async function listConversations() {
  if (!supabase) {
    return Array.from(fallback.conversations.entries()).map(([phone, c]) => {
      const clean = String(phone || '').replace(/[^0-9]/g, '');
      const phones = Array.from(new Set([phone, clean, '+' + clean].filter(Boolean)));
      const msgs = fallback.messages.filter(m => phones.includes(m.phone));
      const lastMsg = msgs.length ? msgs[msgs.length - 1] : null;
      const preview = lastMsg ? (lastMsg.dir === 'outbound' ? `You: ${lastMsg.body}` : lastMsg.body) : '';
      return { phone, name: c.name, lastAt: c.lastAt, preview, lastDir: lastMsg?.dir || null, businessNumberId: c.businessNumberId || null };
    }).sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
  }
  const { data: convos, error } = await supabase
    .from('conversations')
    .select('phone, name, last_at, business_number_id')
    .order('last_at', { ascending: false });
  if (error) { console.warn('listConversations error:', error.message); return []; }

  // Pull the latest message per phone for the preview text in parallel
  const results = await Promise.all((convos || []).map(async (c) => {
    const clean = String(c.phone || '').replace(/[^0-9]/g, '');
    const phones = Array.from(new Set([c.phone, clean, '+' + clean].filter(Boolean)));
    const { data: last } = await supabase
      .from('messages')
      .select('body, dir')
      .in('phone', phones)
      .order('at', { ascending: false })
      .limit(1);
    const lastMsg = last && last[0];
    const preview = lastMsg ? (lastMsg.dir === 'outbound' ? `You: ${lastMsg.body}` : lastMsg.body) : '';
    return {
      phone: c.phone,
      name: c.name,
      lastAt: c.last_at,
      preview,
      lastDir: lastMsg?.dir || null,
      businessNumberId: c.business_number_id || null,
    };
  }));
  return results;
}

async function getMessages(phone) {
  const clean = String(phone || '').replace(/[^0-9]/g, '');
  const phones = Array.from(new Set([phone, clean, '+' + clean].filter(Boolean)));

  if (!supabase) {
    return fallback.messages.filter(m => phones.includes(m.phone)).map(m => {
      const mediaList = fallback.media.filter(med => phones.includes(med.phone) && med.messageId && med.messageId === m.message_id);
      return { dir: m.dir, body: m.body, at: m.at, media: mediaList.map(med => ({ id: med.id, type: med.type, mime: med.mime, size: med.size, filename: med.filename })) };
    });
  }
  const { data: msgs, error } = await supabase
    .from('messages')
    .select('dir, body, at, message_id')
    .in('phone', phones)
    .order('at', { ascending: true })
    .limit(500);
  if (error) { console.warn('getMessages error:', error.message); return []; }

  // Query media items associated with these phone variants
  const { data: mediaItems } = await supabase
    .from('media')
    .select('message_id, media_id, type, mime, size, filename')
    .in('phone', phones);

  const mediaMap = new Map();
  (mediaItems || []).forEach(item => {
    if (item.message_id) {
      if (!mediaMap.has(item.message_id)) mediaMap.set(item.message_id, []);
      mediaMap.get(item.message_id).push({
        id: item.media_id,
        type: item.type,
        mime: item.mime,
        size: item.size,
        filename: item.filename
      });
    }
  });

  return (msgs || []).map(m => ({
    dir: m.dir,
    body: m.body,
    at: m.at,
    media: m.message_id && mediaMap.has(m.message_id) ? mediaMap.get(m.message_id) : []
  }));
}

// 24h window: open if the customer sent an inbound message within the last 24h
// Note: only genuine 'inbound' messages count. System/automated events do not.
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

// Multi-number support
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
  // WebPush expects: { endpoint: string, keys: { p256dh: string, auth: string } }
  return (data || []).map(r => ({
    endpoint: r.endpoint,
    keys: r.keys && r.keys.p256dh ? r.keys : (r.keys?.keys || r.keys)
  }));
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

// --- Persistent AI Conversation History ---
async function loadAIHistory(phone) {
  if (!supabase) return fallback.aiHistory.get(phone) || [];
  try {
    const { data } = await supabase.from('ai_history').select('history').eq('phone', phone).maybeSingle();
    return (data && Array.isArray(data.history)) ? data.history : [];
  } catch (err) {
    console.warn('loadAIHistory failed:', err.message);
    return [];
  }
}

async function saveAIHistory(phone, history) {
  if (!supabase) {
    fallback.aiHistory.set(phone, history);
    return;
  }
  try {
    await supabase.from('ai_history').upsert({
      phone,
      history,
      updated_at: new Date().toISOString()
    }, { onConflict: 'phone' });
  } catch (err) {
    console.warn('saveAIHistory failed:', err.message);
  }
}

// --- Persistent Human Handoff State ---
async function loadHandoffs() {
  if (!supabase) {
    return Array.from(fallback.handoffs.entries()).map(([phone, info]) => ({ phone, ...info }));
  }
  try {
    const { data } = await supabase.from('handoffs').select('phone, reason, started_at');
    return (data || []).map(row => ({
      phone: row.phone,
      reason: row.reason,
      since: new Date(row.started_at).getTime()
    }));
  } catch (err) {
    console.warn('loadHandoffs failed:', err.message);
    return [];
  }
}

async function saveHandoff(phone, reason) {
  if (!supabase) {
    fallback.handoffs.set(phone, { reason, since: Date.now() });
    return;
  }
  try {
    await supabase.from('handoffs').upsert({
      phone,
      reason,
      started_at: new Date().toISOString()
    }, { onConflict: 'phone' });
  } catch (err) {
    console.warn('saveHandoff failed:', err.message);
  }
}

async function removeHandoff(phone) {
  if (!supabase) {
    fallback.handoffs.delete(phone);
    return;
  }
  try {
    await supabase.from('handoffs').delete().eq('phone', phone);
  } catch (err) {
    console.warn('removeHandoff failed:', err.message);
  }
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
  loadAIHistory,
  saveAIHistory,
  loadHandoffs,
  saveHandoff,
  removeHandoff,
  OPERATOR_ID,
};
