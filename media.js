// Media handling for WhatsApp inbox
// Downloads media from Meta's WhatsApp Cloud API and caches it locally.
//
// Fix (2026-07-25): this previously called graph.instagram.com with
// Instagram-specific fields (media_product_stream), which is the wrong API
// for WhatsApp media and always failed with a 400 error. WhatsApp Cloud API
// media downloads are a two-step process on graph.facebook.com:
//   1. GET /{media-id} -> returns a short-lived "url" field for the file
//   2. GET that url (with the same access token) -> the actual file bytes

const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const MEDIA_CACHE_DIR = process.env.MEDIA_CACHE_DIR || path.join(__dirname, 'media-cache');
const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v18.0';

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
    // Step 1: look up the media's real (short-lived) download URL via the
    // WhatsApp Cloud API — NOT the Instagram Graph API.
    const urlResp = await axios.get(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaObjectId}`,
      {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        params: { fields: 'url,mime_type,file_size' }
      }
    );

    const mediaUrl = urlResp.data.url;
    if (!mediaUrl) throw new Error('No media URL in response from WhatsApp API');

    // Step 2: download the actual file bytes from that URL, same access token.
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
      mime: urlResp.data.mime_type || MEDIA_TYPES[mediaType]?.mime || 'application/octet-stream',
      filename: `media${ext}`
    };
  } catch (error) {
    const details = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error('Media download error:', details);
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
