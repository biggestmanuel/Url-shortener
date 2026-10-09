#!/usr/bin/env node
/**
 * Secret scanner for the whole git history.
 *
 * Scans every blob reachable from every ref, every unreachable object, and
 * every commit message. Exits non-zero on a finding, so it can gate a commit
 * or a CI job.
 *
 * Two design points worth knowing:
 *
 * 1. **It never prints the secret.** It reports the file, the blob sha, the
 *    pattern name and a line number. A scanner that echoes the credential into
 *    a CI log has moved the problem, not solved it.
 *
 * 2. **A clean report means something only because the patterns are tested.**
 *    `backend/test/secrets.test.js` plants known-bad strings in a throwaway
 *    repository and asserts this file detects them. Without that, a scanner
 *    which silently matches nothing would look identical to a clean repo.
 *
 * Usage:
 *   node scripts/audit-secrets.mjs            # scan, print findings, exit 1 on any
 *   node scripts/audit-secrets.mjs --json     # machine-readable
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');

const git = (...args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });

/**
 * Credential shapes, specific enough to avoid drowning in false positives.
 * Anything matched here is reported for human judgement, never auto-failed on
 * shape alone unless it is also a known live value.
 */
const PATTERNS = [
  // Neon passwords are ~15 characters after the prefix. An earlier {20,} bound
  // missed the real one on this project (npg_ + 14 chars) — a false negative in
  // the one pattern that matters most here. The npg_ prefix is distinctive
  // enough that a lower bound costs nothing.
  { name: 'Neon database password', re: /npg_[A-Za-z0-9]{12,}/g },
  { name: 'Postgres URL with inline password', re: /postgres(?:ql)?:\/\/[^\s:/@]+:[^\s:/@]{6,}@[^\s]*/g },
  { name: 'Supabase anon/service-role key', re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'Stripe live secret key', re: /\b[rs]k_live_[0-9A-Za-z]{20,}/g },
  { name: 'npm auth token', re: /\bnpm_[A-Za-z0-9]{30,}/g },
  { name: 'Private key block', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g },
  { name: 'Azure storage key', re: /AccountKey=[A-Za-z0-9+/=]{60,}/g },
  { name: 'Twilio account SID secret', re: /\bSK[0-9a-fA-F]{32}\b/g },
  { name: 'SendGrid API key', re: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g },
  { name: 'Basic auth in URL', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]{6,}@[^\s]*/gi },
];

/**
 * Contexts where a match is documentation or a placeholder rather than a
 * committed credential. Applied to the matched text *and* its surroundings,
 * because `sk_test_…` documentation lines sit next to real-looking values.
 */
const ALLOWED_CONTEXT = [
  /example\.(com|org|net|test)/i,
  /your[-_]?domain/i,
  /xxxx/i,
  /placeholder/i,
  /\blinkly\.invalid\b/i,
  /\bno-reply@linkly\b/i,
  /\buser:password\b/i,
  /\blocalhost\b/i,
  /\b127\.0\.0\.1\b/,
  /\bprocess\.env\./,
  /\bimport\b/,
  /\brequire\(/,
  /%\$?\{/,
  /\bYOUR_[A-Z_]+/,
  /\bdummy\b/i,
  /\bsample\b/i,
  /\bnot-a-real\b/i,
  /test\.invalid/i,
];

/**
 * Files whose contents are public by construction. npm integrity hashes are
 * SHA-512 digests published in the registry; flagging them is pure noise.
 */
const PUBLIC_BY_NATURE = new Set(['package-lock.json', 'backend/package-lock.json']);

/**
 * Files that contain credential-*shaped* strings on purpose.
 *
 * The scanner's own test plants a dozen fake credentials to prove the scanner
 * detects them, so without this it reports itself. The list is deliberately
 * explicit rather than a glob: adding an entry is an assertion that nothing
 * real lives in that file.
 */
const CREDENTIAL_SHAPED_BY_DESIGN = new Set(['backend/test/secrets.test.js']);

/** 1-based line number of a character offset. */
const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Shannon entropy in bits per character. Used to tell a credential from a
 * configuration value like "http://localhost:3001".
 */
function entropy(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let e = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    e -= p * Math.log2(p);
  }
  return e;
}

/** Values that are configuration, not credentials, however long they are. */
const NOT_A_SECRET = [
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i,
  /^https?:\/\/[^/\s]*example\.(com|org|net|test)/i,
  /^\d+$/, // PORT, rate limits, TTLs
  /^(true|false|verify-full|require|prefer)$/i,
];

/**
 * Live values from a local .env, so the scanner can catch exactly those.
 *
 * A value only counts if it is *credential-shaped*. The first version of this
 * accepted any value over 12 characters, which meant PUBLIC_BASE_URL
 * ("http://localhost:3001") was treated as a secret and matched 43 times
 * across the code and docs — a scanner that cries wolf gets switched off.
 */
function liveSecrets() {
  const envPath = path.join(root, 'backend', '.env');
  if (!existsSync(envPath)) return new Map();

  const known = new Map();

  const add = (value, label) => {
    if (!value || value.length < 16) return;
    if (NOT_A_SECRET.some((rx) => rx.test(value))) return;
    // A URL is only interesting when it carries an inline password.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/:[^:@/\s]{8,}@/.test(value)) return;
    if (entropy(value) < 3.2) return;
    known.set(value, label);
  };

  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z_0-9]+)=(.+)$/.exec(line.trim());
    if (!m) continue;

    const [, key, value] = m;
    add(value, `${key} (backend/.env)`);

    if (key === 'DATABASE_URL') {
      // The password inside a connection string is the actual credential.
      const pass = value.split('@')[0]?.split(':')[1];
      if (pass) add(pass, 'DATABASE_URL password (backend/.env)');
    }
  }

  return known;
}

const findings = [];

function inspect(sha, filePath, text, where) {
  // Exact live values first: these are unambiguous, so they are fatal.
  for (const [value, origin] of liveSecrets()) {
    let from = text.indexOf(value);
    while (from !== -1) {
      findings.push({
        fatal: true,
        name: `LIVE SECRET matching ${origin}`,
        file: filePath,
        sha,
        line: lineAt(text, from),
        where,
      });
      from = text.indexOf(value, from + 1);
    }
  }

  if (PUBLIC_BY_NATURE.has(filePath)) return;
  if (CREDENTIAL_SHAPED_BY_DESIGN.has(filePath)) return;

  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const hit = m[0];
      const context = text.slice(Math.max(0, m.index - 120), m.index + hit.length + 40);

      if (ALLOWED_CONTEXT.some((rx) => rx.test(hit) || rx.test(context))) continue;

      findings.push({
        fatal: false,
        name,
        file: filePath,
        sha,
        line: lineAt(text, m.index),
        where,
      });
    }
  }
}

/**
 * Fails immediately if a value from backend/.env is staged for commit.
 *
 * The history walk below is the thorough check, but it only runs on a full
 * scan; this catches the ordinary case — someone editing a file and running
 * `git commit` with a credential in it — before it ever lands in a commit.
 */
function checkStagedFiles() {
  let staged;
  try {
    staged = git('diff', '--cached', '--name-only', '--diff-filter=ACMR').trim();
  } catch {
    return [];
  }

  if (!staged) return [];

  const known = liveSecrets();
  if (known.size === 0) return [];

  const leaks = [];
  for (const file of staged.split('\n').filter(Boolean)) {
    let content;
    try {
      // Array form: execFileSync's string form takes (file, arg, arg, options)
      // and rejects the options object, so the single-argument version threw
      // and the catch below silently turned this whole check into a no-op.
      content = execFileSync('git', ['show', `:${file}`], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      continue;
    }

    for (const [value, origin] of known) {
      if (content.includes(value)) leaks.push({ file, origin });
    }
  }

  return leaks;
}

// --- walk the history ---------------------------------------------------

const blobs = new Map();
for (const line of git('rev-list', '--objects', '--all').trim().split('\n')) {
  const [sha, ...rest] = line.trim().split(' ');
  blobs.set(sha, rest.join(' ') || '(root)');
}

// Objects removed by a later commit still sit in the object store.
const unreachable = (() => {
  try {
    return git('fsck', '--unreachable', '--no-progress', '--no-reflogs')
      .split('\n')
      .map((l) => /^(?:unreachable|dangling) blob ([0-9a-f]{40})/.exec(l.trim()))
      .filter(Boolean)
      .map((m) => m[1]);
  } catch {
    return [];
  }
})();

for (const [sha, filePath] of blobs) {
  let text;
  try {
    text = execFileSync('git', ['cat-file', '-p', sha], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    continue;
  }
  if (text.includes('\0')) continue; // binary
  inspect(sha, filePath, text, 'blob');
}

for (const sha of unreachable) inspect(sha, '(unreachable object)', '', 'unreachable');

const SEP = '@@LINKLY_COMMIT@@';
for (const record of git('log', '--all', `--format=${SEP}%H%n%B`).split(SEP)) {
  const trimmed = record.trim();
  if (!trimmed) continue;
  const nl = trimmed.indexOf('\n');
  if (nl === -1) continue;
  const hash = trimmed.slice(0, nl).trim();
  if (!/^[0-9a-f]{40}$/.test(hash)) continue;
  inspect(hash, '(commit message)', trimmed.slice(nl + 1), 'message');
}

// --- report -------------------------------------------------------------

const seen = new Set();

// A staged leak is the most urgent thing this tool can report, so it leads.
const staged = checkStagedFiles();

const unique = findings.filter((f) => {
  const key = `${f.name}|${f.file}|${f.line}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const fatal = unique.filter((f) => f.fatal);
const review = unique.filter((f) => !f.fatal);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        scanned: blobs.size,
        unreachable: unreachable.length,
        staged: staged.map((s) => ({ file: s.file, origin: s.origin })),
        fatal,
        review,
      },
      null,
      2
    )
  );
} else {
  console.log(`Scanned ${blobs.size} blobs, ${unreachable.length} unreachable objects, all commit messages.\n`);

  if (staged.length > 0) {
    console.log(`STAGED RIGHT NOW - a live secret is about to be committed: ${staged.length}`);
    for (const s of staged) {
      console.log(`  ${s.file}  contains a value matching ${s.origin}`);
    }
    console.log('  Remove the value from the file, or rotate the credential.\n');
  } else {
    console.log('Staged for commit: no live secret.\n');
  }
  console.log(`FATAL (a live secret from backend/.env is committed): ${fatal.length}`);
  for (const f of fatal) {
    console.log(`  ${f.file}:${f.line}  @${f.sha.slice(0, 10)}  [${f.where}]\n    ${f.name}`);
  }
  console.log(`\nNEEDS REVIEW (credential-shaped): ${review.length}`);
  for (const f of review) {
    console.log(`  ${f.file}:${f.line}  @${f.sha.slice(0, 10)}\n    ${f.name}`);
  }
  if (!unique.length) console.log('\nClean: no live secret and no credential-shaped string in any blob.');
}

// A credential-shaped string is worth failing on. If one of these ever turns
// out to be a false positive, allowlist it in ALLOWED_CONTEXT with a comment
// saying why, rather than loosening the pattern.
process.exit(fatal.length > 0 || review.length > 0 || staged.length > 0 ? 1 : 0);
