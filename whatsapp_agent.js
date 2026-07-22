const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const conversationHistory = new Map();
const MAX_HISTORY = 20;

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

      const response = await generateAIResponse(history, userName);

      history.push({ role: 'assistant', content: response });
          conversationHistory.set(phoneNumber, history);

      await sendWhatsAppMessage(phoneNumber, response);
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
    return `You are a professional customer care agent for AR Tours, a tour operations company in Australia.

    Your role:
    - Answer questions about tour bookings, pricing, and availability
    - Help customers modify existing bookings
    - Provide tour information and recommendations
    - Respond in a friendly, helpful manner

    Our Tours:
    - Sydney Harbour Tour: $89 per person (3 hours)
    - Blue Mountains Adventure: $129 per person (full day)
    - Central Coast Escape: $99 per person (half day)
    - Great Ocean Road: $159 per person (full day)

    Guidelines:
    - Keep responses under 200 words
    - Always be professional and courteous
    - Customer name: ${userName}`;
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
    } catch (error) {
          console.error('Error sending message:', error.response ? JSON.stringify(error.response.data) : error.message);
    }
}

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`AR Tours WhatsApp agent running on port ${PORT}`);
});
