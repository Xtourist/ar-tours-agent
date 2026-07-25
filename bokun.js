// bokun.js - Bokun booking webhook handling for AR Tours.
//
// Bokun sends booking events (bookings/create, bookings/update, bookings/cancel,
// bookings/payment, bookings/refund) to a webhook URL we configure in
// Bokun > Settings > Connections > Webhooks. Each request is HMAC-signed so we
// can verify it actually came from Bokun before trusting it.
//
// We store bookings in the same JSON-file pattern as inbox.js (no new
// infrastructure) and try to match each booking to a WhatsApp conversation by
// phone number, so the customer's booking shows up next to their chat.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_PATH = process.env.BOKUN_DATA_PATH || path.join(__dirname, 'bokun-bookings.json');

// Same operator_id groundwork pattern as inbox.js.
const OPERATOR_ID = process.env.OPERATOR_ID || 'ar_tours';

let store = { bookings: {} }; // { [bookingId]: {...booking, operatorId, phone, receivedAt} }

function load() {
  try {
    if (fs.existsSync(DATA_PATH)) {
      store = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
      if (!store.bookings) store.bookings = {};
    }
  } catch (e) {
    console.warn('Bokun store: could not load data file, starting fresh:', e.message);
    store = { bookings: {} };
  }
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(DATA_PATH, JSON.stringify(store));
    } catch (e) {
      console.warn('Bokun store: could not save data file:', e.message);
    }
  }, 500);
}

// Bokun signs webhook payloads with HMAC-SHA1 (secret key) in the
// x-bokun-hmac header, over the raw request body. Reject anything that
// doesn't match so we're not trusting arbitrary POSTs to this endpoint.
function verifySignature(rawBody, signatureHeader, secretKey) {
  if (!secretKey) {
    console.warn('BOKUN_SECRET_KEY not set — skipping signature verification (not safe for production).');
    return true;
  }
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha1', secretKey).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch (e) {
    // length mismatch etc counts as invalid
    return false;
  }
}

// Pull the fields we actually care about out of Bokun's booking payload.
// Bokun's payload shape can vary a bit by event type, so this is deliberately
// defensive — grab what's there, don't throw if something's missing.
function extractBookingSummary(payload) {
  const booking = payload.booking || payload;
  const customer = booking.customer || booking.contact || {};
  const product = (booking.productBookings && booking.productBookings[0]) || booking.activity || {};

  // Normalise phone to digits only (matches how WhatsApp numbers are stored
  // in inbox.js, e.g. "61400044004") so we can match against conversations.
  const rawPhone = customer.phoneNumber || customer.phone || '';
  const phone = rawPhone.replace(/[^0-9]/g, '').replace(/^0/, '61'); // best-effort AU normalisation

  return {
    bookingId: booking.confirmationCode || booking.id || payload.bookingId || String(Date.now()),
    status: payload.action || payload.event || booking.status || 'unknown',
    tourName: product.title || product.productTitle || booking.productTitle || 'Unknown tour',
    date: product.date || booking.startDate || booking.date || null,
    pax: booking.totalParticipants || product.totalParticipants || null,
    customerName: [customer.firstName, customer.lastName].filter(Boolean).join(' ') || customer.name || 'Unknown',
    phone,
    price: booking.totalPrice || product.totalPrice || null,
    currency: booking.currency || 'AUD',
  };
}

function recordBooking(payload) {
  const summary = extractBookingSummary(payload);
  store.bookings[summary.bookingId] = {
    ...summary,
    operatorId: OPERATOR_ID,
    receivedAt: new Date().toISOString(),
    raw: payload, // keep the full payload for reference/debugging
  };
  save();
  return summary;
}

function listBookings() {
  return Object.values(store.bookings).sort((a, b) => (b.receivedAt || '').localeCompare(a.receivedAt || ''));
}

// Find bookings for a given WhatsApp phone number (same normalised format
// inbox.js uses), most recent first.
function getBookingsForPhone(phone) {
  const normalised = String(phone).replace(/[^0-9]/g, '');
  return listBookings().filter(b => b.phone === normalised);
}

load();

module.exports = {
  verifySignature,
  recordBooking,
  listBookings,
  getBookingsForPhone,
  extractBookingSummary,
  OPERATOR_ID,
};
