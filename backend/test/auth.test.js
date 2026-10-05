import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateOwnerToken,
  generateSessionToken,
  hashToken,
  timingSafeEquals,
  hashPassword,
  verifyPassword,
  validatePassword,
  validateEmail,
  normalizeEmail,
  hasValidApiKey,
  canDeleteLink,
} from '../lib/auth.js';

/** Minimal stand-in for the bits of an Express request that auth reads. */
function fakeReq(headers = {}) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  return { get: (name) => lower[name.toLowerCase()] };
}

const row = (overrides = {}) => ({
  id: '1',
  code: 'abc',
  user_id: null,
  owner_token: null,
  ...overrides,
});

// --- secrets -------------------------------------------------------------

test('generates high-entropy owner tokens', () => {
  const tokens = new Set();
  for (let i = 0; i < 1000; i++) tokens.add(generateOwnerToken());

  assert.equal(tokens.size, 1000);
  for (const token of tokens) {
    assert.equal(token.length, 43); // base64url of 32 bytes
    assert.match(token, /^[A-Za-z0-9_-]+$/);
  }
});

test('session tokens are unique and hash to a stable digest', () => {
  const token = generateSessionToken();
  const digest = hashToken(token);

  assert.equal(hashToken(token), digest, 'hashing must be deterministic');
  assert.notEqual(digest, token, 'the stored digest must not be the token');
  assert.equal(digest.length, 43);
  assert.notEqual(hashToken(generateSessionToken()), digest);
});

test('timingSafeEquals compares correctly', () => {
  assert.equal(timingSafeEquals('abc', 'abc'), true);
  assert.equal(timingSafeEquals('abc', 'abd'), false);
  assert.equal(timingSafeEquals('abc', 'abcd'), false, 'differing lengths must not match');
  assert.equal(timingSafeEquals('', ''), true);
  assert.equal(timingSafeEquals(null, 'abc'), false);
  assert.equal(timingSafeEquals('abc', undefined), false);
});

// --- passwords -----------------------------------------------------------

test('password hashes are salted, so identical passwords differ', () => {
  const a = hashPassword('correct horse battery staple');
  const b = hashPassword('correct horse battery staple');

  assert.notEqual(a, b, 'each hash must use a fresh salt');
  assert.equal(verifyPassword('correct horse battery staple', a), true);
  assert.equal(verifyPassword('correct horse battery staple', b), true);
});

test('stored hashes never contain the plaintext', () => {
  const stored = hashPassword('super-secret-passphrase');
  assert.ok(!stored.includes('super-secret-passphrase'));
  assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$[\w-]+\$[\w-]+$/);
});

test('verifies correct passwords and rejects wrong ones', () => {
  const stored = hashPassword('hunter2hunter2');

  assert.equal(verifyPassword('hunter2hunter2', stored), true);
  assert.equal(verifyPassword('hunter2hunter3', stored), false);
  assert.equal(verifyPassword('Hunter2Hunter2', stored), false, 'case sensitive');
  assert.equal(verifyPassword('', stored), false);
  assert.equal(verifyPassword(undefined, stored), false);
});

test('verifyPassword fails closed on malformed or hostile stored values', () => {
  for (const stored of [
    null,
    undefined,
    '',
    'not-a-hash',
    'scrypt$16384$8$1$onlyfourparts',
    'scrypt$abc$8$1$AAAA$AAAA',
    'bcrypt$16384$8$1$AAAA$AAAA',
    'scrypt$16384$8$1$AAAA$',
  ]) {
    assert.equal(verifyPassword('anything', stored), false, `${stored} must not verify`);
  }
});

// --- validation ----------------------------------------------------------

test('validates email addresses', () => {
  for (const good of ['a@b.co', 'user.name+tag@example.com', 'UPPER@Example.COM']) {
    assert.equal(validateEmail(good), null, `${good} should be accepted`);
  }

  for (const bad of ['', 'nope', 'no@domain', '@example.com', 'a@b', 'a b@c.com', null]) {
    assert.ok(validateEmail(bad), `${bad} should be rejected`);
  }

  assert.ok(validateEmail(`${'a'.repeat(250)}@example.com`), 'over-long email rejected');
});

test('normalizes emails for consistent lookups', () => {
  assert.equal(normalizeEmail('  User@Example.COM '), 'user@example.com');
  assert.equal(normalizeEmail(null), '');
});

test('enforces password length bounds', () => {
  assert.equal(validatePassword('longenough1'), null);
  assert.ok(validatePassword('short1'), 'too short rejected');
  assert.ok(validatePassword('x'.repeat(201)), 'over-long rejected, since scrypt is slow');
  assert.ok(validatePassword(null));
});

// --- request authorisation ----------------------------------------------

test('api key check is inert when no key is configured', () => {
  assert.equal(hasValidApiKey(fakeReq(), ''), false);
  assert.equal(hasValidApiKey(fakeReq({ 'x-api-key': 'anything' }), ''), false);
});

test('api key check accepts only the exact key', () => {
  const req = fakeReq({ 'x-api-key': 'master' });
  assert.equal(hasValidApiKey(req, 'master'), true);
  assert.equal(hasValidApiKey(req, 'maste'), false);
  assert.equal(hasValidApiKey(req, 'Master'), false);
  assert.equal(hasValidApiKey(fakeReq(), 'master'), false);
});

test('guest deletion requires the matching owner token', () => {
  const token = generateOwnerToken();

  assert.equal(canDeleteLink(fakeReq(), row({ owner_token: token }), null, ''), false);
  assert.equal(
    canDeleteLink(fakeReq({ 'x-owner-token': 'wrong' }), row({ owner_token: token }), null, ''),
    false
  );
  assert.equal(
    canDeleteLink(fakeReq({ 'x-owner-token': token }), row({ owner_token: token }), null, ''),
    true
  );
});

test('account deletion matches user_id, and bigint strings compare correctly', () => {
  // Postgres returns bigint as a string, so String() coercion matters here.
  const link = row({ user_id: '42' });

  assert.equal(canDeleteLink(fakeReq(), link, { id: '42' }, ''), true);
  assert.equal(canDeleteLink(fakeReq(), link, { id: 42 }, ''), true);
  assert.equal(canDeleteLink(fakeReq(), link, { id: '43' }, ''), false);
  assert.equal(canDeleteLink(fakeReq(), link, null, ''), false);
});

test('an account session does not unlock another account’s link', () => {
  const link = row({ user_id: '7', owner_token: 'guest-secret' });
  assert.equal(canDeleteLink(fakeReq(), link, { id: '8' }, ''), false);
});

test('legacy rows with neither owner nor account are operator-only', () => {
  assert.equal(canDeleteLink(fakeReq(), row(), { id: '1' }, ''), false);
  assert.equal(canDeleteLink(fakeReq({ 'x-owner-token': 'x' }), row(), { id: '1' }, ''), false);
  assert.equal(canDeleteLink(fakeReq({ 'x-api-key': 'master' }), row(), { id: '1' }, 'master'), true);
});

test('the operator key overrides every other check', () => {
  const link = row({ user_id: '7', owner_token: 'guest' });
  const req = fakeReq({ 'x-api-key': 'master', 'x-owner-token': 'wrong' });
  assert.equal(canDeleteLink(req, link, { id: '999' }, 'master'), true);
});