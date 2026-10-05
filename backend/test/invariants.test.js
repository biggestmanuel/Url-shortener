import test from 'node:test';
import assert from 'node:assert/strict';

// escape.js is a UMD/CommonJS shim (so index.html works from file://), so it
// has to be pulled in as a default export rather than a named one.
import LinklyEscape from '../../escape.js';

const { escapeCsvValue } = LinklyEscape;
import {
  normalizeEmail,
  validateEmail,
  validatePassword,
  hashPassword,
  verifyPassword,
} from '../lib/auth.js';

const FORMULAS = [
  '=1+1',
  '=cmd|\' /c calc\'!A0',
  '@SUM(1+1)',
  '+1+1',
  '-1+1',
  '=HYPERLINK("http://evil.example","x")',
  '\t=1+1',
  '\r=1+1',
  "=IMPORTXML(concat('http://evil/', 'x'), '//a')",
  "=DDE(calc, system, cmd|' /C calc'!A0)",
];

test('every classic injection payload is neutralised by the real escaper', () => {
  // Assert against escapeCsvValue itself, not against a copy of its regex.
  // The previous version duplicated the character class into the test, so it
  // kept passing even after escape.js stopped matching on any of them.
  for (const payload of FORMULAS) {
    const escaped = escapeCsvValue(payload);

    assert.ok(
      escaped.startsWith("'"),
      `${JSON.stringify(payload)} must be prefixed so Excel treats it as text`
    );
    assert.ok(
      escaped.endsWith(payload),
      `${JSON.stringify(payload)} must be preserved after the prefix, got ${JSON.stringify(escaped)}`
    );
  }
});

test('an ordinary value is left untouched', () => {
  // The other half of the contract: prefixing everything would corrupt normal
  // URLs and codes, which is how a fix like this usually goes wrong.
  for (const safe of [
    'https://example.com/page?a=1',
    'abc123',
    '2026-01-02T03:04:05Z',
    'a-leading-dash-in-the-middle',
  ]) {
    assert.equal(escapeCsvValue(safe), safe, `${safe} must not be modified`);
  }
});

test('email normalisation is idempotent', () => {
  const once = normalizeEmail('  User@Example.COM  ');
  assert.equal(once, 'user@example.com');
  assert.equal(normalizeEmail(once), once);
});

test('email validation accepts normalised addresses', () => {
  assert.equal(validateEmail('  USER@Example.com '), null);
});

test('passwords that pass length validation are verifiable', () => {
  const password = 'correct horse 42';

  assert.equal(validatePassword(password), null, 'must pass validation');

  const stored = hashPassword(password);
  assert.equal(verifyPassword(password, stored), true);
});

test('a password that fails validation would never be stored', () => {
  // Guards the ordering assumption in the register handler: validation runs
  // before hashing, so an over-long password never reaches scrypt.
  const tooLong = 'x'.repeat(201);
  assert.ok(validatePassword(tooLong));
  assert.notEqual(validatePassword(tooLong), null);
});