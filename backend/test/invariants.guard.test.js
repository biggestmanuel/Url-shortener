/**
 * Structural guards for the security invariants recorded in AGENTS.md.
 *
 * These read the source as text rather than exercising behaviour. That is
 * deliberate: each invariant is a *shape* requirement that unit tests cannot
 * see, and each one corresponds to a mistake that actually shipped here.
 *
 *   1. Emailed tokens must be in the URL fragment, not the path.
 *   2. Single-use tokens must be spent by one conditional statement.
 *   3. Nothing from the database may reach innerHTML.
 *   4. Secrets at rest are digests, not values.
 *   5. Boolean env vars must not be parsed with Boolean().
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Reads a source file with line endings normalised to LF.
 *
 * Git converts LF to CRLF on a Windows checkout, and the comment-stripping
 * regexes below use `.*$`, which cannot cross a `\r`. Reading raw made these
 * guards pass locally and fail on a fresh clone — exactly the kind of "works
 * on my machine" gap they exist to prevent.
 */
const read = async (rel) => (await readFile(path.join(root, rel), 'utf8')).replace(/\r\n?/g, '\n');

const [serverSrc, tokensSrc, appSrc, authSrc, schemaSrc, escapeSrc] = await Promise.all([
  read('backend/server.js'),
  read('backend/lib/tokens.js'),
  read('app.js'),
  read('backend/lib/auth.js'),
  read('backend/schema.sql'),
  read('escape.js'),
]);

// --- 1. Emailed tokens live in the fragment -----------------------------

test('emailed action links are hash routes, not paths', () => {
  // A path link is matched by the /:code catch-all and 404s as an unknown
  // short code. That was a real shipping bug.
  assert.match(
    serverSrc,
    /frontendActionLink[\s\S]{0,200}frontendBaseUrl\}\/#\/\$\{route\}\?token=/,
    'emailed links must be built as <frontend>/#/<route>?token='
  );

  assert.doesNotMatch(
    serverSrc,
    /resetLinkFor[\s\S]{0,120}reset-password\?token=/,
    'do not build /reset-password?token=... — use the hash form'
  );
});

test('the frontend reads its action route from the fragment', () => {
  assert.match(appSrc, /window\.location\.hash/, 'routes must be read from location.hash');
  assert.match(appSrc, /route === 'reset-password'/);
  assert.match(appSrc, /route === 'verify-email'/);
});

test('the hash is cleared without adding a history entry', () => {
  // Otherwise Back re-submits a spent token, or a reload does.
  assert.match(appSrc, /history\.replaceState/);
  assert.doesNotMatch(appSrc, /location\.hash = ''/, 'assigning to hash adds a history entry');
});

// --- 2. Tokens are spent atomically -------------------------------------

test('reset tokens are consumed by one conditional UPDATE, not SELECT then UPDATE', () => {
  // Two round trips is a race: concurrent requests both pass the "still
  // unused?" check and both succeed.
  const consume = tokensSrc.slice(tokensSrc.indexOf('export async function consumePasswordReset'));

  assert.match(consume, /UPDATE\s+password_resets/i, 'must spend the token with an UPDATE');
  assert.match(consume, /RETURNING/i, 'must RETURN the row so no second query is needed');
  assert.match(consume, /used_at IS NULL/, 'the claim must be conditional');
  assert.match(
    consume,
    /DELETE FROM sessions WHERE user_id/i,
    'a reset must revoke every session for the account'
  );

  assert.doesNotMatch(
    consume,
    /SELECT[\s\S]*?FROM password_resets[\s\S]*?LIMIT 1/i,
    'do not SELECT the token first and UPDATE afterwards — that is the race'
  );
});

test('verification tokens are consumed by one conditional UPDATE', () => {
  const consume = tokensSrc.slice(tokensSrc.indexOf('export async function consumeEmailVerification'));

  assert.match(consume, /UPDATE\s+email_verifications/i);
  assert.match(consume, /RETURNING/i);
  assert.match(consume, /used_at IS NULL/);
  assert.doesNotMatch(
    consume,
    /SELECT[\s\S]*?FROM email_verifications[\s\S]*?LIMIT 1/i,
    'do not SELECT then UPDATE'
  );
});

test('issuing a new token invalidates any outstanding one', () => {
  assert.match(tokensSrc, /UPDATE password_resets[\s\S]{0,200}used_at IS NULL/);
  assert.match(tokensSrc, /UPDATE email_verifications[\s\S]{0,200}used_at IS NULL/);
});

// --- 3. No database value reaches innerHTML -----------------------------

test('the render path never assigns a dynamic value to innerHTML', () => {
  // Bound the capture at the statement terminator, or it runs on into
  // unrelated code and reports a false positive.
  const assignments = [...appSrc.matchAll(/(\w+)\.innerHTML\s*=\s*([^;]{0,200})/g)].map((m) => ({
    target: m[1],
    expr: m[2].trim(),
  }));

  // The only things allowed on the right-hand side: an empty string, a
  // template literal of author-written markup whose interpolations are all
  // escaped, or a named icon constant.
  const ICON_CONSTANTS = [
    'PLACEHOLDER_ICON',
    'COPY_ICON',
    'QR_ICON',
    'SHARE_ICON',
    'TRASH_ICON',
    'CLOCK_ICON',
    'iconSvg',
    'icon', // iconButton()'s parameter, always a literal from this file
  ];

  for (const { target, expr } of assignments) {
    const isEmpty = expr === "''" || expr === '""' || expr === '``';
    const isNamedConstant = ICON_CONSTANTS.some((name) => expr.includes(name));

    // A template literal is safe only if every `${...}` is escaped.
    let everyInterpolationEscaped = true;
    for (const [, interpolation] of expr.matchAll(/\$\{([\s\S]*?)\}/g)) {
      if (!interpolation.includes('escapeHtml(') && !ICON_CONSTANTS.some((n) => interpolation.includes(n))) {
        everyInterpolationEscaped = false;
      }
    }

    assert.ok(
      isEmpty || isNamedConstant || (expr.startsWith('`') && everyInterpolationEscaped),
      `app.js assigns a dynamic value to ${target}.innerHTML:\n  ${expr}\n` +
        'Render with DOM APIs and textContent instead, or escape every interpolation.'
    );
  }

  // Sanity: the guard must actually be looking at something.
  assert.ok(assignments.length > 0, 'expected at least one innerHTML assignment to inspect');
});

test('the escaper still covers quotes, not just angle brackets', () => {
  // The original defect: `& < >` were escaped, `"` was not, and destination
  // URLs were interpolated into title="...", so a quote broke out.
  assert.ok(escapeSrc.includes("'&': '&amp;'"), 'ampersand must be escaped');
  assert.ok(escapeSrc.includes("'\"': '&quot;'"), 'double quote must be escaped');
  assert.ok(escapeSrc.includes("\"'\": '&#39;'"), 'single quote must be escaped');

  const trigger = escapeSrc.match(/NEEDS_ESCAPE\s*=\s*(\/\[[^\n]+\/)/);
  assert.ok(trigger, 'NEEDS_ESCAPE must be a character class');
  for (const ch of ['&', '<', '>', '"', "'"]) {
    assert.ok(trigger[1].includes(ch), `"${ch}" must be in the trigger class ${trigger[1]}`);
  }
});

test('link cards are assembled with DOM APIs', () => {
  // createElement + textContent, not innerHTML.
  assert.match(appSrc, /document\.createElement\('article'\)/);
  assert.match(appSrc, /original\.textContent = link\.destinationUrl/);
  assert.match(appSrc, /shortLink\.textContent = link\.shortUrl/);
  // and no template-literal HTML containing a link field
  assert.doesNotMatch(
    appSrc,
    /innerHTML\s*=\s*`[^`]*\$\{link\./,
    'never interpolate a link field into an HTML string'
  );
});

test('exported CSV neutralises formula injection', () => {
  assert.match(appSrc, /escapeCsvValue\(/);
  assert.match(appSrc, /function csvCell/);

  const prefix = escapeSrc.match(/return\s*(\/\^\[[^\n]+\/)\.test\(str\)/);
  assert.ok(prefix, 'escapeCsvValue must test the leading characters');
  for (const ch of ['=', '+', '-', '@', '\\t', '\\r']) {
    assert.ok(prefix[1].includes(ch), `${ch} must be neutralised, got ${prefix[1]}`);
  }
});

// --- 4. Secrets at rest are digests -------------------------------------

test('session and token tables store digests, and the schema backs it', () => {
  for (const table of ['sessions', 'password_resets', 'email_verifications']) {
    assert.match(
      schemaSrc,
      new RegExp(`create table if not exists ${table}[\\s\\S]{0,400}token_hash`),
      `${table} must store a token_hash digest`
    );
    assert.doesNotMatch(
      schemaSrc,
      new RegExp(`create table if not exists ${table}[\\s\\S]{0,400}\\btoken\\s+text`),
      `${table} must not have a plaintext token column`
    );
  }
});

test('sessions, reset and verification tokens are hashed before insert', () => {
  // Every write of a credential must pass it through hashToken() or
  // hashPurposeToken(), never the raw value. These inserts live in both
  // server.js (sessions) and lib/tokens.js (resets, verifications).
  const sources = { 'server.js': serverSrc, 'lib/tokens.js': tokensSrc };
  let inspected = 0;

  for (const [file, src] of Object.entries(sources)) {
    const writes = [
      ...src.matchAll(
        /INSERT INTO (sessions|password_resets|email_verifications)\s*\(([^)]*)\)[\s\S]{0,160}?VALUES\s*\([^)]*\)[\s\S]{0,240}?\n\s*\[([\s\S]{0,240}?)\]/g
      ),
    ];

    for (const [, table, columns, values] of writes) {
      inspected++;

      // Only the token column matters; user_id and expires_at are not secrets.
      const colNames = columns.split(',').map((c) => c.trim());
      const index = colNames.indexOf('token_hash');
      assert.notEqual(index, -1, `${file}: ${table} should insert into token_hash`);

      const boundValues = values.split(',').map((v) => v.trim());
      const bound = boundValues[index];

      assert.ok(bound, `${file}: ${table} has no value bound for token_hash`);
      assert.match(
        bound,
        /digest|hash/i,
        `${file}: ${table}.token_hash is bound to "${bound}", which is not a digest`
      );
      assert.notEqual(
        bound,
        'token',
        `${file}: ${table}.token_hash is bound to the raw token`
      );
    }
  }

  assert.ok(inspected >= 3, `expected all three credential inserts, inspected ${inspected}`);
});

test('every issued credential is digested where it is generated', () => {
  // The insert receives a local named `digest`; this is where that local is
  // proven to come from a real hash rather than the raw token.
  for (const fn of [
    'export function generatePurposeToken',
    'export async function issuePasswordReset',
    'export async function issueEmailVerification',
    'export async function consumePasswordReset',
    'export async function consumeEmailVerification',
  ]) {
    const start = tokensSrc.indexOf(fn);
    assert.notEqual(start, -1, `${fn} must exist`);
    const body = tokensSrc.slice(start, start + 1400);

    assert.match(
      body,
      /hashPurposeToken\(/,
      `${fn} must digest with hashPurposeToken()`
    );
  }

  assert.match(authSrc, /hashToken\(/, 'sessions must be digested with hashToken()');
});

test('passwords are scrypt-hashed with a per-password salt', () => {
  assert.match(authSrc, /scrypt/);
  assert.match(authSrc, /randomBytes/);
  assert.match(schemaSrc, /password_hash/);
  assert.doesNotMatch(schemaSrc, /password\s+text/, 'no plaintext password column');
});

// --- 5. Env var parsing -------------------------------------------------

test('no boolean env var is parsed with Boolean()', () => {
  // Boolean('false') is true, which shipped a rate-limit bypass via
  // TRUST_PROXY. Use boolEnv().
  const offenders = [...serverSrc.matchAll(/(\w+)\s*=\s*Boolean\(process\.env\.([A-Z_0-9]+)\)/g)];

  assert.deepEqual(
    offenders.map((m) => `${m[1]} <- ${m[2]}`),
    [],
    'use boolEnv() for boolean env vars; Boolean("false") is true'
  );
  assert.match(serverSrc, /function boolEnv/, 'boolEnv must exist');
});

test('requireApiKeyToCreate compares explicitly rather than coercing', () => {
  assert.match(serverSrc, /REQUIRE_API_KEY_TO_CREATE === 'true'/);
});

test('the 0-disables setting does not use the positive-only parser', () => {
  // numEnv treats 0 as unset and falls back, which silently ignored
  // SESSION_SWEEP_MINUTES=0.
  assert.match(serverSrc, /nonNegativeEnv\('SESSION_SWEEP_MINUTES'/);
  assert.match(serverSrc, /function nonNegativeEnv/);
});

test('a production boot fails loudly on a broken configuration', () => {
  // The silent failure this prevents: production starts, reports healthy, and
  // every generated link points at localhost.
  assert.match(serverSrc, /findFatalConfigProblems/, 'the fatal check must be called at boot');
  assert.match(serverSrc, /process\.exit\(1\)/, 'a fatal config problem must stop the process');

  // ...and it must run before the port is bound, or the server briefly accepts
  // traffic it is about to refuse to serve.
  const fatalAt = serverSrc.indexOf('findFatalConfigProblems()');
  const listenAt = serverSrc.indexOf('app.listen(');
  assert.ok(fatalAt > 0 && listenAt > 0);
  assert.ok(
    fatalAt < listenAt,
    'the production guard must run before app.listen(), not after'
  );
});

test('the loopback guard is waived only by an explicit true', () => {
  const config = readFileSync(path.join(root, 'backend/lib/config.js'), 'utf8').replace(
    /\r\n?/g,
    '\n'
  );

  // Must be a membership test against the documented spellings, so that
  // ALLOW_LOOPBACK_BASE_URL=false does not waive the check — Boolean('false')
  // is true, which is the exact bug that shipped for TRUST_PROXY.
  assert.match(
    config,
    /\['1',\s*'true',\s*'yes',\s*'on'\]\.includes\([\s\S]{0,160}ALLOW_LOOPBACK_BASE_URL/,
    'the override must test the strict boolean spellings'
  );
  assert.doesNotMatch(
    config,
    /Boolean\(\s*(env\.)?ALLOW_LOOPBACK_BASE_URL/,
    'never coerce this with Boolean(); "false" is truthy'
  );
});

// --- Favicon SSRF boundary ----------------------------------------------

test('the favicon proxy refuses internal addresses in every notation', async () => {
  const { isValidDomain } = await import('../lib/favicon.js');

  const mustRefuse = [
    'localhost',
    '127.0.0.1',
    '127.1',
    '0177.0.0.1',
    '0x7f000001',
    '0x7f.0.0.1',
    '10.0.0.5',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
  ];

  for (const host of mustRefuse) {
    assert.equal(isValidDomain(host), false, `${host} must be refused`);
  }

  // ...and public hosts, including the RFC1918 boundaries, must still work.
  for (const host of ['example.com', '8.8.8.8', '172.15.0.1', '172.32.0.1', '11.0.0.1']) {
    assert.equal(isValidDomain(host), true, `${host} must be accepted`);
  }
});

test('favicon redirects are followed manually, not by the runtime', async () => {
  const favicon = await read('backend/lib/favicon.js');

  // Strip comments first: the source explains *why* 'follow' is wrong, so a
  // naive search finds the word inside its own justification.
  const code = favicon
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');

  assert.doesNotMatch(
    code,
    /redirect:\s*'follow'/,
    "redirect: 'follow' hides intermediate hops from the private-address checks"
  );
  assert.match(code, /redirect:\s*'manual'/);
  assert.match(favicon, /function followRedirects/);
});

test('the favicon cache is bounded', async () => {
  const favicon = await import('../lib/favicon.js');
  const { resolveFavicon, clearFaviconCache, faviconCacheSize } = favicon;

  clearFaviconCache();
  const fetchImpl = async () => ({
    ok: false,
    status: 404,
    url: '',
    headers: { get: () => null },
  });

  for (let i = 0; i < 2200; i++) {
    await resolveFavicon(`host${i}.example.com`, { fetchImpl });
  }

  assert.ok(faviconCacheSize() <= 2048, `cache must be bounded, got ${faviconCacheSize()}`);
  clearFaviconCache();
});

// --- Ownership ----------------------------------------------------------

test('deleting a link is authorised, not merely authenticated', () => {
  // bigserial ids are enumerable, so "is anyone logged in" is not enough.
  assert.match(serverSrc, /canDeleteLink/);
  assert.match(serverSrc, /function isValidLinkId/, 'a non-numeric bigint id must not reach SQL');
  assert.match(serverSrc, /INVALID_TEXT_REPRESENTATION/, '22P02 must be a 4xx, not a 500');
});

test('listing links is scoped to the caller', () => {
  assert.match(serverSrc, /user_id = \$1[\s\S]{0,80}ORDER BY created_at DESC/, 'list must filter by owner');
});

test('owner_token is documented as plaintext, not hashed', () => {
  // It is stored in the clear on purpose: you cannot verify a digest you
  // cannot reproduce. A future session should not "fix" this silently.
  assert.match(schemaSrc, /owner_token text/, 'owner_token stays a plaintext column');
});
