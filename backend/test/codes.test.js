import test from 'node:test';
import assert from 'node:assert/strict';

import { randomBase62, generateShortCode, isValidCode, ALIAS_PATTERN } from '../lib/codes.js';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

test('generates codes of the requested length', () => {
  for (const length of [1, 6, 7, 12]) {
    const code = randomBase62(length);
    assert.equal(code.length, length);
    assert.match(code, /^[0-9A-Za-z]+$/);
  }
});

test('generateShortCode defaults to 7 characters', () => {
  assert.equal(generateShortCode().length, 7);
});

test('rejects invalid lengths', () => {
  for (const length of [0, -1, 1.5, 'x', null]) {
    assert.throws(() => randomBase62(length), /positive integer/);
  }
});

test('produces distinct codes across many draws', () => {
  const seen = new Set();
  for (let i = 0; i < 20_000; i++) seen.add(generateShortCode());
  // 62^7 is ~3.5e12, so collisions in 20k draws would mean a real bias bug.
  assert.equal(seen.size, 20_000);
});

test('rejection sampling keeps the alphabet roughly uniform', () => {
  const counts = new Map([...ALPHABET].map((c) => [c, 0]));
  const draws = 62_000;

  for (let i = 0; i < draws; i++) {
    for (const ch of generateShortCode()) {
      counts.set(ch, counts.get(ch) + 1);
    }
  }

  const perChar = draws * 7 / ALPHABET.length;
  for (const [char, count] of counts) {
    const ratio = count / perChar;
    // A modulo-biased generator skews the low characters noticeably.
    assert.ok(ratio > 0.95 && ratio < 1.05, `${char} skewed at ${ratio.toFixed(3)}`);
  }
});

test('isValidCode accepts generated codes and rejects junk', () => {
  assert.equal(isValidCode('3Fk9xY'), true);
  assert.equal(isValidCode('a_b-C9'), true);
  assert.equal(isValidCode('a'.repeat(64)), true);

  for (const bad of ['', 'a'.repeat(65), 'has space', 'sym$bol', 'slash/es', '../etc', null, 42]) {
    assert.equal(isValidCode(bad), false, `${bad} should be invalid`);
  }
});

test('alias pattern matches the documented rules', () => {
  for (const good of ['abc', 'my-slug', 'my_slug', 'A1'.padEnd(3, 'x'), 'a'.repeat(30)]) {
    assert.equal(ALIAS_PATTERN.test(good), true, `${good} should be accepted`);
  }

  for (const bad of ['ab', 'a'.repeat(31), 'has space', 'sym$bol', 'sl/ash', 'dots.here', '']) {
    assert.equal(ALIAS_PATTERN.test(bad), false, `${bad} should be rejected`);
  }
});