const express = require('express');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();
const path = require('path');
const inbox = require('./inbox');
const bokun = require('./bokun');
const { sendHandoffAlert } = require('./alert');
const { sendLeadWebhook } = require('./leadWebhook');
const { downloadMedia, streamMediaTo } = require('./media');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Web push (PWA notifications) ---
// VAPID keys identify this server to push services (Google/Mozilla/etc) —
// they're not secret in the way an API key is (the public key is sent to
// every browser that subscribes), but keep them stable across deploys via
// env vars so existing subscriptions don't silently break.
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || 'BKbnoS5FxJfc2kyKqfAU6cCRnvio4rQuM3I3msM4fL9J8_Ozurw9BxmBpS3PQlZNNhORtUdFdtI4x3PTH09oi-s';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || 'yTIJ-qFQvOL40tFOKv_vwB3VUfcOvCgV1ShUmBScbXE';
webpush.setVapidDetails('mailto:human@theartours.com', VAPID_PUBLIC, VAPID_PRIVATE);

async function notifyPush(title, body, phone) {
  const subs = await inbox.getPushSubscriptions();
  if (!subs.length) return;
  const payload = JSON.stringify({ title, body, phone });
  await Promise.all(subs.map(sub =>
    webpush.sendNotification(sub, payload).catch(async (err) => {
      // 410/404 = subscription expired or the user uninstalled/unsubscribed
      if (err.statusCode === 410 || err.statusCode === 404) {
        await inbox.removePushSubscription(sub.endpoint);
      } else {
        console.warn('Push send failed:', err.message);
      }
    })
  ));
}

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

// Safety net: if a customer pastes something that looks like a card number,
// catch it in code (not just in the AI prompt) so we never store, log, or
// email it in plain text, and never let the bot's reply echo it back. This
// matches groups of 13-19 digits (with optional spaces/dashes), which covers
// standard Visa/Mastercard/Amex lengths, plus a basic Luhn check to avoid
// false-positives on things like long booking reference numbers.
function luhnValid(digits) {
let sum = 0, alt = false;
for (let i = digits.length - 1; i >= 0; i--) {
let n = parseInt(digits[i], 10);
if (alt) { n *= 2; if (n > 9) n -= 9; }
sum += n; alt = !alt;
}
return sum % 10 === 0;
}
function containsCardNumber(text) {
const matches = text.match(/\b(?:\d[ -]?){13,19}\b/g) || [];
return matches.some(m => {
const digits = m.replace(/[ -]/g, '');
return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
});
}
function redactCardNumbers(text) {
return text.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
const digits = m.replace(/[ -]/g, '');
return (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) ? '[CARD NUMBER REMOVED]' : m;
});
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
async function buildTranscript(phoneNumber, limit = 20) {
try {
const messages = (await inbox.getMessages(phoneNumber)) || [];
const recent = messages.slice(-limit);
return recent
.map(m => `${m.dir === 'inbound' ? 'Customer' : 'Bot'} (${new Date(m.at).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' })}): ${m.body}`)
.join('\n');
} catch (e) {
console.warn('Could not build transcript for', phoneNumber, e.message);
return '';
}
}

async function startHandoff(phoneNumber, reason, context = {}) {
humanHandoff.set(phoneNumber, { since: Date.now(), reason });
console.log(`HANDOFF STARTED for ${phoneNumber} — reason: ${reason}. Bot will pause auto-replies; reply manually from WhatsApp Manager inbox.`);
if (!context.silent) {
const transcript = await buildTranscript(phoneNumber);

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
await inbox.setBusinessNumber(phoneNumber, businessNumberId);

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
await inbox.record(summary.phone, summary.customerName, 'inbound', note);
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
await inbox.record(phoneNumber, userName, 'inbound', caption);
notifyPush(userName || phoneNumber, `Sent a ${mediaType}${caption && caption !== `[${mediaType.toUpperCase()}]` ? ': ' + caption : ''}`, phoneNumber).catch(() => {});

// Try to download and cache the media
try {
const mediaInfo = await downloadMedia(mediaObj.id, mediaType, process.env.WHATSAPP_ACCESS_TOKEN);
await inbox.recordMedia(phoneNumber, msgId, mediaInfo);
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
// Safety net: if this message contains what looks like a real card number,
// redact it before it ever touches history, the inbox log, or a handoff
// email — never let a card number sit anywhere in plain text. This runs
// before anything else, including the normal handoff-in-progress check,
// so it always gets caught.
const hasCard = containsCardNumber(messageText);
const safeText = hasCard ? redactCardNumbers(messageText) : messageText;

const history = getConversationHistory(phoneNumber);
history.push({ role: 'user', content: safeText });
conversationHistory.set(phoneNumber, history);
await inbox.record(phoneNumber, userName, 'inbound', safeText);
notifyPush(userName || phoneNumber, safeText.slice(0, 120), phoneNumber).catch(() => {});

if (hasCard) {
console.warn(`Card number detected and redacted from message by ${phoneNumber} — never storing or emailing it.`);
startHandoff(phoneNumber, 'customer sent payment/card details (redacted)', { name: userName, lastMessage: safeText }).catch(() => {});
const cardMsg = "For your security, we never take card or payment details over WhatsApp — I haven't stored what you sent. 🙏 Our team will send you a secure payment link directly once your booking is confirmed. I've flagged this chat for a team member to follow up shortly.";
history.push({ role: 'assistant', content: cardMsg });
conversationHistory.set(phoneNumber, history);
await sendWhatsAppMessage(phoneNumber, cardMsg, businessNumberId);
return;
}

// If this conversation is already handed off to a human, stay quiet —
// a staff member is expected to reply manually via WhatsApp Manager's inbox.
if (isInHandoff(phoneNumber)) {
console.log(`Skipping auto-reply for ${phoneNumber} — conversation is in human handoff mode.`);
return;
}

// If the customer explicitly asks for a human, hand off immediately.
if (isHandoffTriggered(messageText)) {
startHandoff(phoneNumber, 'customer requested human', { name: userName, lastMessage: messageText }).catch(() => {});
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
startHandoff(phoneNumber, 'AI could not answer the question', { name: userName, lastMessage: messageText }).catch(() => {});
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
return `You are the official AI assistant for AR Tours (AR Travel Group Pty Ltd), based in Melbourne, Victoria, Australia. Your job is to help customers quickly and professionally, gather everything the AR Tours team needs to prepare a quote, and hand the details over by email. Be friendly, knowledgeable, honest and efficient. Never guess information — if you don't know something, tell the customer you'll confirm with the AR Tours team.

═══════════════════════════════════════
ABSOLUTE RULES — NEVER BREAK THESE
═══════════════════════════════════════

1. NEVER discuss, confirm, or ask for payment of any kind. Never ask for or accept credit card, debit card, bank details, or any payment information, under any circumstances — even if the customer offers them or asks how to pay. If a customer sends card details or payment info, do not acknowledge or repeat any part of it back to them. Reply only: "For your security we never take payment details over WhatsApp. Our team will send you a secure payment link directly once your booking is confirmed." Then continue collecting their trip details as normal.

2. NEVER quote an exact price, discount, or final total — for any tour, on any date, including "busy" or public holiday dates. This applies even if the customer insists, asks to "just confirm the number", or asks for an upgrade price. Instead:
   - You may mention that prices vary depending on date, group size, and season, and that public holidays / peak dates (e.g. Christmas, New Year, school holidays) usually cost more than regular days.
   - If a customer pushes for a number, give only a broad, non-committal range using the word "roughly" or "approximately" and always lean toward the higher end so nobody is under-quoted (e.g. "Roughly in the $XX–$XX region depending on the date and group size" — only use ranges you've been explicitly given by the AR Tours team; if you have no reliable range for that tour, don't invent one).
   - Always follow up with: "For the exact price and to check real-time availability for your date, our team will confirm by email within 24 hours."

3. NEVER promise or confirm a booking, availability, or that a date is "locked in". Only the human team can confirm bookings after checking real-time availability.

4. For CUSTOM or time-constrained itineraries: acknowledge what's possible in general terms, mention relevant tour options, and say the team will tailor the itinerary and timing to their schedule — but do not attempt to finalise or price the custom plan yourself.

5. Whenever a customer shows real booking interest (asking about a specific tour, date, upgrade, cruise pickup, or anything price-related), your job is to collect these details conversationally (don't demand them all in one message — ask naturally, 1-2 things at a time) and then hand off:
   - Full name
   - Phone number (if different from their WhatsApp number)
   - Email address
   - Number of travellers (adults / children with ages if relevant)
   - Tour(s) or itinerary they're interested in
   - Preferred date(s)
   - Pickup location (this is essential for cruise transfers — always ask specifically "Which cruise terminal / ship are you departing from, and what time does it dock or leave?" for any cruise-related enquiry)
   - Preferred start/pickup time
   - Any special requests

   Once you have enough of these details to be useful, tell the customer clearly: "Thanks [name]! I've passed all of this on to our AR Tours team. They'll check availability and send you a proper quote by email within 24 hours." Then actually collect and mention their email address if you don't have it yet, since the quote goes there.

6. Always let the customer know, early and naturally (not as a wall of legal text), that they're chatting with an automated assistant, and that they can reach a real person any time: "By the way, I'm an automated assistant. If you'd like to speak to a real person directly, just type 'human' any time, or reach us at 📧 human@theartours.com / 📞 +61 400 044 004."

7. If a customer explicitly asks for a price, a card payment, or to "just book it now", and you've already explained you can't do that, do not repeat the same refusal robotically — acknowledge their urgency warmly, and reassure them the team responds fast (within 24 hours, often sooner) and can call them directly if it's time-sensitive.
═══════════════════════════════════════

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
If a customer wants something different, acknowledge it warmly and collect: travel dates, number of adults, number of children (ages if applicable), pickup location, destinations they'd like to visit, preferred hotel standard (if required), and any special requests. Reassure them the itinerary and timing will be built around their schedule. Do not price it yourself — say: "Our team will put together a personalised itinerary and quote for you by email within 24 hours."

HOLIDAY PACKAGES
We also provide complete travel packages including hotels, flights, airport transfers, sightseeing, attractions, tour packages, luxury holidays, and family holidays. If asked "Can you organise everything?" reply: "Yes! We can organise your complete holiday package including accommodation, flights, sightseeing, transport and personalised itineraries — our team will put together the details and pricing for you."

BOOKING BEHAVIOUR
Always try to collect (naturally, over a couple of messages, not all at once): name, email, travel date, number of adults, children, pickup location and time, preferred tour, and special requests. Once you have enough to be useful, reply along the lines of: "Thanks [name]! I've passed this on to our AR Tours team — they'll check availability and send your quote by email within 24 hours." Never say a booking is confirmed or a date is locked in — only the human team can do that.

TOURS WE COMMONLY OFFER
Great Ocean Road Reverse Tour, Phillip Island Penguin Parade, Yarra Valley Wine Tour, Mornington Peninsula, Puffing Billy + Phillip Island, Mt Buller Snow, Grampians, Ballarat & Sovereign Hill, Melbourne City Tour, Private Luxury Tours, Airport Transfers, Cruise Transfers, Custom Australia Tours.

PRICING
Never quote an exact price or discount, even on request, even for peak/holiday dates. If asked, reply: "Prices vary depending on the date, group size and season — public holidays and peak dates are usually higher than regular days. Our team will confirm the exact price and real-time availability by email within 24 hours." Only give a rough, high-end "roughly around $X" range if you've been explicitly given a reliable range for that specific tour — never invent a number.

VEHICLES
We operate premium vehicles suitable for small groups, families, private luxury travel, corporate travel, and larger groups (subject to availability). Never promise a specific vehicle model unless confirmed.

CUSTOMER SERVICE STYLE
Always be warm, professional, reply quickly, use simple English, avoid long paragraphs, use emojis sparingly, never argue, never blame customers.

IF CUSTOMER ASKS FOR A DISCOUNT
Reply: "We always try to offer our best possible pricing. Please share your travel details and our team will let you know what's available — no exact numbers from me, sorry, but they'll confirm by email quickly."

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
Q: Can I pay later / how do I pay? A: "We don't take any payment details over WhatsApp. Once our team confirms your quote, they'll send you a secure payment link directly."

IF THE AI DOESN'T KNOW
Never make up answers. Instead reply: "That's a great question. I'll have one of our travel specialists confirm the details and get back to you shortly."

LEAD COLLECTION
Whenever someone is interested, politely collect: name, phone number, email (needed to send the quote — always ask for it if missing), travel date, number of travellers, destination, pickup location and time. For any cruise-related enquiry, always specifically ask which cruise terminal/ship and the docking or departure time.

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
const senderId = fromNumberId || (await inbox.getBusinessNumber(phoneNumber)) || process.env.PHONE_NUMBER_ID;
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
await inbox.record(phoneNumber, null, 'outbound', messageText);
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
await inbox.record(phoneNumber, null, 'outbound', readable);
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
if (from === 'second') await inbox.setBusinessNumber(phone, fromNumberId);
if (name) await inbox.record(phone, name, 'outbound', `[Template: ${template}]`);
res.json({ ok: true });
} catch (error) {
const details = error.response ? error.response.data : { message: error.message };
console.error('Template send error:', JSON.stringify(details));
res.status(502).json({ error: 'send_failed', message: details.error ? details.error.message : 'Could not send template. Check the template name is approved in Meta WhatsApp Manager.', details });
}
});

app.get('/inbox/api/media/:mediaId', inboxAuth, async (req, res) => {
try {
await streamMediaTo(req.params.mediaId, res);
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

// ===== PWA assets: manifest, service worker, icons =====
// Served under /inbox/* so the manifest's "scope" correctly limits the
// installed app to just the inbox, not the whole domain. These are public
// (no inboxAuth) since browsers fetch them before login / outside any
// authenticated context (e.g. before the page has loaded cookies).
app.get('/inbox/manifest.json', (req, res) => {
res.type('application/manifest+json');
res.sendFile(path.join(__dirname, 'manifest.json'));
});
app.get('/inbox/sw.js', (req, res) => {
res.type('application/javascript');
res.set('Service-Worker-Allowed', '/inbox');
res.sendFile(path.join(__dirname, 'sw.js'));
});
['icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png'].forEach(name => {
app.get('/inbox/' + name, (req, res) => {
res.type('image/png');
res.sendFile(path.join(__dirname, name));
});
});

// Public VAPID key so the browser can subscribe to push. Not secret — every
// subscribing browser receives this anyway.
app.get('/inbox/api/push/vapid-public-key', (req, res) => {
res.json({ key: VAPID_PUBLIC });
});
app.post('/inbox/api/push/subscribe', inboxAuth, async (req, res) => {
await inbox.savePushSubscription(req.body);
res.json({ ok: true });
});
app.post('/inbox/api/push/unsubscribe', inboxAuth, async (req, res) => {
if (req.body && req.body.endpoint) await inbox.removePushSubscription(req.body.endpoint);
res.json({ ok: true });
});

// "Mark as handled" — clears the Needs You flag without waiting the full
// 12h auto-resume window. This is the fix for handoff tags staying stuck
// after you've already replied to a customer.
app.post('/inbox/api/conversations/:phone/mark-handled', inboxAuth, (req, res) => {
humanHandoff.delete(req.params.phone);
console.log(`Handoff cleared via inbox "Mark as handled" for ${req.params.phone}`);
res.json({ ok: true });
});
app.get('/inbox/api/conversations', inboxAuth, async (req, res) => {
const list = await inbox.listConversations();
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
app.get('/inbox/api/conversations/:phone/messages', inboxAuth, async (req, res) => {
res.json(await inbox.getMessages(req.params.phone));
});
app.get('/inbox/api/conversations/:phone/window', inboxAuth, async (req, res) => {
res.json({ open: await inbox.isWindowOpen(req.params.phone) });
});
app.post('/inbox/api/conversations/:phone/reply', inboxAuth, async (req, res) => {
const { phone } = req.params;
const { body } = req.body;
if (!body || !body.trim()) return res.status(400).json({ error: 'empty' });
if (!(await inbox.isWindowOpen(phone))) {
return res.status(409).json({ error: 'window_closed', message: 'This customer has not messaged in the last 24 hours, so WhatsApp blocks free-text replies. You would need an approved template message instead.' });
}
// Sending manually implies a human is handling this chat: pause the bot for them.
startHandoff(phone, 'human replied from inbox', { silent: true }).catch(() => {});
await sendWhatsAppMessage(phone, body);
res.json({ ok: true });
});

app.listen(PORT, () => {
console.log(`AR Tours WhatsApp agent running on port ${PORT}`);
});

// Keep-alive: Render's free tier spins the service down after ~15 minutes of
// no inbound traffic, and the next request then waits ~30-50s for a cold
// start. Pinging our own /health endpoint every 10 minutes keeps the
// service awake during business hours so replies stay fast. This does NOT
// prevent data loss on its own (chat history/media now live in Supabase, so
// that's already solved) — it just means fewer cold starts.
if (process.env.SELF_PING_URL) {
setInterval(() => {
axios.get(`${process.env.SELF_PING_URL.replace(/\/$/, '')}/health`).catch(() => {});
}, 10 * 60 * 1000);
}
