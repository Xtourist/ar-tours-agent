const axios = require('axios');
require('dotenv').config();

async function test() {
  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'groq/compound-mini',
        messages: [
          { role: 'user', content: 'hello' }
        ],
        max_tokens: 10
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Success:', response.data.choices[0].message.content);
  } catch (error) {
    console.error('Error details:', error.response ? error.response.data : error.message);
  }
}

test();
