/**
 * Frontend asset integrity.
 *
 * These are silent failures: a broken reference or an undefined custom
 * property produces no console error and no test failure, it just renders
 * wrong. Each check here corresponds to a real bug that shipped.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile, access as accessAsync } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Normalises line endings before any line-anchored matching.
 *
 * Git converts LF to CRLF on a Windows checkout. The comment regexes here use
 * `.*$`, and `.` cannot match `\r`, so on a fresh clone the comments survived
 * stripping and a variable mentioned only in prose looked undefined — these
 * checks would fail on a clone while passing in the working tree.
 */
const normalise = (text) => text.replace(/\r\n?/g, '\n');

const [cssRaw, html] = await Promise.all([
  readFile(path.join(root, 'styles.css'), 'utf8'),
  readFile(path.join(root, 'index.html'), 'utf8'),
]);
const css = normalise(cssRaw);

/** Strips comments, so a variable named inside prose is not counted as used. */
const stripCssComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('every CSS custom property that is used is also defined', () => {
  const code = stripCssComments(css);

  const defined = new Set(
    [...code.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1].toLowerCase())
  );
  const used = new Set(
    [...code.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1].toLowerCase())
  );

  const undefinedVars = [...used].filter((name) => !defined.has(name)).sort();

  // `var(--accent-primary)` resolves to nothing at computed-value time, so the
  // declaration using it is dropped entirely. That silently cost the auth
  // inputs their background and their entire focus ring.
  assert.deepEqual(
    undefinedVars,
    [],
    `styles.css uses undefined custom properties: ${undefinedVars.join(', ')}. ` +
      'A var() with no matching declaration is dropped, not ignored.'
  );

  assert.ok(defined.size > 20, 'expected the theme tokens to still be declared');
});

test('every theme-specific token is overridden for dark mode', () => {
  // Fonts, radii and transitions are theme-agnostic and correctly live only in
  // :root. Colours are not: a colour token that :root defines but body.dark
  // does not override keeps its light value in dark mode, which reads as a
  // styling bug nobody can reproduce.
  const root = css.slice(css.indexOf(':root {'), css.indexOf('body.dark {'));
  const dark = css.slice(css.indexOf('body.dark {'));

  const tokensIn = (block) =>
    new Set([...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

  const THEME_SPECIFIC = /color|bg|text|border|primary|success|danger|warning|shadow|glow|gradient/;

  const lightTokens = tokensIn(root);
  const darkTokens = tokensIn(dark);

  const missingInDark = [...lightTokens]
    .filter((t) => THEME_SPECIFIC.test(t) && !darkTokens.has(t))
    .sort();

  assert.deepEqual(
    missingInDark,
    [],
    `body.dark does not override: ${missingInDark.join(', ')} — these keep their light values in dark mode`
  );
});

test('dark mode only overrides tokens that exist in the light theme', () => {
  // A typo in a body.dark override silently does nothing, so the value from
  // :root is used and the cause is invisible.
  const root = css.slice(css.indexOf(':root {'), css.indexOf('body.dark {'));
  const dark = css.slice(css.indexOf('body.dark {'));

  const tokensIn = (block) =>
    new Set([...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

  const unknownToLight = [...tokensIn(dark)].filter((t) => !tokensIn(root).has(t)).sort();

  assert.deepEqual(
    unknownToLight,
    [],
    `body.dark redefines tokens :root never declares: ${unknownToLight.join(', ')}`
  );
});

test('the theme toggle has a rule for every state it can produce', () => {
  // applyTheme() toggles .dark on <body>, so both states must be styled.
  assert.match(css, /body\.dark\s*\{/, 'body.dark must exist');
  assert.match(css, /:root\s*\{/, ':root must exist');
});

test('the stylesheet is structurally balanced', () => {
  const open = (stripCssComments(css).match(/\{/g) ?? []).length;
  const close = (stripCssComments(css).match(/\}/g) ?? []).length;

  assert.equal(open, close, `unbalanced braces: ${open} open, ${close} close`);
});

test('every file index.html loads actually exists', async () => {
  // A missing file 404s silently; the page just comes up unstyled or inert.
  const referenced = [
    ...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+)"/g),
  ]
    .map((m) => m[1])
    .filter((href) => !/^(https?:)?\/\//.test(href) && !href.startsWith('data:'));

  assert.ok(referenced.length >= 3, `expected several assets, found ${referenced.length}`);

  for (const href of referenced) {
    const target = path.join(root, href.split(/[?#]/)[0]);
    await assert.doesNotReject(
      () => accessAsync(target),
      `index.html references ${href}, which does not exist`
    );
  }
});

test('the browser bundle stays dependency-free', () => {
  // The whole point of this project: no runtime dependencies in the browser.
  // A stray <script src="https://…"> or import from node_modules would break
  // the "open index.html and it runs" promise.
  const external = [
    ...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="(https?:\/\/[^"]+)"/g),
  ].map((m) => m[1]);

  const allowedExternal = [
    'fonts.googleapis.com', // webfonts, loaded with <link>, degrades gracefully
    'fonts.gstatic.com',
  ];

  for (const url of external) {
    const host = new URL(url).host;
    assert.ok(
      allowedExternal.includes(host),
      `index.html loads a script or stylesheet from ${host}, which is a runtime dependency`
    );
  }

  // No module imports in the app scripts, or file:// would break.
  for (const file of ['app.js', 'qr.js', 'escape.js']) {
    assert.doesNotMatch(
      readFileSync(path.join(root, file), 'utf8'),
      /^\s*import\s.+\sfrom\s/m,
      `${file} uses an ESM import; the browser bundle must stay classic scripts`
    );
  }
});
