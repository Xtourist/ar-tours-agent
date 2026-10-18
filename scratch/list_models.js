const axios = require('axios');
require('dotenv').config();

async function listModels() {
  try {
    const response = await axios.get(
      'https://api.groq.com/openai/v1/models',
      {
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
        }
      }
    );
    console.log('Available models:', response.data.data.map(m => m.id));
  } catch (error) {
    console.error('Error listing models:', error.response ? error.response.data : error.message);
  }
}

listModels();
