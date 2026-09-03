/* Convoy — static-asset cache policy (response headers only).

   Why this exists: index.html loads 45 JS/CSS files, every one of them stamped
   `?v=cyNNN`. The operating contract bumps ALL 45 stamps together on any web
   change and the push runbook refuses a mixed page, so a stamped URL behaves
   exactly like a content hash in the filename: the bytes behind it never change
   without the URL changing. That is the precondition `Cache-Control: immutable`
   needs — a browser may keep the file for a year and never ask about it again.

   Before this module every static response, stamped or not, went out
   `no-cache` with NO validator (no ETag, no Last-Modified), so a browser had
   nothing to revalidate against and a repeat visit re-downloaded ~342 KB
   gzipped / 1086 KB raw — the same cost as the first visit.

   The policy (pinned by test/httpcache.test.js with real round-trips, and by
   test/serverpolicy.test.js H1 for the wiring in server.js):

     request                          Cache-Control                        ETag  Last-Modified
     stamped (?v=cyNNN), switch on    public, max-age=31536000, immutable  yes   yes
     stamped, STATIC_IMMUTABLE=0      no-cache                             yes   yes
     unstamped (index.html, /, the    no-cache                             yes   yes
       legal pages, /convoy.apk, …)

   index.html is NEVER immutable. It is the unstamped entry point that names
   the current stamp; cache it for a year and no rider ever sees a new release,
   and the push runbook's served-stamp check starts lying. /convoy.apk is the
   same story. Neither carries a stamp, so the table above handles them with
   no special case — keep it that way rather than adding one.

   The validator is weak, built from size + mtime (the nginx / Express
   construction) and never from the body: the hot path is ONE fs.stat per
   request and a readFile only when a body is actually going out. With a
   validator, `no-cache` finally means what it says: the browser sends
   If-None-Match and gets a ~200-byte 304 instead of the file. That is also
   the kill switch's floor — STATIC_IMMUTABLE=0 restores the pre-cycle-54
   `no-cache` everywhere while KEEPING the ETag, so it is a strict improvement
   in every configuration.

   No env dependency beyond the switch, no Supabase, no store: this module is
   require()-able from a test with nothing configured, which is the reason the
   policy lives here and not inline in server.js's static handler (server.js
   exits at boot without Supabase config and cannot be required at all). */
'use strict';

// Kill switch. STATIC_IMMUTABLE=0 in convoy.env + a restart returns every
// static response to `no-cache` (today's behaviour, plus the ETag) with no
// code deploy. Read once at boot, like every other knob in server.js.
const IMMUTABLE_ENABLED = process.env.STATIC_IMMUTABLE !== '0';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

// A stamp is the `v=cy<digits>` PARAMETER, not a substring: `sv=cy118`,
// `v=cy` or `v=cy118x` must not make a URL immutable for a year.
const STAMP_RE = /(^|[?&])v=cy\d+(&|$)/;

function isStamped(query) {
  return typeof query === 'string' && STAMP_RE.test(query);
}

// W/"<size hex>-<mtime ms hex>": moves whenever the file's size or mtime does,
// costs one stat, hashes nothing.
function etagFor(stat) {
  const size = Math.max(0, Math.floor(Number(stat && stat.size) || 0));
  let ms = stat && stat.mtimeMs;
  if (ms == null && stat && stat.mtime) ms = new Date(stat.mtime).getTime();
  ms = Math.max(0, Math.floor(Number(ms) || 0));
  return 'W/"' + size.toString(16) + '-' + ms.toString(16) + '"';
}

// RFC 7232 If-None-Match: `*`, a comma-separated list, weak comparison (the
// W/ prefix is ignored on both sides — the browser may echo either form).
function stripWeak(tag) {
  return String(tag).trim().replace(/^W\//, '');
}
function matchesEtag(header, etag) {
  if (!header || !etag) return false;
  const h = String(header).trim();
  if (h === '*') return true;
  const want = stripWeak(etag);
  return h.split(',').some((t) => t.trim() !== '' && stripWeak(t) === want);
}

// The full header object for a 200 (with `type`) or a 304 (without — a 304
// carries no body, so no Content-Type). `immutable` defaults to the switch;
// tests pass it explicitly to drive both rows without re-requiring.
function headersFor(opts) {
  opts = opts || {};
  const immutable = opts.immutable === undefined ? IMMUTABLE_ENABLED : !!opts.immutable;
  const h = {};
  if (opts.type) h['Content-Type'] = opts.type;
  h['Cache-Control'] = (opts.stamped && immutable) ? IMMUTABLE : REVALIDATE;
  if (opts.etag) h['ETag'] = opts.etag;
  if (opts.mtime) {
    const d = new Date(opts.mtime);
    if (!isNaN(d.getTime())) h['Last-Modified'] = d.toUTCString();
  }
  return h;
}

module.exports = { isStamped, etagFor, matchesEtag, headersFor, IMMUTABLE_ENABLED };
