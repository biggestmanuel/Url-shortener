/**
 * Escaping tests.
 *
 * These exist because of a real stored-XSS bug: the original escapeHtml used
 * a detached <div> and textContent, which escapes < > & but NOT quotes.
 * Destination URLs reach the DOM inside title="..." attributes, so a URL
 * containing a double quote could break out and inject event handlers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { escapeHtml, escapeCsvValue } = require('../../escape.js');

test('escapes the characters that matter in HTML', () => {
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('"'), '&quot;');
  assert.equal(escapeHtml("'"), '&#39;');
});

test('escapes both quote styles (the stored-XSS regression)', () => {
  const attack = 'https://evil.example.com/" onmouseover="alert(1)';
  const escaped = escapeHtml(attack);

  assert.ok(!escaped.includes('"'), 'no raw double quote may survive');
  assert.ok(!escaped.includes("'"), 'no raw single quote may survive');
  assert.ok(escaped.includes('&quot;'));

  // In `title="..."` the value must not be able to terminate the attribute.
  // Splitting on the delimiter has to yield exactly one part.
  const rendered = `title="${escaped}"`;
  assert.equal(rendered.split('"').length - 1, 2, 'exactly two quotes: the delimiters');
});

test('cannot be used to close a tag or open a new attribute', () => {
  for (const payload of [
    '"><script>alert(1)</script>',
    "'><img src=x onerror=alert(1)>",
    '"><svg/onload=alert(1)>',
    'javascript:alert(1)',
  ]) {
    const out = escapeHtml(payload);
    assert.ok(!/[<>]/.test(out), `raw angle bracket survived: ${payload}`);
    assert.ok(!/"/.test(out) && !/'/.test(out), `raw quote survived: ${payload}`);
  }
});

test('handles non-string and empty input', () => {
  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(false), 'false');
});

test('is idempotent enough to be safe when applied twice', () => {
  const once = escapeHtml('a & <b>');
  assert.equal(once, 'a &amp; &lt;b&gt;');
  // Applying twice double-escapes the ampersand, which is expected and
  // harmless; what matters is that it never produces a raw delimiter.
  assert.ok(!/[<>"']/.test(escapeHtml(once)));
});

test('escapeCsvValue neutralises spreadsheet formula injection', () => {
  // Excel/Sheets execute cells starting with these characters.
  for (const payload of [
    '=1+1',
    '=HYPERLINK("http://evil","click")',
    '+1+1',
    '-1+1',
    '@SUM(A1:A2)',
    '\t=cmd',
    '\r=cmd',
  ]) {
    const out = escapeCsvValue(payload);
    assert.ok(out.startsWith("'"), `${JSON.stringify(payload)} was not neutralised`);
  }
});

test('escapeCsvValue leaves ordinary values untouched', () => {
  assert.equal(escapeCsvValue('https://example.com/page'), 'https://example.com/page');
  assert.equal(escapeCsvValue('my-slug'), 'my-slug');
  assert.equal(escapeCsvValue('3Fk9xY'), '3Fk9xY');
  assert.equal(escapeCsvValue('2026-01-01T00:00:00.000Z'), '2026-01-01T00:00:00.000Z');
  assert.equal(escapeCsvValue('50%'), '50%');
  assert.equal(escapeCsvValue(''), '');
  assert.equal(escapeCsvValue(null), '');
});

test('escapeCsvValue keeps URLs that merely contain an equals sign', () => {
  // Only a *leading* = is dangerous; query strings must survive intact.
  const url = 'https://example.com/p?a=1&b=2';
  assert.equal(escapeCsvValue(url), url);
});