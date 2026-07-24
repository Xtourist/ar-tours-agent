const express = require('express');
const axios = require('axios');
require('dotenv').config();
const path = require('path');
const inbox = require('./inbox');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

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

function startHandoff(phoneNumber, reason) {
  humanHandoff.set(phoneNumber, { since: Date.now(), reason });
  console.log(`HANDOFF STARTED for ${phoneNumber} — reason: ${reason}. Bot will pause auto-replies; reply manually from WhatsApp Manager inbox.`);
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

                for (const msg of value.messages) {
                            if (msg.type === 'text') {
                                          const phoneNumber = msg.from;
                                          const userName = contacts && contacts[0] && contacts[0].profile
                                            ? contacts[0].profile.name
                                                          : 'Guest';
                                          const messageText = msg.text.body;

                              console.log(`Message from ${userName} (${phoneNumber}): ${messageText}`);

                              await handleCustomerMessage(phoneNumber, userName, messageText);
                            }
                }
            }
      }
    } catch (error) {
          console.error('Webhook error:', error.message);
    }
});

async function handleCustomerMessage(phoneNumber, userName, messageText) {
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
                startHandoff(phoneNumber, `customer requested human (message: "${messageText}")`);
                const handoffMsg = "No problem! I'm connecting you with one of our AR Tours travel specialists who will follow up with you here shortly. 🙏";
                history.push({ role: 'assistant', content: handoffMsg });
                conversationHistory.set(phoneNumber, history);
                await sendWhatsAppMessage(phoneNumber, handoffMsg);
                return;
          }

      const response = await generateAIResponse(history, userName);

      history.push({ role: 'assistant', content: response });
          conversationHistory.set(phoneNumber, history);

      await sendWhatsAppMessage(phoneNumber, response);

          // If the AI itself couldn't answer (used the master-instructions fallback line),
          // also hand off so a human follows up rather than the bot repeating itself.
          if (response.toLowerCase().includes(FALLBACK_PHRASE)) {
                startHandoff(phoneNumber, 'AI fallback response used (unknown answer)');
          }
    } catch (error) {
          console.error('Error handling message:', error.message);
          await sendWhatsAppMessage(phoneNumber, 'Sorry, I had trouble processing that. Please try again.');
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

async function sendWhatsAppMessage(phoneNumber, messageText) {
    try {
          await axios.post(
                  `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
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
          console.log(`Sent to ${phoneNumber}`);
          inbox.record(phoneNumber, null, 'outbound', messageText);
    } catch (error) {
          console.error('Error sending message:', error.response ? JSON.stringify(error.response.data) : error.message);
    }
}

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

// Usage: POST /admin/handoffs/release  { "phone": "614xxxxxxxx", "secret": "YOUR_WEBHOOK_SECRET" }
app.post('/admin/handoffs/release', (req, res) => {
    if (req.body.secret !== process.env.WEBHOOK_SECRET) return res.sendStatus(403);
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone is required' });
    humanHandoff.delete(phone);
    console.log(`Handoff manually released for ${phone} — bot will resume auto-replies.`);
    res.json({ released: phone });
});


// ===== INBOX: password-protected web UI to view/reply to customer chats =====
function inboxAuth(req, res, next) {
  const user = process.env.INBOX_USER || 'artours';
  const pass = process.env.INBOX_PASS;
  const hdr = req.headers.authorization || '';
  const b64 = hdr.split(' ')[1] || '';
  const [u, p] = Buffer.from(b64, 'base64').toString().split(':');
  if (!pass) { return res.status(500).send('INBOX_PASS not set on server'); }
  if (u === user && p === pass) return next();
  res.set('WWW-Authenticate', 'Basic realm="AR Tours Inbox"');
  return res.status(401).send('Authentication required');
}

app.get('/inbox', inboxAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'inbox.html'));
});
app.get('/inbox/api/conversations', inboxAuth, (req, res) => {
  res.json(inbox.listConversations());
});
app.get('/inbox/api/conversations/:phone/messages', inboxAuth, (req, res) => {
  res.json(inbox.getMessages(req.params.phone));
});
app.post('/inbox/api/conversations/:phone/reply', inboxAuth, async (req, res) => {
  const { phone } = req.params;
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'empty' });
  if (!inbox.isWindowOpen(phone)) {
    return res.status(409).json({ error: 'window_closed', message: 'This customer has not messaged in the last 24 hours, so WhatsApp blocks free-text replies. You would need an approved template message instead.' });
  }
  // Sending manually implies a human is handling this chat: pause the bot for them.
  try { startHandoff(phone, 'human replied from inbox'); } catch (e) {}
  await sendWhatsAppMessage(phone, body);
  res.json({ ok: true });
});

app.listen(PORT, () => {
    console.log(`AR Tours WhatsApp agent running on port ${PORT}`);
});
