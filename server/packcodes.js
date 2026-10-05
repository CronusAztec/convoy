/* Convoy — feature-pack unlock codes: mint, normalise, hash.

   A code is what an operator hands to a reviewer, a club or a beta cohort to
   unlock one or more feature packs on their account (see
   migrations/004_feature_packs.sql and server/packs/index.js). It is the only
   secret in the pack system, so its shape is chosen for the two things that
   matter: enough entropy that guessing is hopeless (16 symbols from a
   31-letter alphabet ≈ 79 bits, behind a per-account and per-IP rate limit),
   and an alphabet a person can read back over the phone — no 0/O, no 1/I/L.

   Only the SHA-256 of the normalised text is stored (pack_codes.code_hash).
   That is deliberate: with ~79 random bits there is nothing for a slow hash to
   add, and a plain digest keeps the lookup a single indexed equality. */
'use strict';
const crypto = require('crypto');

// 31 symbols: A–Z without I, L and O; digits 2–9. Nothing that reads as
// something else in a bad font or a hurried voice.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LENGTH = 16;
const PREFIX = 'CONVOY';

function mint() {
  let s = '';
  for (let i = 0; i < LENGTH; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return PREFIX + '-' + s.match(/.{4}/g).join('-');
}

// Case, dashes, spaces and the CONVOY prefix are all presentation. Returns the
// bare 16 symbols, or '' when what came in cannot be a code at all — callers
// treat '' as "not a code" and never hash it.
function normalize(raw) {
  let s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.indexOf(PREFIX) === 0) s = s.slice(PREFIX.length);
  if (s.length !== LENGTH) return '';
  for (let i = 0; i < s.length; i++) if (ALPHABET.indexOf(s[i]) < 0) return '';
  return s;
}

function hash(normalized) {
  return crypto.createHash('sha256').update('convoy-pack:' + normalized).digest('hex');
}

function looksValid(raw) { return normalize(raw) !== ''; }

module.exports = { mint, normalize, hash, looksValid, ALPHABET, LENGTH, PREFIX };
