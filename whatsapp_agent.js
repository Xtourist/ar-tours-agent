const express = require('express');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();
const path = require('path');
const inbox = require('./inbox');
const bokun = require('./bokun');
const { sendHandoffAlert, sendNewMessageAlert } = require('./alert');
const { sendLeadWebhook } = require('./leadWebhook');
const { downloadMedia, streamMediaTo } = require('./media');
const webpush = require('web-push');
const { OpenRouter } = require('@openrouter/sdk');

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

// Fuzzy fallback detection: instead of exact string match, check for the
// key semantic tokens so the handoff still triggers even when the LLM adds
// punctuation, exclamation marks, or slightly rephrases.
const FALLBACK_TOKENS = ['great question', 'travel specialist', 'confirm the details', 'get back to you'];
function containsFallbackPhrase(text) {
  const lower = (text || '').toLowerCase();
  return FALLBACK_TOKENS.every(tok => lower.includes(tok));
}

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
  const variants = inbox.getPhoneVariants ? inbox.getPhoneVariants(phoneNumber) : [phoneNumber];
  const checkList = variants.length ? variants : [phoneNumber];
  for (const v of checkList) {
    const entry = humanHandoff.get(v);
    if (entry) {
      if (Date.now() - entry.since > HANDOFF_DURATION_MS) {
        for (const rem of checkList) humanHandoff.delete(rem);
        inbox.removeHandoff(phoneNumber).catch(() => {});
        return false;
      }
      return true;
    }
  }
  return false;
}

// Preload active handoffs from Supabase on boot
inbox.loadHandoffs().then(active => {
for (const h of active) {
if (Date.now() - h.since <= HANDOFF_DURATION_MS) {
humanHandoff.set(h.phone, { since: h.since, reason: h.reason });
} else {
inbox.removeHandoff(h.phone).catch(() => {});
}
}
console.log(`Loaded ${humanHandoff.size} active handoffs from database.`);
}).catch(err => console.warn('Could not preload handoffs:', err.message));

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
inbox.saveHandoff(phoneNumber, reason).catch(() => {});
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

    // Direct WhatsApp alert to human agent (+61400040243)
    // We try two delivery methods in sequence:
    // 1. Free-text sendWhatsAppMessage — works only if +61400040243 messaged the
    //    bot within the last 24 h (the WhatsApp "customer service window").
    // 2. Template fallback — uses the approved 'hello_world' template (available
    //    on every WABA by default) so the alert arrives even when the window is
    //    closed. To get richer alerts, create a custom template called
    //    'handoff_alert' in WhatsApp Manager and set HANDOFF_TEMPLATE_NAME env var.
    const humanAgentPhone = '61400040243';
    const cleanCustomerDigits = String(phoneNumber || '').replace(/[^0-9]/g, '');
    const agentAlertText = `🚨 *HUMAN HANDOFF ALERT*\n\n` +
      `👤 *Customer:* ${context.name || 'Guest'}\n` +
      `📞 *Phone:* +${cleanCustomerDigits}\n` +
      `⚠️ *Reason:* ${reason}\n\n` +
      `💬 *Last Message:*\n"${context.lastMessage || 'N/A'}"\n\n` +
      `👉 *Reply to customer:* https://wa.me/${cleanCustomerDigits}`;

    // First attempt: free-text (works within 24h window)
    sendWhatsAppMessage(humanAgentPhone, agentAlertText, process.env.PHONE_NUMBER_ID).catch(async (err) => {
      console.warn('Free-text alert to agent failed (window likely closed):', err.message);
      // Fallback: send approved template so alert always gets through
      const templateName = process.env.HANDOFF_TEMPLATE_NAME || 'hello_world';
      const langCode = process.env.HANDOFF_TEMPLATE_LANG || 'en_US';
      try {
        await sendWhatsAppTemplate(humanAgentPhone, templateName, langCode, [], process.env.PHONE_NUMBER_ID);
        console.log('Fallback template alert sent to agent.');
        // After template opens the window, send the full detail as a follow-up text
        setTimeout(() => {
          sendWhatsAppMessage(humanAgentPhone, agentAlertText, process.env.PHONE_NUMBER_ID)
            .catch(e => console.error('Follow-up alert text failed:', e.message));
        }, 3000);
      } catch (tplErr) {
        console.error('Template fallback also failed:', tplErr.message);
      }
    });
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
// actually received the message (main +61400044004 or secondary
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
} else if (msg.type === 'interactive') {
// Handle button replies or list selections from customers
const interactive = msg.interactive;
const selectedText = (interactive.button_reply && interactive.button_reply.title) ||
(interactive.list_reply && interactive.list_reply.title) ||
'[Button Selection]';
console.log(`Interactive from ${userName} (${phoneNumber}): ${selectedText}`);
await handleCustomerMessage(phoneNumber, userName, selectedText, businessNumberId);
} else if (msg.type === 'location') {
const loc = msg.location;
const locText = `📍 Location shared: ${loc.name || loc.address || `${loc.latitude}, ${loc.longitude}`}`;
await inbox.record(phoneNumber, userName, 'inbound', locText, msgId);
await sendWhatsAppMessage(phoneNumber, '📍 Thank you for sharing your location! Our team has noted your pickup point.', businessNumberId);
} else if (msg.type === 'contacts') {
const contactSummary = '👤 Contact shared';
await inbox.record(phoneNumber, userName, 'inbound', contactSummary, msgId);
await sendWhatsAppMessage(phoneNumber, '👤 Received the contact details. Thanks!', businessNumberId);
} else {
console.log(`Unhandled message type from ${phoneNumber}: ${msg.type}`);
await inbox.record(phoneNumber, userName, 'inbound', `[${msg.type.toUpperCase()}]`, msgId);
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

const summary = await bokun.recordBooking(req.body);
console.log(`Bokun booking recorded: ${summary.bookingId} — ${summary.tourName} (${summary.status}) for ${summary.customerName} [${summary.phone || 'no phone'}]`);

// If we can match this booking to a WhatsApp number, drop a note into that
// conversation's inbox so it's visible next to the chat — and notify the
// customer on WhatsApp if we recognise their number and their 24h window
// is open (best-effort; never let this fail the webhook response).
if (summary.phone) {
try {
const note = `📅 Bokun booking ${summary.status.toLowerCase().includes('cancel') ? 'cancelled' : 'update'}: ${summary.tourName}${summary.date ? ' on ' + summary.date : ''}${summary.pax ? ' for ' + summary.pax + ' pax' : ''} (${summary.bookingId})`;
// Use 'system' direction so automated Bokun webhook notes do NOT falsely reopen the customer 24h WhatsApp window
await inbox.record(summary.phone, summary.customerName, 'system', note);
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
app.get('/inbox/api/bokun-bookings', inboxAuth, async (req, res) => {
res.json(await bokun.listBookings());
});
app.get('/inbox/api/conversations/:phone/bokun-bookings', inboxAuth, async (req, res) => {
  try {
    const phone = String(req.params.phone || '').replace(/^ /, '+').trim();
    res.json(await bokun.getBookingsForPhone(phone));
  } catch (err) {
    console.error('Error fetching bokun bookings:', err);
    res.status(500).json({ error: 'Failed to load bookings', details: err.message });
  }
});

async function handleMediaMessage(phoneNumber, userName, msgId, mediaType, mediaObj, businessNumberId) {
try {
// Log the media in the inbox
const caption = mediaObj.caption || `[${mediaType.toUpperCase()}]`;
await inbox.record(phoneNumber, userName, 'inbound', caption, msgId);
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
await sendWhatsAppMessage(phoneNumber, "Hi there! 👋 Unfortunately, we're not able to receive or view images here on this number.\n\nIf you'd like to share something with us, please describe it in a text message and we'll do our best to help. 😊\n\nOr if you need to speak to someone directly:\n📞 +61 400 040 243\n📧 human@theartours.com", businessNumberId);
} else if (mediaType === 'audio') {
await sendWhatsAppMessage(phoneNumber, "Hi! 👋 We're sorry, but we're unable to receive voice messages or audio files on this number.\n\nPlease type out your question or request and we'll be happy to assist you! 😊\n\nPrefer to speak directly?\n📞 +61 400 040 243\n📧 human@theartours.com", businessNumberId);
} else if (mediaType === 'document') {
await sendWhatsAppMessage(phoneNumber, "Hi there! 👋 We're not able to receive documents or files on this number, sorry about that.\n\nCould you describe what you need in a text message instead? Our team is happy to help. 😊\n\nOr reach us directly:\n📞 +61 400 040 243\n📧 human@theartours.com", businessNumberId);
} else {
await sendWhatsAppMessage(phoneNumber, `Hi! 👋 We're not set up to receive ${mediaType} files here, apologies for any inconvenience.\n\nPlease type your question or request and we'll get back to you right away. 😊\n\n📞 +61 400 040 243\n📧 human@theartours.com`, businessNumberId);
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

const history = await getConversationHistory(phoneNumber);
history.push({ role: 'user', content: safeText });
conversationHistory.set(phoneNumber, history);
await inbox.saveAIHistory(phoneNumber, history);
await inbox.record(phoneNumber, userName, 'inbound', safeText);
notifyPush(userName || phoneNumber, safeText.slice(0, 120), phoneNumber).catch(() => {});
sendNewMessageAlert({ phone: phoneNumber, name: userName, message: safeText.slice(0, 300) }).catch(() => {});

if (hasCard) {
console.warn(`Card number detected and redacted from message by ${phoneNumber} — never storing or emailing it.`);
startHandoff(phoneNumber, 'customer sent payment/card details (redacted)', { name: userName, lastMessage: safeText }).catch(() => {});
const cardMsg = "For your security, we never take card or payment details over WhatsApp — I haven't stored what you sent. 🙏 Our team will send you a secure payment link directly once your booking is confirmed. I've flagged this chat for a team member to follow up shortly.";
history.push({ role: 'assistant', content: cardMsg });
conversationHistory.set(phoneNumber, history);
await inbox.saveAIHistory(phoneNumber, history);
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
const handoffMsg = "No problem! I've passed this on to one of our AR Tours travel specialists, who will follow up with you here shortly. 🙏\n\nIf it's urgent, you can also reach us directly:\n📧 human@theartours.com\n📞 +61 400 040 243";
history.push({ role: 'assistant', content: handoffMsg });
conversationHistory.set(phoneNumber, history);
await inbox.saveAIHistory(phoneNumber, history);
await sendWhatsAppMessage(phoneNumber, handoffMsg, businessNumberId);
return;
}

const response = await generateAIResponse(history, userName);

history.push({ role: 'assistant', content: response });
conversationHistory.set(phoneNumber, history);
await inbox.saveAIHistory(phoneNumber, history);

await sendWhatsAppMessage(phoneNumber, response, businessNumberId);

// If the AI itself couldn't answer (used the master-instructions fallback line),
// also hand off so a human follows up rather than the bot repeating itself.
if (containsFallbackPhrase(response)) {
startHandoff(phoneNumber, 'AI could not answer the question', { name: userName, lastMessage: messageText }).catch(() => {});
}
} catch (error) {
console.error('Error handling message:', error.message);
await sendWhatsAppMessage(phoneNumber, 'Sorry, I had trouble processing that. Please try again.', businessNumberId);
}
}

async function generateAIResponse(history, userName) {
  const systemPrompt = buildSystemPrompt(userName);

  // 1. Try Claude (Anthropic) — best quality
  if (process.env.CLAUDE_API_KEY && process.env.CLAUDE_API_KEY !== 'your_claude_api_key_here') {
    try {
      console.log('🤖 Attempting Claude API...');
      return await callClaudeAPI(history, systemPrompt);
    } catch (error) {
      console.warn('Claude failed:', error.message);
    }
  }

  // 2. Try Gemini (Google) — strong fallback
  const geminiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (geminiKey && geminiKey !== 'your_google_api_key_here') {
    try {
      console.log('🤖 Attempting Gemini API...');
      return await callGeminiAPI(history, systemPrompt, geminiKey);
    } catch (error) {
      console.warn('Gemini failed:', error.message);
    }
  }

  // 3. Try Groq — fast primary engine
  if (process.env.GROQ_API_KEY) {
    try {
      console.log('🤖 Attempting Groq API...');
      return await callGroqAPI(history, systemPrompt);
    } catch (error) {
      console.warn('Groq failed:', error.message);
    }
  }

  // 4. Try OpenRouter (GPT-4o) — reliable fallback
  if (process.env.OPENROUTER_API_KEY) {
    try {
      console.log('🤖 Attempting OpenRouter API...');
      return await callOpenRouterAPI(history, systemPrompt);
    } catch (error) {
      console.warn('OpenRouter failed:', error.response ? JSON.stringify(error.response.data) : error.message);
    }
  }

  console.error('❌ All AI providers failed or unconfigured.');
  return "Thanks for reaching out to AR Tours! We're experiencing high demand right now. Please try again in a moment, or contact us at human@theartours.com or +61 400 040 243.";
}

async function callOpenRouterAPI(history, systemPrompt) {
  const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o';
  try {
    const openrouter = new OpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY
    });
    const result = await openrouter.chat.send({
      chatRequest: {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...history.map(m => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content
          }))
        ],
        maxTokens: 500,
        temperature: 0.7
      }
    });
    if (result && result.choices && result.choices[0] && result.choices[0].message) {
      return result.choices[0].message.content;
    }
  } catch (sdkErr) {
    console.warn('OpenRouter SDK call failed, attempting direct HTTP fallback:', sdkErr.message);
  }

  // Direct HTTP fallback
  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content
        }))
      ],
      max_tokens: 500,
      temperature: 0.7
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': process.env.SITE_URL || 'https://theartours.com',
        'X-Title': process.env.SITE_NAME || 'AR Tours WhatsApp Agent',
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
  );
  return response.data.choices[0].message.content;
}

async function callClaudeAPI(history, systemPrompt) {
  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 500,
      system: systemPrompt,
      messages: history.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content
      }))
    },
    {
      headers: {
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      timeout: 12000
    }
  );
  return response.data.content[0].text;
}

async function callGeminiAPI(history, systemPrompt, apiKey) {
  const contents = history.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      contents,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { maxOutputTokens: 500, temperature: 0.7 }
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 12000 }
  );
  return response.data.candidates[0].content.parts[0].text;
}

async function callGroqAPI(history, systemPrompt) {
  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
      ],
      max_tokens: 500,
      temperature: 0.7
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 12000
    }
  );
  return response.data.choices[0].message.content;
}

function buildSystemPrompt(userName) {
return `You are Aria, a warm and friendly team member at AR Tours (AR Travel Group Pty Ltd) based in Melbourne, Australia. You chat with customers on WhatsApp just like a real person would — natural, conversational, caring, and helpful. You genuinely love travel and get excited helping people plan amazing Australian experiences.

PERSONALITY & TONE
- Talk like a real person, not a robot or a call centre script. Use natural language, contractions ("I'd love to help!", "that's a great choice!", "let me find that out for you").
- Be warm and enthusiastic but not over the top. Match the customer's energy — if they're casual, be casual; if they're formal, be professional.
- Use their name (${userName}) naturally in conversation once you know it, the way a real person would.
- Keep messages short and WhatsApp-friendly — no walls of text. One or two short paragraphs max, or a few quick bullet points.
- Use emojis sparingly and naturally (1–2 per message max) — like a real person would, not like a chatbot.
- Never start two replies in a row with the same opening word.
- Never sound like you're reading from a script. If you need to say no, be human about it: "Ah, I can't confirm a price right now — that's something the team has to do — but I'll make sure they get back to you quickly!"
- Show genuine interest: "Oh, the Great Ocean Road at this time of year is stunning!", "That sounds like such a fun trip for the family!"
- If you don't know something, be honest and human: "Good question — I'm not 100% sure on that one, let me get the team to confirm for you."

CRITICAL RULES (never break these)
1. NEVER take or discuss payment details. If a customer sends card info: "For your security we never take payment details over WhatsApp — I haven't saved anything you sent. The team will send you a secure payment link once your booking is confirmed. 🙏"
2. NEVER quote an exact price. You can say "prices vary by date and group size — the team will send you the exact number by email." If pushed, give a rough high-end ballpark only if you genuinely know a reliable range — never invent numbers.
3. NEVER confirm a booking or say a date is "locked in" — only the human team can do that.
4. If a customer asks for a human, type 'human', or it's urgent: always honour it immediately and warmly: "Of course! Let me pass you to the team right now. You can also reach them directly on 📞 +61 400 040 243 or 📧 human@theartours.com"
5. Early in the conversation (naturally, not as a disclaimer), mention you're an automated assistant: "By the way, I'm an automated assistant — but the team is always just a message away if you'd prefer to speak to a real person! Just type 'human' any time. 😊"

COLLECTING BOOKING DETAILS
When a customer is interested in booking, collect these details naturally over the conversation (ask 1–2 things at a time, not all at once):
- Their name
- Email address (needed to send the quote)
- Travel date(s)
- Number of people (adults + children with ages if relevant)
- Which tour or experience they want
- Pickup location and time (CRITICAL for cruise transfers — always ask "Which cruise terminal or ship are you on, and what time does it dock?")
- Any special requests

Once you have enough detail, say something like: "Perfect, thanks [name]! I've passed everything to the AR Tours team — they'll confirm availability and send your quote to [email] within 24 hours. Really looking forward to helping you experience Australia! 🙌"

ABOUT AR TOURS
- Melbourne-based, covering all of Victoria and custom tours anywhere in Australia
- Website: https://toursau.com | Instagram: @theartours
- Email: 888artours@gmail.com
- Human/urgent: 📞 +61 400 040 243

TOURS & SERVICES
Great Ocean Road, Phillip Island Penguin Parade, Yarra Valley Wine Tour, Mornington Peninsula, Puffing Billy + Phillip Island, Mt Buller Snow, Grampians, Ballarat & Sovereign Hill, Melbourne City Tour, Private Luxury Tours, Airport Transfers, Cruise Transfers, Multi-day Tours, Custom Australia Itineraries, Hotel Bookings, Flight Bookings, Holiday Packages, Honeymoon Packages, Corporate Tours, Family Tours, Group Travel.

If a customer asks about something not on the list: "We'd love to help! We can put together completely customised experiences anywhere in Australia — just tell me what you have in mind 😊"

PRICING
Never give exact prices. If asked: "Prices depend on the date, group size and season — I don't want to give you the wrong number! The team will confirm the exact price and availability for your date by email within 24 hours." Only give a rough range if you genuinely know a reliable one — never make up figures.

FREQUENTLY ASKED QUESTIONS
Q: Do you only do Melbourne? A: "Not at all! Melbourne is our home base but we run tours and packages all across Australia."
Q: Can we customise the tour? A: "Absolutely — every trip can be built around what you want to do!"
Q: Can you organise hotels/flights too? A: "Yes! We can handle the whole trip — accommodation, flights, transfers, tours, the lot."
Q: How do I pay? A: "We don't take payment over WhatsApp. Once the team confirms your quote, they'll send you a secure payment link."
Q: Do you do child seats? A: "Yes, just let us know the child's age when you book and we'll sort it."
Q: Do you do airport pickups? A: "Yes, definitely!"

Customer's name: ${userName}`;
}

async function getConversationHistory(phoneNumber) {
if (!conversationHistory.has(phoneNumber)) {
const loaded = await inbox.loadAIHistory(phoneNumber);
conversationHistory.set(phoneNumber, loaded || []);
}
let history = conversationHistory.get(phoneNumber);
if (history.length > MAX_HISTORY) {
history = history.slice(-MAX_HISTORY);
conversationHistory.set(phoneNumber, history);
}
return history;
}

const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';

// fromNumberId lets us send from whichever business number (+61400044004 bot
// or +61400040243 human) actually owns this conversation. Falls back to the
// main number's env var if none is known yet (e.g. very first outbound send
// before any inbound message has been recorded for this phone).
async function sendWhatsAppMessage(phoneNumber, messageText, fromNumberId) {
const senderId = fromNumberId || (await inbox.getBusinessNumber(phoneNumber)) || process.env.PHONE_NUMBER_ID;
const toDigits = String(phoneNumber || '').replace(/[^0-9]/g, '');
try {
await axios.post(
`https://graph.facebook.com/${GRAPH_API_VERSION}/${senderId}/messages`,
{
messaging_product: 'whatsapp',
to: toDigits,
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
const toDigits = String(phoneNumber || '').replace(/[^0-9]/g, '');
const components = bodyParams.length
? [{ type: 'body', parameters: bodyParams.map(p => ({ type: 'text', text: String(p) })) }]
: [];
await axios.post(
`https://graph.facebook.com/${GRAPH_API_VERSION}/${senderId}/messages`,
{
messaging_product: 'whatsapp',
to: toDigits,
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
// from (main bot +61400044004 or secondary +61400040243). Defaults to the main number.
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
inbox.removeHandoff(phone).catch(() => {});
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
const decoded = Buffer.from(b64, 'base64').toString();
const colonIdx = decoded.indexOf(':');
const u = colonIdx !== -1 ? decoded.slice(0, colonIdx) : '';
const p = colonIdx !== -1 ? decoded.slice(colonIdx + 1) : '';
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
app.post('/inbox/api/conversations/:phone/mark-handled', inboxAuth, async (req, res) => {
  try {
    const phone = String(req.params.phone || '').replace(/^ /, '+').trim();
    const variants = inbox.getPhoneVariants ? inbox.getPhoneVariants(phone) : [phone];
    for (const v of variants) {
      humanHandoff.delete(v);
    }
    humanHandoff.delete(phone);
    await inbox.removeHandoff(phone).catch(() => {});
    console.log(`Handoff cleared via inbox "Mark as handled" for ${phone}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error in mark-handled:', err);
    res.status(500).json({ error: 'Failed to clear handoff', details: err.message });
  }
});
app.get('/inbox/api/conversations', inboxAuth, async (req, res) => {
  try {
    const list = await inbox.listConversations();
    // Attach needsHuman flag + latest matched Bokun booking (tour/date/pax) so
    // the mobile inbox can show a tour tag on each row and sort handed-off /
    // unanswered chats to the top, without a round trip per conversation.
    const withStatus = await Promise.all((list || []).map(async (c) => {
      let bookings = [];
      try {
        bookings = await bokun.getBookingsForPhone(c.phone);
      } catch (bErr) {
        console.warn(`bokun.getBookingsForPhone failed for ${c.phone}:`, bErr.message);
      }
      const latest = bookings && bookings[0];
      return {
        ...c,
        needsHuman: isInHandoff(c.phone),
        tour: latest ? { tourName: latest.tourName, date: latest.date, pax: latest.pax, status: latest.status } : null
      };
    }));
    res.json(withStatus);
  } catch (err) {
    console.error('Error fetching conversations in /inbox/api/conversations:', err);
    res.status(500).json({ error: 'Failed to load conversations', details: err.message });
  }
});
// Lightweight endpoint just for handoff status (used to refresh needsHuman
// flags on poll without re-fetching full conversation list every time).
app.get('/inbox/api/handoff-status', inboxAuth, (req, res) => {
  const list = Array.from(humanHandoff.keys());
  res.json({ phones: list });
});
app.get('/inbox/api/conversations/:phone/messages', inboxAuth, async (req, res) => {
  try {
    let raw = String(req.params.phone || '').trim();
    try { raw = decodeURIComponent(raw); } catch (e) {}
    const phone = raw.replace(/^ /, '+').trim();
    res.json(await inbox.getMessages(phone));
  } catch (err) {
    console.error('Error fetching messages in /inbox/api/conversations/:phone/messages:', err);
    res.status(500).json({ error: 'Failed to load messages', details: err.message });
  }
});
app.get('/inbox/api/conversations/:phone/window', inboxAuth, async (req, res) => {
  try {
    const phone = String(req.params.phone || '').replace(/^ /, '+').trim();
    res.json({ open: await inbox.isWindowOpen(phone) });
  } catch (err) {
    console.error('Error checking window in /inbox/api/conversations/:phone/window:', err);
    res.status(500).json({ error: 'Failed to check window', details: err.message });
  }
});
app.post('/inbox/api/conversations/:phone/reply', inboxAuth, async (req, res) => {
  try {
    const phone = String(req.params.phone || '').replace(/^ /, '+').trim();
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'empty' });
    if (!(await inbox.isWindowOpen(phone))) {
      return res.status(409).json({ error: 'window_closed', message: 'This customer has not messaged in the last 24 hours, so WhatsApp blocks free-text replies. You would need an approved template message instead.' });
    }
    // Sending manually implies a human is handling this chat: pause the bot for them.
    startHandoff(phone, 'human replied from inbox', { silent: true }).catch(() => {});
    await sendWhatsAppMessage(phone, body);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error in reply:', err);
    res.status(500).json({ error: 'Failed to send reply', details: err.message });
  }
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
