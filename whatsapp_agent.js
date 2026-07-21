const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Webhook GET verification
app.get('/webhook', (req, res) => {
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  if (token === process.env.WEBHOOK_VERIFY_TOKEN) {
    res.send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Webhook POST for incoming messages
app.post('/webhook', async (req, res) => {
  const { entry } = req.body;
  
  if (entry) {
    for (const item of entry) {
      const messaging = item.messaging[0];
      if (messaging && messaging.message && messaging.message.text) {
        const phoneNumber = messaging.sender.id;
        const text = messaging.message.text;
        
        console.log(`Message from ${phoneNumber}: ${text}`);
        
        // Send response
        await sendWhatsAppMessage(phoneNumber, 'Thanks for your message! Your AR Tours agent is live.');
      }
    }
    res.sendStatus(200);
  }
});

async function sendWhatsAppMessage(phoneNumber, message) {
  try {
    await axios.post(
      `https://graph.instagram.com/v17.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'text',
        text: { body: message }
      },
      {
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` }
      }
    );
  } catch (error) {
    console.error('Error sending message:', error.message);
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`AR Tours WhatsApp agent running on port ${PORT}`);
});
