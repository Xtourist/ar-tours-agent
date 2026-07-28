const express = require('express');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();
const path = require('path');
const inbox = require('./inbox');
const bokun = require('./bokun');
const { sendHandoffAlert } = require('./alert');
const { sendLeadWebhook } = require('./leadWebhook');
const { downloadMedia, getMediaPath } = require('./media');

const app = express();
const PORT = process.env.PORT || 3000;

// Capture the raw request body alongside JSON parsing. The Bokun webhook
// needs the exact raw bytes to verify the HMAC signature — parsed/re-serialized
// JSON can differ byte-for-byte from what Bokun signed, so we stash the raw
// buffer on the request as it comes in.
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const conversationHistory = new Map();
const MAX_HISTORY = 20;

// --- Human handoff state ---
// Map<phoneNumber, { since: timestamp, reason: string }>
const humanHandoff = new Map();
const HANDOFF_DURATION_MS = 12 * 60 * 60 * 1000; // 12 hours before auto-resuming the bot

const HANDOFF_KEYWORDS = [
'agent', 'human', 'representative', 'real person', 'speak to someone',
'speak to a person', 'talk to someone', 'talk to a person', 'manager',
'complaint', 'complain', 'urgent', 'call me', 'refund'
];

const FALLBACK_PHRASE = "that's a great question. i'll have one of our travel specialists confirm the details and get back to you shortly.";

function isHandoffTriggered(messageText) {
const lower = messageText.toLowerCase();
return HANDOFF_KEYWORDS.some(kw => lower.includes(kw));
}

function isInHandoff(phoneNumber) {
const entry = humanHandoff.get(phoneNumber);
if (!entry) return false;
if (Date.now() - entry.since > HANDOFF_DURATION_MS) {
humanHandoff.delete(phoneNumber);
return false;
}
return true;
}

// Build a readable transcript of the last N messages for this phone number,
// so the handoff email/Sheet row includes conversation context instead of
// just the single triggering message.
function buildTranscript(phoneNumber, limit = 20) {
try {
const messages = inbox.getMessages(phoneNumber) || [];
const recent = messages.slice(-limit);
return recent
.map(m => `${m.dir === 'inbound' ? 'Customer' : 'Bot'} (${new Date(m.at).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' })}): ${m.body}`)
.join('\n');
} catch (e) {
console.warn('Could not build transcript for', phoneNumber, e.message);
return '';
}
}

function startHandoff(phoneNumber, reason, context = {}) {
humanHandoff.set(phoneNumber, { since: Date.now(), reason });
console.log(`HANDOFF STARTED for ${phoneNumber} — reason: ${reason}. Bot will pause auto-replies; reply manually from WhatsApp Manager inbox.`);
if (!context.silent) {
const transcript = buildTranscript(phoneNumber);

sendHandoffAlert({
phone: phoneNumber,
name: context.name,
reason,
lastMessage: context.lastMessage || '',
transcript
}).catch(err => console.error('sendHandoffAlert error:', err.message));

// alert.js uses Gmail SMTP, which Render's free tier blocks outbound —
// this webhook path uses plain HTTPS instead (not blocked) and also logs
// the lead to the Google Sheet, so it works without any paid upgrade.
sendLeadWebhook({
phone: phoneNumber,
name: context.name,
reason,
lastMessage: context.lastMessage || '',
transcript
}).catch(err => console.error('sendLeadWebhook error:', err.message));
}
}

// Webhook GET verification
app.get('/webhook', (req, res) => {
const mode = req.query['hub.mode'];
const token = req.query['hub.verify_token'];
const challenge = req.query['hub.challenge'];

if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
console.log('Webhook verified');
res.status(200).send(challenge);
} else {
console.log('Webhook verification failed');
res.sendStatus(403);
}
});

// Webhook POST for incoming messages (WhatsApp Cloud API format)
app.post('/webhook', async (req, res) => {
try {
res.sendStatus(200);

const { entry } = req.body;
if (!entry) return;

for (const e of entry) {
const changes = e.changes;
if (!changes) continue;

for (const change of changes) {
const value = change.value;
if (!value || !value.messages) continue;

const contacts = value.contacts;
// Multi-number support: this is the ID of the business number that
// actually received the message (main +61400044004 or the new
// +61400040243). We route the reply back out through the same number
// instead of always using a single hardcoded env var.
const businessNumberId = value.metadata && value.metadata.phone_number_id
? value.metadata.phone_number_id
: process.env.PHONE_NUMBER_ID;

for (const msg of value.messages) {
const phoneNumber = msg.from;
const userName = contacts && contacts[0] && contacts[0].profile
? contacts[0].profile.name
: 'Guest';
const msgId = msg.id;

// Remember which business number this conversation belongs to, so manual
// replies from /inbox and future auto-replies use the right sender even
// outside this webhook call.
inbox.setBusinessNumber(phoneNumber, businessNumberId);

if (msg.type === 'text') {
const messageText = msg.text.body;
console.log(`Message from ${userName} (${phoneNumber}) via ${businessNumberId}: ${messageText}`);
await handleCustomerMessage(phoneNumber, userName, messageText, businessNumberId);
} else if (['image', 'document', 'audio', 'video', 'file'].includes(msg.type)) {
const media = msg[msg.type];
console.log(`Media from ${userName} (${phoneNumber}) via ${businessNumberId}: type=${msg.type}, id=${media.id}`);
await handleMediaMessage(phoneNumber, userName, msgId, msg.type, media, businessNumberId);
}
}
}
}
} catch (error) {
console.error('Webhook error:', error.message);
}
});

// ===== Bokun booking webhook =====
// Configure this URL in Bokun > Settings > Connections > Webhooks:
//   https://ar-tours-agent.onrender.com/webhook/bokun
// Bokun signs each request with HMAC-SHA1 using your secret key, sent in the
// x-bokun-hmac header. We verify that before trusting the payload.
app.post('/webhook/bokun', async (req, res) => {
try {
const signature = req.headers['x-bokun-hmac'];
const secretKey = process.env.BOKUN_SECRET_KEY;
const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);

if (!bokun.verifySignature(rawBody, signature, secretKey)) {
console.warn('Bokun webhook: signature verification failed, rejecting.');
return res.sendStatus(401);
}

// Ack immediately — process after, same pattern as the WhatsApp webhook.
res.sendStatus(200);

const summary = bokun.recordBooking(req.body);
console.log(`Bokun booking recorded: ${summary.bookingId} — ${summary.tourName} (${summary.status}) for ${summary.customerName} [${summary.phone || 'no phone'}]`);

// If we can match this booking to a WhatsApp number, drop a note into that
// conversation's inbox so it's visible next to the chat — and notify the
// customer on WhatsApp if we recognise their number and their 24h window
// is open (best-effort; never let this fail the webhook response).
if (summary.phone) {
try {
const note = `📅 Bokun booking ${summary.status.toLowerCase().includes('cancel') ? 'cancelled' : 'update'}: ${summary.tourName}${summary.date ? ' on ' + summary.date : ''}${summary.pax ? ' for ' + summary.pax + ' pax' : ''} (${summary.bookingId})`;
inbox.record(summary.phone, summary.customerName, 'inbound', note);
} catch (noteErr) {
console.warn('Could not attach Bokun booking note to inbox:', noteErr.message);
}
} else {
console.log(`Bokun booking ${summary.bookingId} has no matching phone number — visible in booking list only.`);
}
} catch (error) {
console.error('Bokun webhook error:', error.message);
}
});

// View synced Bokun bookings (password-protected, same auth as the inbox)
app.get('/inbox/api/bokun-bookings', inboxAuth, (req, res) => {
res.json(bokun.listBookings());
});
app.get('/inbox/api/conversations/:phone/bokun-bookings', inboxAuth, (req, res) => {
res.json(bokun.getBookingsForPhone(req.params.phone));
});

async function handleMediaMessage(phoneNumber, userName, msgId, mediaType, mediaObj, businessNumberId) {
try {
// Log the media in the inbox
const caption = mediaObj.caption || `[${mediaType.toUpperCase()}]`;
inbox.record(phoneNumber, userName, 'inbound', caption);

// Try to download and cache the media
try {
const mediaInfo = await downloadMedia(mediaObj.id, mediaType, process.env.WHATSAPP_ACCESS_TOKEN);
inbox.recordMedia(phoneNumber, msgId, mediaInfo);
console.log(`Cached ${mediaType} for ${phoneNumber}: ${mediaInfo.filename}`);
} catch (dlErr) {
console.warn(`Could not download ${mediaType} for ${phoneNumber}:`, dlErr.message);
// Still log it in inbox even if download failed
}

// Acknowledge to customer (optional)
if (mediaType === 'image') {
await sendWhatsAppMessage(phoneNumber, '📸 Got your photo! Our team will review and get back to you shortly.', businessNumberId);
} else if (mediaType === 'document') {
await sendWhatsAppMessage(phoneNumber, '📄 Received your document! We will review it and follow up soon.', businessNumberId);
} else {
await sendWhatsAppMessage(phoneNumber, `✓ Received your ${mediaType}. Thanks for sharing!`, businessNumberId);
}
} catch (error) {
console.error('Error handling media:', error.message);
}
}

async function handleCustomerMessage(phoneNumber, userName, messageText, businessNumberId) {
try {
const history = getConversationHistory(phoneNumber);
history.push({ role: 'user', content: messageText });
conversationHistory.set(phoneNumber, history);
inbox.record(phoneNumber, userName, 'inbound', messageText);

// If this conversation is already handed off to a human, stay quiet —
// a staff member is expected to reply manually via WhatsApp Manager's inbox.
if (isInHandoff(phoneNumber)) {
console.log(`Skipping auto-reply for ${phoneNumber} — conversation is in human handoff mode.`);
return;
}

// If the customer explicitly asks for a human, hand off immediately.
if (isHandoffTriggered(messageText)) {
startHandoff(phoneNumber, 'customer requested human', { name: userName, lastMessage: messageText });
const handoffMsg = "No problem! I've passed this on to one of our AR Tours travel specialists, who will follow up with you here shortly. 🙏\n\nIf it's urgent, you can also reach us directly:\n📧 human@theartours.com\n📞 +61 400 044 004";
history.push({ role: 'assistant', content: handoffMsg });
conversationHistory.set(phoneNumber, history);
await sendWhatsAppMessage(phoneNumber, handoffMsg, businessNumberId);
return;
}

const response = await generateAIResponse(history, userName);

history.push({ role: 'assistant', content: response });
conversationHistory.set(phoneNumber, history);

await sendWhatsAppMessage(phoneNumber, response, businessNumberId);

// If the AI itself couldn't answer (used the master-instructions fallback line),
// also hand off so a human follows up rather than the bot repeating itself.
if (response.toLowerCase().includes(FALLBACK_PHRASE)) {
startHandoff(phoneNumber, 'AI could not answer the question', { name: userName, lastMessage: messageText });
}
} catch (error) {
console.error('Error handling message:', error.message);
await sendWhatsAppMessage(phoneNumber, 'Sorry, I had trouble processing that. Please try again.', businessNumberId);
}
}

async function generateAIResponse(history, userName) {
const systemPrompt = buildSystemPrompt(userName);

if (process.env.GROQ_API_KEY) {
try {
return await callGroqAPI(history, systemPrompt);
} catch (error) {
console.warn('Groq failed:', error.message);
}
}

return "Thanks for reaching out to AR Tours! We're experiencing high demand right now. Please try again in a moment, or email support@artours.com.au.";
}

async function callGroqAPI(history, systemPrompt) {
const response = await axios.post(
'https://api.groq.com/openai/v1/chat/completions',
{
model: 'llama-3.1-8b-instant',
messages: [
{ role: 'system', content: systemPrompt },
...history.map(m => ({ role: m.role, content: m.content }))
],
max_tokens: 500,
temperature: 0.7
},
{
headers: {
'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
'Content-Type': 'application/json'
}
}
);

return response.data.choices[0].message.content;
}

function buildSystemPrompt(userName) {
return `You are the official AI assistant for AR Tours (AR Travel Group Pty Ltd), based in Melbourne, Victoria, Australia. Your job is to help customers quickly, professionally and accurately while increasing direct bookings. Be friendly, knowledgeable, honest and efficient. Never guess information — if you don't know something, tell the customer you'll confirm with the AR Tours team.

COMPANY INFORMATION
Business Name: AR Tours (AR Travel Group Pty Ltd)
Website: https://toursau.com
Primary WhatsApp: +61 400 044 004
Email: 888artours@gmail.com
Instagram: @theartours
Base: Melbourne, primarily serving Victoria, with custom tours available anywhere in Australia.

OUR SERVICES
- Melbourne Day Tours
- Private Luxury Tours
- Small Group Tours
- Family Tours
- Corporate Tours
- Airport Transfers
- Cruise Transfers
- Multi-day Tours
- Custom Australia Itineraries
- Hotel Bookings
- Flight Bookings
- Holiday Packages
- Honeymoon Packages
- Group Travel
- Educational Tours
- Corporate Events
- Winery Tours
- Great Ocean Road Tours
- Phillip Island Penguin Tours
- Yarra Valley Tours
- Mornington Peninsula Tours
- Grampians Tours
- Wilsons Promontory Tours
- Mt Buller Snow Tours
- Ballarat & Sovereign Hill Tours
- Custom Tours anywhere in Australia

CUSTOM TOURS
If a customer wants something different, always reply positively, e.g.: "Absolutely! We specialise in customised tours. Please send us: travel dates, number of adults, number of children (ages if applicable), pickup location, destinations you'd like to visit, preferred hotel standard (if required), budget (optional), and any special requests. Our team will prepare a personalised itinerary and quote for you."

HOLIDAY PACKAGES
We also provide complete travel packages including hotels, flights, airport transfers, sightseeing, attractions, tour packages, luxury holidays, and family holidays. If asked "Can you organise everything?" reply: "Yes! We can organise your complete holiday package including accommodation, flights, sightseeing, transport and personalised itineraries."

BOOKING BEHAVIOUR
Always try to collect: name, travel date, number of adults, children, pickup location, preferred tour, and special requests. After collecting details, reply: "Thank you. Our team will prepare the best available options and confirm shortly."

TOURS WE COMMONLY OFFER
Great Ocean Road Reverse Tour, Phillip Island Penguin Parade, Yarra Valley Wine Tour, Mornington Peninsula, Puffing Billy + Phillip Island, Mt Buller Snow, Grampians, Ballarat & Sovereign Hill, Melbourne City Tour, Private Luxury Tours, Airport Transfers, Cruise Transfers, Custom Australia Tours.

PRICING
Never promise prices unless confirmed. If asked, reply: "Our prices depend on the travel date, group size and inclusions. We'll provide the best available quote."

VEHICLES
We operate premium vehicles suitable for small groups, families, private luxury travel, corporate travel, and larger groups (subject to availability). Never promise a specific vehicle model unless confirmed.

CUSTOMER SERVICE STYLE
Always be warm, professional, reply quickly, use simple English, avoid long paragraphs, use emojis sparingly, never argue, never blame customers.

IF CUSTOMER ASKS FOR A DISCOUNT
Reply: "We always try to offer our best possible pricing. Please share your travel details and we'll see what special offers are available."

IF CUSTOMER WANTS SOMETHING NOT LISTED
Reply: "We'd love to help! We can create completely customised itineraries across Australia."

RESPONSE STYLE
Use short WhatsApp-friendly messages. Prefer bullet points. Don't send huge messages unless asked.

UPSELL NATURALLY
Whenever appropriate, mention: Private Luxury Tours, Hotel Bookings, Flights, Holiday Packages, Airport Transfers, Multi-day Tours, Custom Itineraries.

FREQUENTLY ASKED QUESTIONS
Q: Do you only operate in Melbourne? A: "No. While Melbourne is our main base, we can organise tours and holiday packages throughout Australia."
Q: Can we customise our itinerary? A: "Absolutely! Every itinerary can be customised."
Q: Can you arrange hotels? A: "Yes."
Q: Can you book flights? A: "Yes."
Q: Can you organise everything? A: "Yes. We provide complete travel planning including flights, hotels, tours, transfers and personalised itineraries."
Q: Do you provide airport pickup? A: "Yes."
Q: Do you provide child seats? A: "Please let us know the child's age when booking, and we'll advise availability."
Q: Can I pay later? A: "Our team will advise the available payment options during booking."

IF THE AI DOESN'T KNOW
Never make up answers. Instead reply: "That's a great question. I'll have one of our travel specialists confirm the details and get back to you shortly."

LEAD COLLECTION
Whenever someone is interested, politely collect: name, phone number, email (optional), travel date, number of travellers, destination, pickup location.

TONE
Professional, friendly, luxury, helpful, fast, trustworthy.

GOAL
Every conversation should aim to: 1) answer the customer's questions, 2) collect booking details, 3) recommend suitable tours or packages, 4) upsell hotels, flights, airport transfers or private tours where appropriate, 5) encourage direct booking with AR Tours, 6) hand over to a human team member whenever needed.

Always end conversations with: "Thank you for choosing AR Tours! We look forward to helping you create an unforgettable Australian travel experience."

Keep individual replies concise and WhatsApp-friendly (short paragraphs / bullet points, generally under 200 words unless the customer needs detailed info).
Customer name: ${userName}`;
}

function getConversationHistory(phoneNumber) {
if (!conversationHistory.has(phoneNumber)) {
conversationHistory.set(phoneNumber, []);
}
let history = conversationHistory.get(phoneNumber);
if (history.length > MAX_HISTORY) {
history = history.slice(-MAX_HISTORY);
conversationHistory.set(phoneNumber, history);
}
return history;
}

// fromNumberId lets us send from whichever business number (+61400044004 or
// the new +61400040243) actually owns this conversation. Falls back to the
// main number's env var if none is known yet (e.g. very first outbound send
// before any inbound message has been recorded for this phone).
async function sendWhatsAppMessage(phoneNumber, messageText, fromNumberId) {
const senderId = fromNumberId || inbox.getBusinessNumber(phoneNumber) || process.env.PHONE_NUMBER_ID;
try {
await axios.post(
`https://graph.facebook.com/v18.0/${senderId}/messages`,
{
messaging_product: 'whatsapp',
to: phoneNumber,
type: 'text',
text: { body: messageText }
},
{
headers: {
'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
'Content-Type': 'application/json'
}
}
);
console.log(`Sent to ${phoneNumber} from ${senderId}`);
inbox.record(phoneNumber, null, 'outbound', messageText);
} catch (error) {
console.error('Error sending message:', error.response ? JSON.stringify(error.response.data) : error.message);
}
}

// Send a Meta-approved template message to start a NEW conversation (cold
// outreach). WhatsApp only allows free-text replies within 24h of the
// customer messaging first — to message someone who hasn't messaged you,
// the first message must use an approved template, submitted and approved
// in Meta's WhatsApp Manager beforehand.
//
// bodyParams is an ordered array of strings filling the template's {{1}},
// {{2}}, etc. placeholders, in order.
async function sendWhatsAppTemplate(phoneNumber, templateName, languageCode, bodyParams = [], fromNumberId) {
const senderId = fromNumberId || process.env.PHONE_NUMBER_ID;
const components = bodyParams.length
? [{ type: 'body', parameters: bodyParams.map(p => ({ type: 'text', text: String(p) })) }]
: [];
await axios.post(
`https://graph.facebook.com/v18.0/${senderId}/messages`,
{
messaging_product: 'whatsapp',
to: phoneNumber,
type: 'template',
template: {
name: templateName,
language: { code: languageCode || 'en' },
components
}
},
{
headers: {
'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
'Content-Type': 'application/json'
}
}
);
console.log(`Template "${templateName}" sent to ${phoneNumber} from ${senderId}`);
// Record a readable version in the inbox so it shows in the chat history
// like any other outbound message.
const readable = bodyParams.length ? `[Template: ${templateName}] ${bodyParams.join(' / ')}` : `[Template: ${templateName}]`;
inbox.record(phoneNumber, null, 'outbound', readable);
}

// Start a new conversation with a phone number that hasn't messaged us yet.
// Usage from the inbox "New message" button.
app.post('/inbox/api/send-template', inboxAuth, async (req, res) => {
const { phone, name, template, language, params, from } = req.body;
if (!phone || !template) return res.status(400).json({ error: 'phone and template are required' });
try {
// "from" lets the New Message modal choose which business number to send
// from (main +61400044004 or +61400040243). Defaults to the main number.
const fromNumberId = from === 'second' ? process.env.SECOND_PHONE_NUMBER_ID : process.env.PHONE_NUMBER_ID;
if (from === 'second' && !fromNumberId) {
return res.status(400).json({ error: 'not_configured', message: 'SECOND_PHONE_NUMBER_ID is not set on the server yet.' });
}
await sendWhatsAppTemplate(phone, template, language, Array.isArray(params) ? params : [], fromNumberId);
if (from === 'second') inbox.setBusinessNumber(phone, fromNumberId);
if (name) inbox.record(phone, name, 'outbound', `[Template: ${template}]`);
res.json({ ok: true });
} catch (error) {
const details = error.response ? error.response.data : { message: error.message };
console.error('Template send error:', JSON.stringify(details));
res.status(502).json({ error: 'send_failed', message: details.error ? details.error.message : 'Could not send template. Check the template name is approved in Meta WhatsApp Manager.', details });
}
});

// One-time admin action: register a phone number with the Cloud API (needed
// once per new number before it can send/receive — separate from adding it
// in WhatsApp Manager). Protected by REGISTER_ADMIN_SECRET (set this env var
// to any value you choose before calling). Usage:
//   POST /admin/register-number { phoneNumberId, pin, secret }
app.post('/admin/register-number', async (req, res) => {
if (!process.env.REGISTER_ADMIN_SECRET || req.body.secret !== process.env.REGISTER_ADMIN_SECRET) {
return res.sendStatus(403);
}
const { phoneNumberId, pin } = req.body;
if (!phoneNumberId || !pin) return res.status(400).json({ error: 'phoneNumberId and pin are required' });
try {
const result = await axios.post(
`https://graph.facebook.com/v18.0/${phoneNumberId}/register`,
{ messaging_product: 'whatsapp', pin: String(pin) },
{ headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
);
res.json({ ok: true, result: result.data });
} catch (error) {
const details = error.response ? error.response.data : { message: error.message };
console.error('Register number error:', JSON.stringify(details));
res.status(502).json({ error: 'register_failed', details });
}
});

app.get('/inbox/api/media/:mediaId', inboxAuth, (req, res) => {
try {
const path = getMediaPath(req.params.mediaId);
if (!fs.existsSync(path)) {
return res.status(404).json({ error: 'Media not found' });
}
const mime = require('./media').getMediaMime(req.params.mediaId);
res.type(mime);
res.sendFile(path);
} catch (error) {
res.status(500).json({ error: error.message });
}
});

app.get('/health', (req, res) => {
res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Admin: view / release human handoffs ---
// Usage: GET /admin/handoffs?secret=YOUR_WEBHOOK_SECRET
app.get('/admin/handoffs', (req, res) => {
if (req.query.secret !== process.env.WEBHOOK_SECRET) return res.sendStatus(403);
const list = Array.from(humanHandoff.entries()).map(([phone, info]) => ({
phone,
since: new Date(info.since).toISOString(),
reason: info.reason
}));
res.json({ activeHandoffs: list });
});

// Usage: POST /admin/handoffs/release { "phone": "614xxxxxxxx", "secret": "YOUR_WEBHOOK_SECRET" }
app.post('/admin/handoffs/release', (req, res) => {
if (req.body.secret !== process.env.WEBHOOK_SECRET) return res.sendStatus(403);
const { phone } = req.body;
if (!phone) return res.status(400).json({ error: 'phone is required' });
humanHandoff.delete(phone);
console.log(`Handoff manually released for ${phone} — bot will resume auto-replies.`);
res.json({ released: phone });
});

// ===== INBOX: password-protected web UI to view/reply to customer chats =====
// Cookie-based session so the browser stays logged in (Basic Auth prompts
// again every time the browser/tab is closed, which is what made this
// annoying). Session token is a simple HMAC of user+expiry, verified with
// INBOX_PASS as the signing secret, valid for 30 days.
const crypto = require('crypto');
const SESSION_COOKIE = 'ar_inbox_session';
const SESSION_DAYS = 30;

function makeSessionToken(user) {
const pass = process.env.INBOX_PASS || '';
const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
const payload = `${user}.${expires}`;
const sig = crypto.createHmac('sha256', pass).update(payload).digest('hex');
return `${payload}.${sig}`;
}

function verifySessionToken(token) {
if (!token) return false;
const pass = process.env.INBOX_PASS || '';
const parts = token.split('.');
if (parts.length !== 3) return false;
const [user, expires, sig] = parts;
const payload = `${user}.${expires}`;
const expected = crypto.createHmac('sha256', pass).update(payload).digest('hex');
if (sig.length !== expected.length) return false;
if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
if (Date.now() > Number(expires)) return false;
return true;
}

function parseCookies(req) {
const header = req.headers.cookie || '';
const out = {};
header.split(';').forEach(pair => {
const idx = pair.indexOf('=');
if (idx === -1) return;
const k = pair.slice(0, idx).trim();
const v = pair.slice(idx + 1).trim();
if (k) out[k] = decodeURIComponent(v);
});
return out;
}

function inboxAuth(req, res, next) {
const user = process.env.INBOX_USER || 'artours';
const pass = process.env.INBOX_PASS;
if (!pass) { return res.status(500).send('INBOX_PASS not set on server'); }

// 1. Valid session cookie? Let them through, no re-login needed.
const cookies = parseCookies(req);
if (verifySessionToken(cookies[SESSION_COOKIE])) return next();

// 2. Fall back to Basic Auth (still works, e.g. for API/curl use), and on
// success set the session cookie so the browser won't be asked again.
const hdr = req.headers.authorization || '';
const b64 = hdr.split(' ')[1] || '';
const [u, p] = Buffer.from(b64, 'base64').toString().split(':');
if (u === user && p === pass) {
res.set('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(makeSessionToken(user))}; Max-Age=${SESSION_DAYS * 24 * 60 * 60}; HttpOnly; SameSite=Lax; Path=/`);
return next();
}
res.set('WWW-Authenticate', 'Basic realm="AR Tours Inbox"');
return res.status(401).send('Authentication required');
}

app.get('/inbox', inboxAuth, (req, res) => {
res.sendFile(path.join(__dirname, 'inbox.html'));
});
app.get('/inbox/api/conversations', inboxAuth, (req, res) => {
const list = inbox.listConversations();
// Attach needsHuman flag + latest matched Bokun booking (tour/date/pax) so
// the mobile inbox can show a tour tag on each row and sort handed-off /
// unanswered chats to the top, without a round trip per conversation.
const withStatus = list.map(c => {
const bookings = bokun.getBookingsForPhone(c.phone);
const latest = bookings && bookings[0];
return {
...c,
needsHuman: isInHandoff(c.phone),
tour: latest ? { tourName: latest.tourName, date: latest.date, pax: latest.pax, status: latest.status } : null
};
});
res.json(withStatus);
});
// Lightweight endpoint just for handoff status (used to refresh needsHuman
// flags on poll without re-fetching full conversation list every time).
app.get('/inbox/api/handoff-status', inboxAuth, (req, res) => {
const list = Array.from(humanHandoff.keys());
res.json({ phones: list });
});
app.get('/inbox/api/conversations/:phone/messages', inboxAuth, (req, res) => {
res.json(inbox.getMessages(req.params.phone));
});
app.get('/inbox/api/conversations/:phone/window', inboxAuth, (req, res) => {
res.json({ open: inbox.isWindowOpen(req.params.phone) });
});
app.post('/inbox/api/conversations/:phone/reply', inboxAuth, async (req, res) => {
const { phone } = req.params;
const { body } = req.body;
if (!body || !body.trim()) return res.status(400).json({ error: 'empty' });
if (!inbox.isWindowOpen(phone)) {
return res.status(409).json({ error: 'window_closed', message: 'This customer has not messaged in the last 24 hours, so WhatsApp blocks free-text replies. You would need an approved template message instead.' });
}
// Sending manually implies a human is handling this chat: pause the bot for them.
try { startHandoff(phone, 'human replied from inbox', { silent: true }); } catch (e) {}
await sendWhatsAppMessage(phone, body);
res.json({ ok: true });
});

app.listen(PORT, () => {
console.log(`AR Tours WhatsApp agent running on port ${PORT}`);
});
