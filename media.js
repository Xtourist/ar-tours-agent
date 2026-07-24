// Media handling for WhatsApp inbox
// Downloads media from Meta's API and caches it locally

const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const MEDIA_CACHE_DIR = process.env.MEDIA_CACHE_DIR || path.join(__dirname, 'media-cache');

// Ensure cache directory exists
if (!fs.existsSync(MEDIA_CACHE_DIR)) {
  fs.mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
}

// Map media type to file extension and mime type
const MEDIA_TYPES = {
  image: { ext: '.jpg', mime: 'image/jpeg' },
  document: { ext: '.pdf', mime: 'application/pdf' },
  audio: { ext: '.ogg', mime: 'audio/ogg' },
  video: { ext: '.mp4', mime: 'video/mp4' },
  file: { ext: '', mime: 'application/octet-stream' }
};

async function downloadMedia(mediaObjectId, mediaType, accessToken) {
  try {
    // Get media URL from Meta API
    const urlResp = await axios.get(
      `https://graph.instagram.com/v25.0/${mediaObjectId}`,
      { params: { fields: 'media_product_stream,file_name,file_size', access_token: accessToken } }
    );

    const mediaUrl = urlResp.data.media_product_stream || urlResp.data.url;
    if (!mediaUrl) throw new Error('No media URL in response');

    // Download the actual file
    const mediaResp = await axios.get(mediaUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      responseType: 'arraybuffer',
      timeout: 30000
    });

    const ext = MEDIA_TYPES[mediaType]?.ext || '';
    const filename = `${crypto.randomBytes(8).toString('hex')}${ext}`;
    const filepath = path.join(MEDIA_CACHE_DIR, filename);

    fs.writeFileSync(filepath, mediaResp.data);
    
    return {
      id: filename,
      type: mediaType,
      size: mediaResp.data.length,
      mime: MEDIA_TYPES[mediaType]?.mime || 'application/octet-stream',
      filename: urlResp.data.file_name || `media${ext}`
    };
  } catch (error) {
    console.error('Media download error:', error.message);
    throw error;
  }
}

function getMediaPath(mediaId) {
  return path.join(MEDIA_CACHE_DIR, mediaId);
}

function getMediaMime(mediaId) {
  const ext = path.extname(mediaId).toLowerCase();
  const mimeMap = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.pdf': 'application/pdf', '.doc': 'application/msword',
    '.ogg': 'audio/ogg', '.mp4': 'video/mp4'
  };
  return mimeMap[ext] || 'application/octet-stream';
}

module.exports = {
  downloadMedia,
  getMediaPath,
  getMediaMime,
  MEDIA_CACHE_DIR
};
