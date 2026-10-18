// alert.js — sends an email notification to the AR Tours operator
// whenever a customer conversation is handed off to a human.
// Uses Gmail SMTP via nodemailer. Requires these env vars on Render:
//   ALERT_EMAIL_USER  = the Gmail address to send FROM (e.g. 777artours@gmail.com)
//   ALERT_EMAIL_PASS  = a Gmail "App Password" (NOT the normal Gmail password)
//   ALERT_EMAIL_TO    = where to send alerts (can be the same Gmail address)

const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.ALERT_EMAIL_USER || !process.env.ALERT_EMAIL_PASS) {
    console.warn('Alert email not configured (ALERT_EMAIL_USER/ALERT_EMAIL_PASS missing) — skipping email alerts.');
    return null;
  }
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.ALERT_EMAIL_USER,
      pass: process.env.ALERT_EMAIL_PASS
    }
  });
  return transporter;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function sendHandoffAlert({ phone, name, reason, lastMessage }) {
  const t = getTransporter();
  if (!t) return;

  const to = process.env.ALERT_EMAIL_TO || process.env.ALERT_EMAIL_USER;
  const inboxUrl = process.env.INBOX_URL || 'https://ar-tours-agent.onrender.com/inbox';

  try {
    await t.sendMail({
      from: `"AR Tours Bot" <${process.env.ALERT_EMAIL_USER}>`,
      to,
      subject: `🙋 Customer needs you — ${escapeHtml(name || phone)}`,
      text: `A customer has asked to speak with a human.\n\n` +
            `Name: ${name || 'Unknown'}\n` +
            `Phone: +${phone}\n` +
            `Reason: ${reason}\n` +
            `Their message: "${lastMessage}"\n\n` +
            `Reply here: ${inboxUrl}`,
      html: `<p><b>A customer has asked to speak with a human.</b></p>
             <p><b>Name:</b> ${escapeHtml(name || 'Unknown')}<br>
             <b>Phone:</b> +${escapeHtml(phone)}<br>
             <b>Reason:</b> ${escapeHtml(reason)}<br>
             <b>Their message:</b> "${escapeHtml(lastMessage)}"</p>
             <p><a href="${escapeHtml(inboxUrl)}">Open the inbox to reply →</a></p>`
    });
    console.log(`Handoff alert email sent for ${phone}`);
  } catch (err) {
    console.error('Failed to send handoff alert email:', err.message);
  }
}

async function sendNewMessageAlert({ phone, name, message }) {
  const t = getTransporter();
  if (!t) return;

  const to = process.env.ALERT_EMAIL_TO || process.env.ALERT_EMAIL_USER;
  const inboxUrl = process.env.INBOX_URL || 'https://ar-tours-agent.onrender.com/inbox';

  try {
    await t.sendMail({
      from: `"AR Tours Bot" <${process.env.ALERT_EMAIL_USER}>`,
      to,
      subject: `💬 New WhatsApp message from ${escapeHtml(name || phone)}`,
      text: `You have a new WhatsApp message.\n\nFrom: ${name || 'Unknown'}\nPhone: +${phone}\nMessage: "${message}"\n\nReply here: ${inboxUrl}`,
      html: `<p><b>New WhatsApp message received.</b></p>
             <p><b>From:</b> ${escapeHtml(name || 'Unknown')}<br>
             <b>Phone:</b> +${escapeHtml(phone)}<br>
             <b>Message:</b> "${escapeHtml(message)}"</p>
             <p><a href="${escapeHtml(inboxUrl)}">Open inbox to reply →</a></p>`
    });
    console.log(`New message alert email sent for ${phone}`);
  } catch (err) {
    console.error('Failed to send new message alert email:', err.message);
  }
}

module.exports = { sendHandoffAlert, sendNewMessageAlert };
