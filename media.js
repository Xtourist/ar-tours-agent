// Media handling for WhatsApp inbox
// Downloads media from Meta's WhatsApp Cloud API and stores it in Supabase
// Storage (a real permanent bucket), instead of the server's local disk.
//
// Fix (2026-07-25): this previously called graph.instagram.com with
// Instagram-specific fields (media_product_stream), which is the wrong API
// for WhatsApp media and always failed with a 400 error. WhatsApp Cloud API
// media downloads are a two-step process on graph.facebook.com:
//   1. GET /{media-id} -> returns a short-lived "url" field for the file
//   2. GET that url (with the same access token) -> the actual file bytes
//
// Fix (2026-08-07): media used to be written to local disk (media-cache/),
// which lives on Render's free-tier ephemeral filesystem and gets wiped on
// every restart/redeploy/spin-down — meaning images customers sent would
//404 the next time someone opened the chat. Media is now uploaded to a
// Supabase Storage bucket instead, which is real permanent storage that
// survives restarts, deploys, and free-tier sleep cycles.

const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const MEDIA_BUCKET = process.env.SUPABASE_MEDIA_BUCKET || 'whatsapp-media';

const supabase = (SUPABASE_URL && SUPABASE_SECRET_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY)
  : null;

if (!supabase) {
  console.warn('media.js: SUPABASE_URL / SUPABASE_SECRET_KEY not set — media will not persist across restarts.');
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
    const mime = urlResp.data.mime_type || MEDIA_TYPES[mediaType]?.mime || 'application/octet-stream';
    const filename = `${crypto.randomBytes(8).toString('hex')}${ext}`;

    if (!supabase) {
      throw new Error('Supabase Storage not configured (missing SUPABASE_URL/SUPABASE_SECRET_KEY)');
    }

    const { error: uploadError } = await supabase
      .storage
      .from(MEDIA_BUCKET)
      .upload(filename, Buffer.from(mediaResp.data), {
        contentType: mime,
        upsert: false
      });

    if (uploadError) throw new Error(`Supabase upload failed: ${uploadError.message}`);

    return {
      id: filename,
      type: mediaType,
      size: mediaResp.data.length,
      mime,
      filename: `media${ext}`
    };
  } catch (error) {
    const details = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error('Media download error:', details);
    throw error;
  }
}

// Streams the file straight from Supabase Storage to the HTTP response.
// Replaces the old getMediaPath()+fs.sendFile() pattern (local disk only).
async function streamMediaTo(mediaId, res) {
  if (!supabase) {
    res.status(500).json({ error: 'Media storage not configured' });
    return;
  }
  const { data, error } = await supabase.storage.from(MEDIA_BUCKET).download(mediaId);
  if (error || !data) {
    res.status(404).json({ error: 'Media not found' });
    return;
  }
  res.type(getMediaMime(mediaId));
  const buf = Buffer.from(await data.arrayBuffer());
  res.send(buf);
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
  streamMediaTo,
  getMediaMime,
  MEDIA_BUCKET
};
