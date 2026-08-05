// inbox.js - lightweight conversation store + web inbox for AR Tours.
// Stores messages in a JSON file so history survives restarts (attach a Render
// Disk and set INBOX_DATA_PATH to a path on it to persist across deploys).

const fs = require('fs');
const path = require('path');

const DATA_PATH = process.env.INBOX_DATA_PATH || path.join(__dirname, 'inbox-data.json');

// operator_id groundwork: we're single-tenant today (just AR Tours), but every
// conversation record gets tagged with this now so a future second operator
// doesn't require a data migration. Cheap to do now (a field on write),
// expensive to retrofit later. Deliberately NOT filtering reads by this yet --
// that would be unnecessary work while there's only one operator.
const OPERATOR_ID = process.env.OPERATOR_ID || 'ar_tours';

let store = { conversations: {}, pushSubscriptions: [] }; // { [phone]: { name, lastAt, operatorId, businessNumberId, messages: [{dir, body, at}] } }, pushSubscriptions: [{endpoint, keys}]

function load() {
try {
if (fs.existsSync(DATA_PATH)) {
store = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
if (!store.conversations) store.conversations = {};
if (!store.pushSubscriptions) store.pushSubscriptions = [];
}
} catch (e) {
console.warn('Inbox: could not load data file, starting fresh:', e.message);
store = { conversations: {}, pushSubscriptions: [] };
}
}

let saveTimer = null;
function save() {
// debounce writes so rapid messages don't hammer the disk
if (saveTimer) return;
saveTimer = setTimeout(() => {
saveTimer = null;
try {
fs.writeFileSync(DATA_PATH, JSON.stringify(store));
} catch (e) {
console.warn('Inbox: could not save data file:', e.message);
}
}, 500);
}

function record(phone, name, direction, body) {
if (!store.conversations[phone]) {
store.conversations[phone] = { name: name || phone, lastAt: null, operatorId: OPERATOR_ID, messages: [] };
}
const convo = store.conversations[phone];
if (name) convo.name = name;
if (!convo.operatorId) convo.operatorId = OPERATOR_ID;
const at = new Date().toISOString();
convo.messages.push({ dir: direction, body: body || '', at });
convo.lastAt = at;
// keep memory reasonable
if (convo.messages.length > 500) convo.messages = convo.messages.slice(-500);
save();
}

function listConversations() {
return Object.entries(store.conversations)
.map(([phone, c]) => ({
phone,
name: c.name,
lastAt: c.lastAt,
preview: c.messages.length ? c.messages[c.messages.length - 1].body : '',
businessNumberId: c.businessNumberId || null,
}))
.sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
}

function getMessages(phone) {
return store.conversations[phone] ? store.conversations[phone].messages : [];
}

// 24h window: open if the customer sent an inbound message within the last 24h
function isWindowOpen(phone) {
const c = store.conversations[phone];
if (!c) return false;
for (let i = c.messages.length - 1; i >= 0; i--) {
if (c.messages[i].dir === 'inbound') {
const diffH = (Date.now() - new Date(c.messages[i].at).getTime()) / 36e5;
return diffH <= 24;
}
}
return false;
}

// Multi-number support: remember which business phone number (Cloud API
// phone_number_id) a conversation belongs to, so replies from /inbox and
// future auto-replies go out from the same number the customer messaged —
// instead of always defaulting to the main number.
function setBusinessNumber(phone, businessNumberId) {
if (!businessNumberId) return;
if (!store.conversations[phone]) {
store.conversations[phone] = { name: phone, lastAt: null, operatorId: OPERATOR_ID, messages: [] };
}
store.conversations[phone].businessNumberId = businessNumberId;
save();
}

function getBusinessNumber(phone) {
const c = store.conversations[phone];
return c ? c.businessNumberId || null : null;
}

// --- Human handoff clear (the "Mark as handled" button in /inbox) ---
// Separate from unread/read status — this is about whether the bot has
// paused itself for a conversation, not whether you've viewed the chat.
// whatsapp_agent.js manages the actual in-memory handoff Map; this just
// gives the UI a way to signal "I've dealt with this" without needing the
// raw /admin/handoffs/release endpoint.

// --- Web push subscriptions ---
// Stored so a notification can be sent from any process (webhook handler)
// without needing a live browser connection. Keyed by endpoint since that's
// unique per browser/device subscription.
function savePushSubscription(sub) {
if (!sub || !sub.endpoint) return;
const exists = store.pushSubscriptions.find(s => s.endpoint === sub.endpoint);
if (!exists) store.pushSubscriptions.push(sub);
save();
}
function removePushSubscription(endpoint) {
store.pushSubscriptions = store.pushSubscriptions.filter(s => s.endpoint !== endpoint);
save();
}
function getPushSubscriptions() {
return store.pushSubscriptions || [];
}

load();

module.exports = { record, listConversations, getMessages, isWindowOpen, setBusinessNumber, getBusinessNumber, savePushSubscription, removePushSubscription, getPushSubscriptions, OPERATOR_ID };

// Media storage: keep track of downloaded media files mapped to messages
const mediaStore = new Map();

function recordMedia(phone, messageId, mediaInfo) {
if (!mediaStore.has(phone)) mediaStore.set(phone, []);
mediaStore.get(phone).push({ messageId, ...mediaInfo, operatorId: OPERATOR_ID, recordedAt: new Date().toISOString() });
// Keep only last 100 media per conversation to limit memory
const convos = mediaStore.get(phone);
if (convos.length > 100) convos.shift();
}

function getMediaForMessage(phone, messageId) {
const media = mediaStore.get(phone) || [];
return media.filter(m => m.messageId === messageId);
}

// Export media functions
module.exports.recordMedia = recordMedia;
module.exports.getMediaForMessage = getMediaForMessage;
