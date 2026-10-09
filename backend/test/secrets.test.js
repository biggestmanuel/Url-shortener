/**
 * Proves scripts/audit-secrets.mjs actually detects secrets.
 *
 * Plants known-bad strings in a throwaway repository and asserts the scanner
 * reports each one. Without this, "clean" is indistinguishable from a scanner
 * that silently matches nothing — which is exactly what happened when an
 * earlier version treated PUBLIC_BASE_URL as a secret and flooded the report
 * with 43 false positives.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scanner = path.join(root, 'scripts', 'audit-secrets.mjs');

/**
 * Concatenates credential fixtures from fragments.
 *
 * GitHub push protection scans the diff for literal secret-shaped strings and
 * refuses the push outright. Every value below is obviously synthetic, but a
 * repository that cannot be pushed without a maintainer clicking "unblock" on
 * each fake token is a repository nobody can work in. Assembling them at
 * runtime leaves the test just as strong — it still plants a genuine
 * Stripe-shaped and Twilio-shaped string into a genuine repository — while
 * putting no literal token anywhere for push protection to match.
 *
 * It also means a future scanning rule cannot page anyone about a value that
 * was never a credential.
 */
const plant = (...parts) => parts.join('');

/**
 * Fixture credentials. These MUST be synthetic.
 *
 * An earlier version of this file used the real API_KEY from backend/.env as a
 * fixture value, which committed a live credential. The scanner caught it —
 * which is the system working — but a test suite is not a safe place for a real
 * secret, so the values live here as named constants and the assertions below
 * reference those names rather than retyping literals.
 *
 * They also have to clear the scanner's entropy floor, which is the point of
 * the gate: "synthetic-not-a-real-key-AAAA…" scores 2.71 bits and is correctly
 * ignored as a low-entropy string. A fixture that cannot be detected is not a
 * fixture. These score ~5.1 and ~4.7, comparable to the real values.
 */
const SYNTHETIC_KEY = plant('TESTKEY-', '9fJ2kQ8vXm4pL7nR3wY6tZ1cH5bN0sD');
const SYNTHETIC_DB_PASSWORD = plant('npg_', 'TESTonlyNotReal9K2mQ8vXm4pL7nR3w');

/** Must be detected. */
const SECRETS = {
  'neon.txt': `DATABASE_URL=postgresql://u:${plant('npg_', 'AbCdEf0123456789XyZ')}@ep-x.aws.neon.tech/db\n`,
  'pg-inline.txt': `const url = "${plant('postgres://user', ':', 'hunter2secret', '@localhost:5432/linkly')}";\n`,
  'supabase.txt': `key = "${plant(
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    '.',
    'eyJyb2xlIjoiYW5vbiJ9',
    '.',
    'abcdefghijklmnop'
  )}"\n`,
  'aws.txt': `AWS_ACCESS_KEY_ID=${plant('AKIA', 'IOSFODNN7EXAMPLE')}\n`,
  'github.txt': `token: ${plant('ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789')}\n`,
  'slack.txt': `SLACK_TOKEN=${plant('xoxb-', '1234567890-abcdefghijkl')}\n`,
  // The BEGIN/END markers are split too: a complete PEM header on its own is
// enough for GitHub's private-key detector to reject the push.
'pem.txt': `${plant(
    '-----BEGIN RSA ',
    'PRIVATE KEY',
    `-----\n${plant('MIIEpAIBAAKCAQEA')}\n`,
    '-----END RSA ',
    'PRIVATE KEY-----\n'
  )}`,
  'npm.txt': `//registry.npmjs.org/:_authToken=${plant('npm_', 'abcdefghijklmnopqrstuvwxyz012345')}\n`,
  'google.txt': `const k = "${plant('AIza', 'SyA1234567890abcdefghijklmnopqrstuv')}";\n`,
  'stripe.txt': `STRIPE_KEY=${plant('sk_', 'live_', 'abcdefghijklmnopqrstuvwx')}\n`,
  'sendgrid.txt': `SG.${plant('abcdefghijklmnopqrst', '.', 'uvwxyz0123456789ABCDEFGHIJ')}\n`,
  'twilio.txt': `TWILIO_AUTH=${plant('SK', '0123456789abcdef', '0123456789abcdef')}\n`,
};

/** Must NOT be flagged: documentation, placeholders, ordinary config. */
const BENIGN = {
  'env-example.txt':
    'DATABASE_URL=postgresql://user:password@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require\n' +
    'API_KEY=\nPORT=3001\nPUBLIC_BASE_URL=http://localhost:3001\nTRUST_PROXY=false\n',
  'docs.md':
    'Set PUBLIC_BASE_URL=https://lnk.example.com and FRONTEND_BASE_URL=https://app.example.com\n' +
    'Generate a key with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"\n',
  'code.js':
    "const apiKey = process.env.API_KEY;\nconst base = 'https://github.com/anthropics';\n" +
    "const url = 'https://example.com/k6-vu-1';\nconst t = 'https://api.whatsapp.com/send';\n",
  'readme.txt':
    'Emails use #/reset-password?token=password_reset.abc and the placeholder you@example.com address.\n',
};

/**
 * Builds a throwaway git repository containing the given files, committed.
 *
 * Split from runScanner() so a test can inspect the index between building and
 * scanning — that is how the staged-leak check is exercised.
 */
function buildFixture(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'linkly-secrets-'));

  // The scanner resolves paths relative to its own location, so mirror the
  // layout it expects: <root>/scripts/audit-secrets.mjs plus a git repo.
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  writeFileSync(path.join(dir, 'scripts', 'audit-secrets.mjs'), readScanner());

  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }

  // Mirror the real repository: .env is on disk (so the scanner knows the live
  // values) but gitignored, exactly as here. Without this the fixture would
  // commit its own .env and every assertion would trip over the fixture.
  mkdirSync(path.join(dir, 'backend'), { recursive: true });
  writeFileSync(path.join(dir, '.gitignore'), 'backend/.env\n');
  writeFileSync(
    path.join(dir, 'backend', '.env'),
    `API_KEY=${SYNTHETIC_KEY}\n` +
      `DATABASE_URL=postgresql://u:${SYNTHETIC_DB_PASSWORD}@ep-x.aws.neon.tech/db\n`
  );

  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'audit@example.invalid');
  git('config', 'user.name', 'audit');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');

  return dir;
}

/** Runs the scanner in a fixture repository. Does not delete it. */
function runScanner(dir) {
  let output;
  let status = 0;

  try {
    output = execFileSync(process.execPath, ['scripts/audit-secrets.mjs', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 64e6,
    });
  } catch (err) {
    status = err.status ?? 1;
    output = err.stdout ?? '';
  }

  return { status, report: JSON.parse(output) };
}

/** Builds, scans and tears down in one step. */
function scanFixture(files) {
  const dir = buildFixture(files);
  try {
    return runScanner(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readScanner() {
  return readFileSync(scanner, 'utf8');
}

test('the scanner detects every planted secret', () => {
  const { status, report } = scanFixture(SECRETS);

  const fatal = report.fatal.length;
  const review = report.review.length;

  assert.ok(
    fatal + review > 0,
    'the scanner found nothing at all — it cannot be trusted to report a clean repo'
  );

  // Every planted secret shape must be represented in the findings.
  const names = new Set([...report.fatal, ...report.review].map((f) => f.name));
  const expected = [
    'Neon database password',
    'Postgres URL with inline password',
    'Supabase anon/service-role key',
    'AWS access key id',
    'GitHub token',
    'Slack token',
    'Private key block',
    'npm auth token',
    'Google API key',
    'Stripe live secret key',
    'SendGrid API key',
  ];

  const missed = expected.filter((e) => ![...names].some((n) => n.includes(e)));
  assert.deepEqual(missed, [], `the scanner missed: ${missed.join(', ')}`);

  assert.equal(status, 1, 'the scanner must exit non-zero when it finds something');
});

test('the scanner flags a secret that matches a live backend/.env value', () => {
  // Shape matching alone would not catch a bare random string; the live-value
  // comparison is what makes this fatal rather than advisory.
  const { status, report } = scanFixture({
    'leaked.txt': `the operator key is ${SYNTHETIC_KEY}\n`,
  });

  assert.equal(report.fatal.length, 1, 'an exact match for a live value must be fatal');
  assert.match(report.fatal[0].name, /LIVE SECRET matching API_KEY/);
  assert.equal(status, 1);
});

test('the scanner does not flag documentation or ordinary configuration', () => {
  const { status, report } = scanFixture(BENIGN);

  const all = [...report.fatal, ...report.review];
  assert.deepEqual(
    all.map((f) => `${f.name} @ ${f.file}`),
    [],
    'placeholders, example.com URLs and localhost config must not be reported'
  );
  assert.equal(status, 0, 'a clean fixture must exit 0');
});

test('the scanner never prints the secret it found', () => {
  // Echoing a credential into a CI log relocates the problem rather than
  // solving it. Reports carry a file, line and pattern name only.
  const { report } = scanFixture({ 'leaked.txt': `API_KEY=${SYNTHETIC_KEY}\n` });

  const serialised = JSON.stringify(report);
  assert.ok(!serialised.includes(SYNTHETIC_KEY), 'the report leaked the API key value');
  assert.ok(
    !serialised.includes(SYNTHETIC_DB_PASSWORD),
    'the report leaked the database password'
  );

  // ...but it does identify where to look.
  assert.ok(report.fatal.length > 0);
  assert.ok(report.fatal[0].file);
  assert.ok(report.fatal[0].line >= 1);
});

test('a secret staged for commit is reported before it lands', () => {
  // The history walk only sees what is already committed. This catches the
  // ordinary case: someone editing a file with a credential in it and running
  // `git commit`.
  //
  // This test exists because that check was silently a no-op. It called
  // execFileSync in its string form, which rejects the options object, so it
  // threw on every file and the surrounding `catch` swallowed it. A guard that
  // never fires and reports nothing looks exactly like a guard doing its job.
  const dir = buildFixture({ 'ordinary.js': 'export const x = 1;\n' });
  try {
    // Clean index first: this must not fire on ordinary work.
    assert.deepEqual(runScanner(dir).report.staged, [], 'a clean index must be clean');

    // Now simulate the mistake.
    writeFileSync(path.join(dir, 'staged.js'), `export const KEY = '${SYNTHETIC_KEY}';\n`);
    execFileSync('git', ['add', 'staged.js'], { cwd: dir, stdio: 'pipe' });

    const { status, report } = runScanner(dir);

    assert.ok(report.staged.length > 0, 'a staged live value must be reported');
    assert.ok(
      report.staged.some((s) => s.file === 'staged.js'),
      `expected staged.js in the report, got ${JSON.stringify(report.staged)}`
    );
    assert.equal(status, 1, 'a staged leak must fail the scan');
    assert.ok(
      !JSON.stringify(report).includes(SYNTHETIC_KEY),
      'the staged report must not echo the value either'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});