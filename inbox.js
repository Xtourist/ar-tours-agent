// inbox.js - lightweight conversation store + web inbox for AR Tours.
// Stores messages in a JSON file so history survives restarts (attach a Render
// Disk and set INBOX_DATA_PATH to a path on it to persist across deploys).

const fs = require('fs');
const path = require('path');

const DATA_PATH = process.env.INBOX_DATA_PATH || path.join(__dirname, 'inbox-data.json');

let store = { conversations: {} }; // { [phone]: { name, lastAt, messages: [{dir, body, at}] } }

function load() {
  try {
    if (fs.existsSync(DATA_PATH)) {
      store = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
      if (!store.conversations) store.conversations = {};
    }
  } catch (e) {
    console.warn('Inbox: could not load data file, starting fresh:', e.message);
    store = { conversations: {} };
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
    store.conversations[phone] = { name: name || phone, lastAt: null, messages: [] };
  }
  const convo = store.conversations[phone];
  if (name) convo.name = name;
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

load();

module.exports = { record, listConversations, getMessages, isWindowOpen };

// Media storage: keep track of downloaded media files mapped to messages
const mediaStore = new Map();

function recordMedia(phone, messageId, mediaInfo) {
  if (!mediaStore.has(phone)) mediaStore.set(phone, []);
  mediaStore.get(phone).push({ messageId, ...mediaInfo, recordedAt: new Date().toISOString() });
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
