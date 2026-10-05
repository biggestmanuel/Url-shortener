/**
 * Deployment configuration checks.
 *
 * These guard the settings that fail *silently* — the server boots, reports
 * healthy, and hands out links nobody can open. A regression here means a
 * deployment looks fine and isn't.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { findConfigProblems, logConfigProblems, findFatalConfigProblems } from '../lib/config.js';

/** A fully-configured production environment, used as the baseline. */
const HEALTHY = {
  PUBLIC_BASE_URL: 'https://lnk.example.com',
  FRONTEND_BASE_URL: 'https://app.example.com',
  CORS_ORIGINS: 'https://app.example.com',
  TRUST_PROXY: 'true',
  API_KEY: 'a-real-key',
  SMTP_HOST: 'smtp.example.com',
};

const vars = (env) => findConfigProblems(env).map((p) => p.variable);
const problemFor = (env, variable) =>
  findConfigProblems(env).find((p) => p.variable === variable);

test('a fully-configured environment reports nothing', () => {
  assert.deepEqual(findConfigProblems(HEALTHY), []);
});

test('an empty environment flags every deployment-critical variable', () => {
  // Nothing set at all is the worst case and must be loud about all of it.
  assert.deepEqual(vars({}).sort(), [
    'API_KEY',
    'CORS_ORIGINS',
    'FRONTEND_BASE_URL',
    'PUBLIC_BASE_URL',
    'SMTP_HOST',
  ]);
});

test('TRUST_PROXY is only demanded once the deployment is public', () => {
  // Behind https, proxy trust decides whether rate limiting keys on the real
  // client IP. Behind localhost there is no proxy to trust.
  assert.equal(vars(HEALTHY).includes('TRUST_PROXY'), false);
  assert.ok(
    vars({ ...HEALTHY, TRUST_PROXY: undefined }).includes('TRUST_PROXY'),
    'https without TRUST_PROXY must be flagged'
  );

  // Same-origin http on localhost is a normal local setup; nothing to warn about.
  assert.equal(
    vars({ ...HEALTHY, TRUST_PROXY: undefined, PUBLIC_BASE_URL: 'http://localhost:3001' })
      .includes('TRUST_PROXY'),
    false
  );
});

test('any recognised TRUST_PROXY spelling satisfies the check', () => {
  // boolEnv accepts these; the check must agree with it, or the two disagree.
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' on ']) {
    assert.equal(
      vars({ ...HEALTHY, TRUST_PROXY: value }).includes('TRUST_PROXY'),
      false,
      `TRUST_PROXY="${value}" should count as on`
    );
  }
});

test('a localhost PUBLIC_BASE_URL is reported', () => {
  // The mistake that motivated all of this: links that nobody but you can open.
  for (const base of [
    'http://localhost:3001',
    'https://localhost',
    'http://127.0.0.1:8080',
    'https://[::1]:3001',
  ]) {
    const problem = problemFor({ ...HEALTHY, PUBLIC_BASE_URL: base }, 'PUBLIC_BASE_URL');
    assert.ok(problem, `${base} must be reported`);
    assert.match(problem.message, /only reachable from this machine/);
  }
});

test('a PUBLIC_BASE_URL that is not an absolute URL is reported', () => {
  // Would otherwise produce short links like "lnk.example.com/abc" — relative,
  // and broken.
  for (const base of ['lnk.example.com', '/lnk', 'ftp://example.com', 'example.com']) {
    const problem = problemFor({ ...HEALTHY, PUBLIC_BASE_URL: base }, 'PUBLIC_BASE_URL');
    assert.ok(problem, `${base} must be reported`);
    assert.match(problem.message, /not an absolute http\(s\) URL|trailing slash/);
  }
});

test('a trailing slash on PUBLIC_BASE_URL is reported', () => {
  // server.js strips it at read time, so this is a nit rather than a bug —
  // but the value should not be wrong to begin with.
  const problem = problemFor({ ...HEALTHY, PUBLIC_BASE_URL: 'https://lnk.example.com/' }, 'PUBLIC_BASE_URL');
  assert.ok(problem);
  assert.match(problem.message, /trailing slash/);
});

test('a loopback FRONTEND_BASE_URL breaks emailed links and is reported', () => {
  const problem = problemFor(
    { ...HEALTHY, FRONTEND_BASE_URL: 'http://localhost:3001' },
    'FRONTEND_BASE_URL'
  );
  assert.ok(problem);
  assert.match(problem.message, /only open on the machine/);
});

test('a wildcard CORS origin is reported', () => {
  const problem = problemFor({ ...HEALTHY, CORS_ORIGINS: '*,https://app.example.com' }, 'CORS_ORIGINS');
  assert.ok(problem);
  assert.match(problem.message, /allows every origin/);
});

test('a list of explicit origins is accepted', () => {
  assert.deepEqual(
    findConfigProblems({ ...HEALTHY, CORS_ORIGINS: 'https://a.example.com, https://b.example.com' }),
    []
  );
});

test('each message is written to be prefixed by the variable name', () => {
  // The boot output is `WARNING: ${variable} ${message}`, so a message that
  // already began with the variable name would print it twice, and one that
  // did not start with a verb would read as a sentence fragment.
  for (const { variable, message } of findConfigProblems({})) {
    assert.ok(
      message.startsWith('is not set') || message.startsWith('is "'),
      `${variable}: message should read as "${variable} <message>", got "${message}"`
    );
    assert.doesNotMatch(
      message.slice(0, 24),
      new RegExp(`^${variable}\\b`),
      `${variable} is repeated at the start of its own message`
    );
  }
});

test('logConfigProblems prints one WARNING line per problem', () => {
  const lines = [];
  logConfigProblems(findConfigProblems({}), (line) => lines.push(line));

  assert.equal(lines.length, 5);
  for (const line of lines) assert.match(line, /^WARNING: [A-Z_]+ /);
});

test('every reported variable has a description', () => {
  // Otherwise `npm run doctor` tells someone a variable is wrong without
  // saying what it is for.
  import('../lib/config.js').then(({ describeVariables }) => {
    const described = describeVariables();
    for (const variable of vars({})) {
      assert.ok(described[variable], `${variable} has no description`);
    }
  });
});

// --- production fail-fast ----------------------------------------------

test('only production refuses to boot on a broken configuration', () => {
  // In development, localhost is a legitimate choice and the app must still
  // start so a contributor can work.
  for (const nodeEnv of [undefined, '', 'development', 'test', 'dev']) {
    assert.deepEqual(
      findFatalConfigProblems({ NODE_ENV: nodeEnv }),
      [],
      `NODE_ENV=${nodeEnv} must not be fatal`
    );
  }
});

test('production refuses to start with a loopback PUBLIC_BASE_URL', () => {
  // The failure this prevents: every generated link points at localhost, and
  // nobody notices until a user reports their links are dead.
  for (const base of [undefined, 'http://localhost:3001', 'https://localhost', 'http://127.0.0.1:80']) {
    const problems = findFatalConfigProblems({ NODE_ENV: 'production', PUBLIC_BASE_URL: base });
    assert.ok(
      problems.some((p) => p.variable === 'PUBLIC_BASE_URL'),
      `PUBLIC_BASE_URL=${base} must be fatal in production`
    );
  }

  // A real origin is fine.
  assert.deepEqual(
    findFatalConfigProblems({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://lnk.example.com' }),
    []
  );
});

test('production refuses a wildcard CORS origin', () => {
  const problems = findFatalConfigProblems({
    NODE_ENV: 'production',
    PUBLIC_BASE_URL: 'https://lnk.example.com',
    CORS_ORIGINS: '*',
  });
  assert.ok(problems.some((p) => p.variable === 'CORS_ORIGINS'));
});

test('the loopback guard can be waived for a private deployment', () => {
  // Someone genuinely serving a LAN-only instance should not be locked out.
  assert.deepEqual(
    findFatalConfigProblems({
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'http://localhost:3001',
      ALLOW_LOOPBACK_BASE_URL: 'true',
    }),
    [],
    'ALLOW_LOOPBACK_BASE_URL must waive the check'
  );

  // ...but only for the spellings that mean yes, not for "false".
  assert.ok(
    findFatalConfigProblems({
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'http://localhost:3001',
      ALLOW_LOOPBACK_BASE_URL: 'false',
    }).length > 0,
    '"false" must not waive the check — Boolean("false") is true'
  );
});
