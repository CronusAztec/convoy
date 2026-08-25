/* Convoy — outbound email over the Resend HTTP API.

   Convoy does NOT use Supabase's own mailer. Every address in the system used to
   be a synthetic one that could never receive mail, so GoTrue's SMTP was never
   configured, and the flows that need mail now (verification, password reset,
   passwordless sign-in, email change) are all driven from this server anyway —
   see the email_tokens table in db.js. Keeping delivery here means one place
   owns the templates, the from-address and the failure handling, and no GoTrue
   template/redirect configuration has to stay in sync with the app.

   NOT CONFIGURED IS A VALID STATE. Without RESEND_API_KEY every send returns
   { error: 'not-configured' } instead of throwing, and the API routes that need
   mail answer 503 with a clear message. A deployment that never sets a key keeps
   working exactly as it does today: username + password + recovery code. */
'use strict';

const API_URL = 'https://api.resend.com/emails';
const API_KEY = process.env.RESEND_API_KEY || '';
// Must be an address on a domain verified in the Resend dashboard, or every send
// is rejected. Display-name form ("Convoy <no-reply@example.com>") is fine.
const FROM = process.env.MAIL_FROM || 'Convoy <no-reply@odoreeci.tech>';
const REPLY_TO = process.env.MAIL_REPLY_TO || '';
// Base URL the links in these mails point back at. This is the DEPLOYED origin,
// deliberately NOT the request's Host header: an attacker who can set Host would
// otherwise choose where a password-reset link points.
const APP_URL = (process.env.APP_URL || 'https://odoreeci.tech').replace(/\/+$/, '');
const TIMEOUT_MS = parseInt(process.env.MAIL_TIMEOUT_MS || '10000', 10);

function configured() { return !!API_KEY; }
function appUrl() { return APP_URL; }

/* ---------------- transport ---------------- */

// Returns { ok, id } | { error }. Never throws — a send that fails must not take
// down the request that triggered it, and several callers treat mail as
// best-effort (the "your password changed" notice, for one).
async function send(msg) {
  if (!configured()) return { error: 'not-configured' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res, body;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        reply_to: REPLY_TO || undefined
      }),
      signal: ctrl.signal
    });
    try { body = await res.json(); } catch (e) { body = {}; }
  } catch (e) {
    clearTimeout(timer);
    console.error('[mail] Resend unreachable: ' + (e.name === 'AbortError' ? 'timed out' : e.message));
    return { error: 'unreachable' };
  }
  clearTimeout(timer);
  if (res.status >= 200 && res.status < 300 && body && body.id) return { ok: true, id: body.id };
  // Resend reports the useful part under `message` (unverified domain, suppressed
  // recipient, over quota). Log it — the caller only ever sees "couldn't send".
  console.error('[mail] Resend ' + res.status + ': ' +
    ((body && (body.message || body.error)) || 'unknown error'));
  return { error: 'send-failed', status: res.status };
}

/* ---------------- templates ----------------
   Deliberately plain HTML with inline styles and no remote assets: mail clients
   strip <style> blocks and block images by default, and a link that renders as
   an unstyled <a> still works. Every template ships a text/plain twin, which is
   also what keeps these out of spam filters that penalise HTML-only mail. */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function shell(heading, lead, buttonLabel, link, footer) {
  const font = '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif';
  return '<!doctype html><html><body style="margin:0;padding:0;background:#0b0d12;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0d12;padding:32px 12px;">' +
    '<tr><td align="center">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#14171f;' +
    'border:1px solid #232733;border-radius:14px;padding:32px;font-family:' + font + ';">' +
    '<tr><td style="font-size:13px;letter-spacing:.18em;color:#7c8598;font-weight:700;padding-bottom:18px;">CONVOY</td></tr>' +
    '<tr><td style="font-size:22px;line-height:1.3;color:#f2f4f8;font-weight:700;padding-bottom:12px;">' + heading + '</td></tr>' +
    '<tr><td style="font-size:15px;line-height:1.6;color:#aab2c2;padding-bottom:24px;">' + lead + '</td></tr>' +
    (link
      ? '<tr><td style="padding-bottom:24px;">' +
        '<a href="' + esc(link) + '" style="display:inline-block;background:#3d7bff;color:#ffffff;text-decoration:none;' +
        'font-weight:700;font-size:15px;padding:13px 26px;border-radius:10px;">' + esc(buttonLabel) + '</a></td></tr>' +
        '<tr><td style="font-size:12px;line-height:1.6;color:#7c8598;padding-bottom:20px;word-break:break-all;">' +
        'Or paste this into your browser:<br><span style="color:#9aa3b5;">' + esc(link) + '</span></td></tr>'
      : '') +
    '<tr><td style="border-top:1px solid #232733;padding-top:18px;font-size:12px;line-height:1.6;color:#6b7383;">' +
    footer + '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

const IGNORE = 'If you didn\'t ask for this you can ignore this email — nothing changes until the link is opened.';

function verifyEmail(to, username, link) {
  return {
    to: to,
    subject: 'Confirm your email for Convoy',
    html: shell('Confirm your email',
      'Hi <b>@' + esc(username) + '</b> — confirm this address so you can reset your password by email and sign in without one.',
      'Confirm email', link, 'This link expires in 24 hours. ' + IGNORE),
    text: 'Hi @' + username + ' — confirm your email for Convoy:\n\n' + link +
      '\n\nThis link expires in 24 hours. If you didn\'t ask for this, ignore this email.'
  };
}

function resetPassword(to, username, link) {
  return {
    to: to,
    subject: 'Reset your Convoy password',
    html: shell('Reset your password',
      'Someone asked to reset the password for <b>@' + esc(username) + '</b>. If that was you, pick a new one:',
      'Choose a new password', link,
      'This link expires in 1 hour and works once. If you didn\'t ask for it, ignore this email — your password stays as it is.'),
    text: 'Reset the password for @' + username + ':\n\n' + link +
      '\n\nThis link expires in 1 hour and works once. If you didn\'t ask for it, ignore this email.'
  };
}

function magicLink(to, username, link) {
  return {
    to: to,
    subject: 'Your Convoy sign-in link',
    html: shell('Sign in to Convoy',
      'Tap below to sign in as <b>@' + esc(username) + '</b>. No password needed.',
      'Sign in', link, 'This link expires in 15 minutes and works once. ' + IGNORE),
    text: 'Sign in to Convoy as @' + username + ':\n\n' + link +
      '\n\nThis link expires in 15 minutes and works once.'
  };
}

function confirmNewEmail(to, username, link) {
  return {
    to: to,
    subject: 'Confirm your new Convoy email',
    html: shell('Confirm your new address',
      '<b>@' + esc(username) + '</b> asked to move their Convoy account to this address. Confirm to finish the change.',
      'Confirm new address', link,
      'This link expires in 1 hour. Until it is opened the account keeps its current address. ' + IGNORE),
    text: '@' + username + ' asked to move their Convoy account to this address:\n\n' + link +
      '\n\nThis link expires in 1 hour.'
  };
}

/* ----- security notices: no link, nothing to click, nothing to phish ----- */

function emailChangedNotice(to, username, newEmail) {
  return {
    to: to,
    subject: 'Your Convoy email was changed',
    html: shell('Your email was changed',
      'The address on <b>@' + esc(username) + '</b> is being moved to <b>' + esc(newEmail) + '</b>.',
      null, null,
      'If this wasn\'t you, reset your password immediately — whoever did it had your password.'),
    text: 'The email on your Convoy account @' + username + ' is being moved to ' + newEmail +
      '.\n\nIf this wasn\'t you, reset your password immediately.'
  };
}

function passwordChangedNotice(to, username) {
  return {
    to: to,
    subject: 'Your Convoy password was changed',
    html: shell('Your password was changed',
      'The password on <b>@' + esc(username) + '</b> was just changed, and every other device was signed out.',
      null, null,
      'If this wasn\'t you, reset your password now using the link on the sign-in screen.'),
    text: 'The password on your Convoy account @' + username + ' was just changed and every other ' +
      'device was signed out.\n\nIf this wasn\'t you, reset it now from the sign-in screen.'
  };
}

module.exports = {
  configured, appUrl, send,
  verifyEmail, resetPassword, magicLink, confirmNewEmail,
  emailChangedNotice, passwordChangedNotice
};
