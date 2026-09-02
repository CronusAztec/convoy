/* Convoy — server/mailer.js: the Resend transport and the link templates.

   Mail is the weakest link in every flow built on it, and the failure modes are
   quiet ones:

     - NOT CONFIGURED has to be a normal answer, not an exception. A deployment
       with no Resend key must keep working as username + password + recovery
       code, and every mail-dependent route must be able to see "no mailer" and
       answer 503 rather than 500.
     - A send that fails must NOT throw. Several callers treat mail as
       best-effort (the "your password changed" notice fires after the change has
       already happened); a throw there would turn a succeeded operation into a
       500 the rider is told to retry.
     - The links point at APP_URL, which is configuration — never the request's
       Host header. Anyone who can set Host would otherwise choose where a
       password-reset link lands.
     - A username goes into HTML. It is already constrained to [A-Za-z0-9_], but
       the templates must not depend on that holding forever.

   Run:  node test/mailer.test.js
*/
'use strict';
const path = require('path');
const H = require('./harness');

const MAILER_PATH = path.join(__dirname, '..', 'server', 'mailer.js');

// mailer.js captures its config at require time, so each configuration under
// test needs a fresh load.
function load(env) {
  Object.keys(env).forEach((k) => {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  });
  delete require.cache[require.resolve(MAILER_PATH)];
  return require(MAILER_PATH);
}

// Records what fetch was called with and replies however the test wants.
function stubFetch(reply) {
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push({ url: url, opts: opts, body: JSON.parse(opts.body) });
    if (typeof reply === 'function') return reply();
    return {
      status: reply.status,
      json: async () => reply.body
    };
  };
  return seen;
}

const OK = { status: 200, body: { id: 'msg_123' } };

(async function main() {

  H.group('No API key is a working configuration, not an error');
  {
    const mail = load({ RESEND_API_KEY: '', MAIL_FROM: 'Convoy <no-reply@test>', APP_URL: 'https://app.test' });
    global.fetch = async () => { throw new Error('fetch must not be called without a key'); };

    H.ok('configured() says so', mail.configured() === false);
    const r = await mail.send({ to: 'a@b.test', subject: 's', html: 'h', text: 't' });
    H.ok('send resolves with an error instead of throwing', r.error === 'not-configured', JSON.stringify(r));
    H.ok('and never resolves ok', !r.ok);
  }

  H.group('A send that fails is reported, never thrown');
  {
    const mail = load({ RESEND_API_KEY: 'rk_test', MAIL_FROM: 'Convoy <no-reply@test>', APP_URL: 'https://app.test' });

    stubFetch({ status: 403, body: { message: 'domain not verified' } });
    const bad = await mail.send({ to: 'a@b.test', subject: 's', html: 'h', text: 't' });
    H.ok('an API rejection resolves as an error', bad.error === 'send-failed', JSON.stringify(bad));
    H.ok('and carries the status for the log', bad.status === 403);

    // A 200 with no id is not a delivery — treating it as one would report
    // "check your inbox" for mail that was never queued.
    stubFetch({ status: 200, body: {} });
    const empty = await mail.send({ to: 'a@b.test', subject: 's', html: 'h', text: 't' });
    H.ok('a 200 with no message id is still a failure', empty.error === 'send-failed');

    stubFetch(() => { throw Object.assign(new Error('socket hang up'), { name: 'TypeError' }); });
    const down = await mail.send({ to: 'a@b.test', subject: 's', html: 'h', text: 't' });
    H.ok('an unreachable API resolves as unreachable', down.error === 'unreachable', JSON.stringify(down));

    stubFetch(() => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
    const slow = await mail.send({ to: 'a@b.test', subject: 's', html: 'h', text: 't' });
    H.ok('and so does a timeout', slow.error === 'unreachable');
  }

  H.group('The request Resend receives is the one it expects');
  {
    const mail = load({
      RESEND_API_KEY: 'rk_test', MAIL_FROM: 'Convoy <no-reply@test>',
      MAIL_REPLY_TO: 'support@test', APP_URL: 'https://app.test'
    });
    const seen = stubFetch(OK);
    const r = await mail.send({ to: 'rider@example.com', subject: 'Subj', html: '<b>h</b>', text: 'plain' });

    H.ok('the send is reported ok with the message id', r.ok === true && r.id === 'msg_123');
    H.ok('it went to the Resend endpoint', seen[0].url === 'https://api.resend.com/emails', seen[0].url);
    H.ok('as a POST', seen[0].opts.method === 'POST');
    H.ok('with the key as a bearer', seen[0].opts.headers.Authorization === 'Bearer rk_test');
    H.ok('to is an array, as the API requires',
      Array.isArray(seen[0].body.to) && seen[0].body.to[0] === 'rider@example.com');
    H.ok('the configured from-address is used', seen[0].body.from === 'Convoy <no-reply@test>');
    H.ok('reply_to is passed when set', seen[0].body.reply_to === 'support@test');
    // HTML-only mail is penalised by spam filters, and a text/plain twin is the
    // cheap fix — so every send has to carry both.
    H.ok('both an HTML and a text body are sent', !!seen[0].body.html && !!seen[0].body.text);
  }
  {
    const mail = load({
      RESEND_API_KEY: 'rk_test', MAIL_FROM: 'Convoy <no-reply@test>',
      MAIL_REPLY_TO: '', APP_URL: 'https://app.test'
    });
    const seen = stubFetch(OK);
    await mail.send({ to: 'a@b.test', subject: 's', html: 'h', text: 't' });
    H.ok('an unset reply_to is omitted rather than sent empty', seen[0].body.reply_to === undefined,
      JSON.stringify(seen[0].body.reply_to));
  }

  H.group('APP_URL is configuration, and trailing slashes do not double up');
  {
    const mail = load({ RESEND_API_KEY: 'rk_test', MAIL_FROM: 'x <a@b.test>', APP_URL: 'https://app.test///' });
    H.ok('trailing slashes are trimmed', mail.appUrl() === 'https://app.test', mail.appUrl());
  }

  H.group('Every link template carries the link in both bodies');
  {
    const mail = load({ RESEND_API_KEY: 'rk_test', MAIL_FROM: 'x <a@b.test>', APP_URL: 'https://app.test' });
    const link = 'https://app.test/?cv=reset&token=abc123';
    const cases = [
      ['verifyEmail', mail.verifyEmail('r@example.com', 'rider', link)],
      ['resetPassword', mail.resetPassword('r@example.com', 'rider', link)],
      ['magicLink', mail.magicLink('r@example.com', 'rider', link)],
      ['confirmNewEmail', mail.confirmNewEmail('r@example.com', 'rider', link)]
    ];
    cases.forEach(([name, msg]) => {
      H.ok(name + ' addresses the recipient', msg.to === 'r@example.com');
      H.ok(name + ' has a subject', !!msg.subject && msg.subject.length > 5);
      // The button can be stripped by a mail client; the plain-text copy of the
      // URL is what makes these recoverable, so both bodies must carry it.
      H.ok(name + ' puts the link in the HTML body', msg.html.indexOf(link.replace(/&/g, '&amp;')) >= 0);
      H.ok(name + ' puts the link in the text body', msg.text.indexOf(link) >= 0);
      H.ok(name + ' names the account', msg.text.indexOf('rider') >= 0);
    });
  }

  H.group('Security notices are link-free by design');
  {
    const mail = load({ RESEND_API_KEY: 'rk_test', MAIL_FROM: 'x <a@b.test>', APP_URL: 'https://app.test' });
    // These are the mails a rider gets when something happened WITHOUT them.
    // A clickable link in one is a phishing template waiting to be copied, so
    // they deliberately tell the reader what to do rather than doing it.
    const pw = mail.passwordChangedNotice('r@example.com', 'rider');
    const em = mail.emailChangedNotice('r@example.com', 'rider', 'new@example.com');
    H.ok('the password notice has no anchor at all', pw.html.indexOf('<a ') < 0, pw.html.slice(0, 200));
    H.ok('the email notice has none either', em.html.indexOf('<a ') < 0);
    H.ok('the email notice names the new address', em.text.indexOf('new@example.com') >= 0);
    H.ok('and both say what to do if it was not you',
      pw.text.toLowerCase().indexOf('wasn\'t you') >= 0 && em.text.toLowerCase().indexOf('wasn\'t you') >= 0);
  }

  H.group('A username is escaped on its way into HTML');
  {
    const mail = load({ RESEND_API_KEY: 'rk_test', MAIL_FROM: 'x <a@b.test>', APP_URL: 'https://app.test' });
    // validUsername() would never let this through today. The templates should
    // not be the thing that depends on it.
    const evil = '<img src=x onerror=alert(1)>';
    const msg = mail.resetPassword('r@example.com', evil, 'https://app.test/?cv=reset&token=t');
    H.ok('no raw tag survives into the HTML', msg.html.indexOf('<img') < 0);
    H.ok('it is escaped instead', msg.html.indexOf('&lt;img') >= 0);
  }

  process.exit(H.report());
})();
