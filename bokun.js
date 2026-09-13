// bokun.js - Bokun booking webhook handling for AR Tours.
//
// Bokun sends booking events to our webhook URL. Each request is HMAC-signed.
// Bookings are persisted to Supabase ('bokun_bookings' table) with an
// in-memory fallback so bookings survive Render restarts.

require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const OPERATOR_ID = process.env.OPERATOR_ID || 'ar_tours';

const supabase = (SUPABASE_URL && SUPABASE_SECRET_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY)
  : null;

// In-memory fallback
let fallbackBookings = new Map();

// Bokun signs webhook payloads with HMAC-SHA1 in the x-bokun-hmac header
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
    return false;
  }
}

function extractBookingSummary(payload) {
  const booking = payload.booking || payload;
  const customer = booking.customer || booking.contact || {};
  const product = (booking.productBookings && booking.productBookings[0]) || booking.activity || {};

  const rawPhone = customer.phoneNumber || customer.phone || '';
  const phone = rawPhone.replace(/[^0-9]/g, '').replace(/^0/, '61');

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

async function recordBooking(payload) {
  const summary = extractBookingSummary(payload);
  const now = new Date().toISOString();

  fallbackBookings.set(summary.bookingId, {
    ...summary,
    operatorId: OPERATOR_ID,
    receivedAt: now,
    raw: payload,
  });

  if (supabase) {
    try {
      await supabase.from('bokun_bookings').upsert({
        booking_id: summary.bookingId,
        phone: summary.phone,
        customer_name: summary.customerName,
        tour_name: summary.tourName,
        date: summary.date,
        pax: summary.pax,
        price: summary.price,
        currency: summary.currency,
        status: summary.status,
        raw: payload,
        created_at: now
      }, { onConflict: 'booking_id' });
    } catch (err) {
      console.warn('Bokun Supabase record failed:', err.message);
    }
  }

  return summary;
}

async function listBookings() {
  if (!supabase) {
    return Array.from(fallbackBookings.values()).sort((a, b) => (b.receivedAt || '').localeCompare(a.receivedAt || ''));
  }
  try {
    const { data, error } = await supabase
      .from('bokun_bookings')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      console.warn('listBookings error:', error.message);
      return Array.from(fallbackBookings.values());
    }
    return (data || []).map(row => ({
      bookingId: row.booking_id,
      phone: row.phone,
      customerName: row.customer_name,
      tourName: row.tour_name,
      date: row.date,
      pax: row.pax,
      price: row.price,
      currency: row.currency,
      status: row.status,
      receivedAt: row.created_at
    }));
  } catch (err) {
    console.warn('listBookings failed:', err.message);
    return Array.from(fallbackBookings.values());
  }
}

async function getBookingsForPhone(phone) {
  if (!phone) return [];
  let raw = String(phone || '').trim();
  for (let i = 0; i < 3 && raw.includes('%'); i++) {
    try {
      const d = decodeURIComponent(raw);
      if (d === raw) break;
      raw = d;
    } catch (e) {
      break;
    }
  }
  const digits = raw.replace(/[^0-9]/g, '');
  const phonesSet = new Set();
  if (digits) {
    phonesSet.add(digits);
    if (!digits.startsWith('0')) {
      phonesSet.add('+' + digits);
    }
    if (digits.startsWith('61') && digits.length === 11) {
      phonesSet.add('0' + digits.slice(2));
      phonesSet.add('+61' + digits.slice(2));
    } else if (digits.startsWith('0') && digits.length === 10) {
      phonesSet.add('61' + digits.slice(1));
      phonesSet.add('+61' + digits.slice(1));
    }
  }
  const phones = Array.from(phonesSet);
  if (!phones.length) return [];
  if (!supabase) {
    return (await listBookings()).filter(b => phones.includes(b.phone) || (digits && b.phone && b.phone.replace(/[^0-9]/g, '') === digits));
  }
  try {
    const postgrestPhones = phones.map(p => (/[^0-9a-zA-Z_-]/.test(p) ? `"${p.replace(/"/g, '')}"` : p));
    const { data, error } = await supabase
      .from('bokun_bookings')
      .select('*')
      .in('phone', postgrestPhones)
      .order('created_at', { ascending: false });
    if (error || !data) return [];
    return data.map(row => ({
      bookingId: row.booking_id,
      phone: row.phone,
      customerName: row.customer_name,
      tourName: row.tour_name,
      date: row.date,
      pax: row.pax,
      price: row.price,
      currency: row.currency,
      status: row.status,
      receivedAt: row.created_at
    }));
  } catch (err) {
    return [];
  }
}

module.exports = {
  verifySignature,
  recordBooking,
  listBookings,
  getBookingsForPhone,
  extractBookingSummary,
  OPERATOR_ID,
};
