// leadWebhook.js - sends handoff leads to the Google Apps Script webhook,
// which logs them to the "Leads" tab of the AR Tours Booking Automation
// Google Sheet and emails the operator. This works even when the operator's
// computer is off, since Apps Script runs on Google's servers.
//
// Replaces/supplements the broken Gmail-SMTP alert.js, which fails on
// Render's free tier because outbound SMTP ports are blocked. This uses a
// plain HTTPS POST instead, which is not blocked.
//
// Required env var on Render:
//   APPS_SCRIPT_WEBHOOK_URL = the /exec URL from the Apps Script deployment
//   APPS_SCRIPT_SECRET      = shared secret, must match SHARED_SECRET in the
//                              Apps Script project (LeadWebhook.gs)

const axios = require('axios');

async function sendLeadWebhook({ phone, name, reason, lastMessage }) {
  const url = process.env.APPS_SCRIPT_WEBHOOK_URL;
  const secret = process.env.APPS_SCRIPT_SECRET;

  if (!url) {
    console.warn('Lead webhook not configured (APPS_SCRIPT_WEBHOOK_URL missing) — skipping.');
    return;
  }

  try {
    await axios.post(url, {
      secret: secret || '',
      phone: phone || '',
      name: name || '',
      reason: reason || '',
      lastMessage: lastMessage || '',
    }, {
      timeout: 10000,
      // Apps Script issues a redirect (302) from /exec to the real
      // execution URL; axios follows redirects by default, so no extra
      // config is needed here.
    });
    console.log(`Lead webhook sent for ${phone || name || 'unknown'}`);
  } catch (err) {
    console.error('Failed to send lead webhook:', err.response ? JSON.stringify(err.response.data) : err.message);
  }
}

module.exports = { sendLeadWebhook };
