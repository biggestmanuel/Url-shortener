import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createApp } from '../server.js';
import { createFakePool } from './helpers/fake-pool.js';
import { pruneExpiredSessions } from '../lib/sessions.js';
import { createCapturingMailer, findToken } from '../lib/mailer.js';

/**
 * Boots the app on an ephemeral port with a fake pool and hands the test a
 * base URL. Rate limits are relaxed by default so unrelated assertions never
 * trip them.
 */
async function withServer(configure, run) {
  const pool = createFakePool();
  const app = createApp({
    pool,
    publicBaseUrl: 'https://lnk.test',
    createRateMax: 1000,
    redirectRateMax: 1000,
    authRateMax: 1000,
    ...configure,
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    return await run(`http://127.0.0.1:${server.address().port}`, pool);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const json = (body, headers = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

const create = (base, body, headers = {}) =>
  fetch(`${base}/api/links`, json(body, headers));

/** Registers an account and returns an authenticated request helper. */
async function signUp(base, email = 'user@example.com', password = 'hunter2hunter2') {
  const res = await fetch(`${base}/api/auth/register`, json({ email, password }));
  const body = await res.json();
  return { res, body, auth: { Authorization: `Bearer ${body.token}` } };
}

// --- health & routing ---------------------------------------------------

test('reports health', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.db.ok, true, 'the readiness check must query the database');
    // Every endpoint it advertises has to exist, or the listing is a lie.
    for (const route of ['register', 'login', 'logout', 'me', 'links', 'redirect']) {
      assert.ok(body.endpoints[route], `health omits ${route}`);
    }
  });
});

test('the health check reports a database outage as degraded', async () => {
  // A load balancer needs a failing status to stop sending traffic here;
  // answering 200 while every query throws just keeps a broken instance in
  // rotation.
  const pool = {
    query: async (text) => {
      if (text.includes('SELECT 1')) {
        const err = new Error('connection terminated unexpectedly');
        err.code = '57P01';
        throw err;
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const app = createApp({ pool });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(res.status, 503);

    const body = await res.json();
    assert.equal(body.status, 'degraded');
    assert.equal(body.db.ok, false);
    // The error code is useful for an operator; the message may carry
    // credentials or host details, so only the code is exposed.
    assert.equal(body.db.error, '57P01');
    assert.equal(body.db.message, undefined);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// --- hardening ---------------------------------------------------------

test('a non-numeric link id is a 404, not a 500', async () => {
  await withServer({}, async (base) => {
    // id is a bigint; Postgres would reject anything else with 22P02, which
    // used to surface as an unhandled 500.
    for (const id of ['abc', '1;DROP TABLE links', '../etc/passwd', '1.5', '0x10', '-1']) {
      const res = await fetch(`${base}/api/links/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'x-owner-token': 'anything' },
      });
      assert.equal(res.status, 404, `${id} must not be a 500`);
    }
  });
});

test('trust proxy is off unless explicitly enabled', async () => {
  const { createApp } = await import('../server.js');
  const pool = { query: async () => ({ rows: [] }) };

  // Boolean('false') is true, which would let a client spoof X-Forwarded-For
  // and bypass every per-IP rate limit.
  const previous = process.env.TRUST_PROXY;

  try {
    for (const [value, expected] of [
      ['false', false],
      ['FALSE', false],
      ['0', false],
      ['no', false],
      ['off', false],
      ['', false],
      ['true', true],
      ['1', true],
      ['yes', true],
      ['on', true],
    ]) {
      process.env.TRUST_PROXY = value;

      // Not passing trustProxy, so the value must come from the env var.
      const app = createApp({ pool, trustProxy: undefined });
      const resolved = app.get('trust proxy');

      // Express reports `false` for off and the hop count for on.
      const isOff = resolved === false || resolved === undefined;
      const isOn = resolved === 1 || resolved === true;

      assert.ok(
        expected ? isOn : isOff,
        `TRUST_PROXY="${value}" -> ${String(resolved)}, expected ${expected ? 'on' : 'off'}`
      );
    }
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
  }
});

test('the link list clamps absurd and negative limits', async () => {
  const seen = [];
  const pool = {
    // (apiKey 'op' is passed below so the route is reachable.)
    query: async (text, params = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (sql.startsWith('SELECT * FROM links')) {
        seen.push(params[0]);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const app = createApp({ pool, apiKey: 'op', createRateMax: 1000 });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // Operator key, so the route is reachable.
    for (const q of ['limit=0', 'limit=-5', 'limit=1e9', 'limit=abc', 'limit=999', 'limit=100']) {
      const res = await fetch(`${base}/api/links?${q}`, { headers: { 'x-api-key': 'op' } });
      assert.equal(res.status, 200, q);
    }

    // Every applied limit must be an integer within bounds.
    for (const limit of seen) {
      assert.equal(Number.isInteger(limit), true, `limit ${limit} must be an integer`);
      assert.ok(limit >= 1 && limit <= 100, `limit ${limit} must be within 1..100`);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('the session sweep can be switched off with 0', async () => {
  const { createApp } = await import('../server.js');
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
  const previous = process.env.SESSION_SWEEP_MINUTES;

  /**
   * Boots an app with setInterval stubbed out, returning every interval
   * createApp asked for. The rate limiters register some of their own, so the
   * sweep is identified by being registered last and by its duration.
   */
  const intervalsFor = (envValue) => {
    process.env.SESSION_SWEEP_MINUTES = envValue;

    const realSetInterval = globalThis.setInterval;
    const seen = [];
    globalThis.setInterval = (fn, ms) => {
      seen.push(ms);
      return { unref() {} };
    };

    try {
      // Not passing sessionSweepMinutes, so it must come from the env var.
      createApp({ pool, sessionSweepMinutes: undefined });
    } finally {
      globalThis.setInterval = realSetInterval;
    }

    return seen;
  };

  try {
    // The documented "set to 0 to disable" case has to actually disable it.
    // numEnv() treats 0 as unset and falls back, which left the interval
    // running and quietly ignored the setting.
    const disabled = intervalsFor('0');
    const enabled = intervalsFor('60');

    assert.equal(
      disabled.length,
      enabled.length - 1,
      'only the 0 case should skip registering the sweep timer'
    );

    for (const [value, expected] of [
      ['0', 0],
      ['1', 1],
      ['60', 60],
      ['60.9', 60],
      ['  120  ', 120],
      ['', 60], // unset -> default
      ['-5', 60], // invalid -> default
      ['abc', 60],
    ]) {
      const seen = intervalsFor(value);
      const sweepMinutes = expected > 0 ? seen[seen.length - 1] / 60000 : null;

      assert.equal(
        seen.length,
        expected > 0 ? enabled.length : disabled.length,
        `SESSION_SWEEP_MINUTES="${value}" registered the wrong number of timers`
      );
      assert.equal(
        sweepMinutes,
        expected > 0 ? expected : null,
        `SESSION_SWEEP_MINUTES="${value}" should resolve to ${expected}`
      );
    }
  } finally {
    if (previous === undefined) delete process.env.SESSION_SWEEP_MINUTES;
    else process.env.SESSION_SWEEP_MINUTES = previous;
  }
});

test('every response carries baseline security headers', async () => {
  await withServer({}, async (base) => {
    // Checked on an API response, an error response and a redirect: the
    // middleware has to run before the catch-all 404 and the /:code handler,
    // not just on the happy path.
    const targets = [
      ['health', `${base}/`],
      ['not found', `${base}/api/nope`],
      ['bad body', `${base}/api/links`],
      ['redirect', `${base}/abcdefgh`],
    ];

    const expected = {
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    };

    for (const [label, url] of targets) {
      const res =
        label === 'bad body'
          ? await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{oops',
            })
          : await fetch(url, { redirect: 'manual' });

      for (const [header, value] of Object.entries(expected)) {
        assert.equal(
          res.headers.get(header),
          value,
          `${label}: ${header} must be "${value}"`
        );
      }

      assert.ok(res.headers.get('strict-transport-security'), `${label}: HSTS missing`);
      assert.equal(
        res.headers.get('x-powered-by'),
        null,
        `${label}: must not advertise Express`
      );
    }
  });
});

test('a code allocation that returns nothing fails cleanly', async () => {
  // RETURNING always produces a row against a real database. If a driver or a
  // proxy ever hands back none, the old code read .id off undefined and
  // reported an opaque 500; it must now look like what it is.
  const pool = {
    query: async (text) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (sql.startsWith('INSERT INTO links')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };

  const app = createApp({ pool, createRateMax: 1000 });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const generated = await fetch(`${base}/api/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationUrl: 'https://example.com' }),
    });
    assert.equal(generated.status, 503, 'a generated code should report exhaustion');
    assert.match((await generated.json()).error, /unique short code/i);

    const aliased = await fetch(
      `${base}/api/links`,
      json({ destinationUrl: 'https://example.com', customAlias: 'myalias' })
    );
    assert.equal(aliased.status, 409, 'a custom alias should report a collision');
    assert.match((await aliased.json()).error, /already in use/i);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('reserved paths never reach the database', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/favicon.ico`)).status, 204);
    const robots = await fetch(`${base}/robots.txt`);
    assert.equal(robots.status, 200);
    assert.match(await robots.text(), /Disallow/);
  });
});

// --- emailed action links ----------------------------------------------

test('email action paths redirect to the frontend, not a 404', async () => {
  await withServer({ frontendBaseUrl: 'https://app.example' }, async (base) => {
    for (const route of ['reset-password', 'verify-email']) {
      const res = await fetch(`${base}/${route}?token=abc.def`, { redirect: 'manual' });

      assert.equal(res.status, 302, `${route} must not fall through to /:code`);
      assert.equal(
        res.headers.get('location'),
        `https://app.example/#/${route}?token=abc.def`
      );
    }
  });
});

test('the redirect preserves an absent token cleanly', async () => {
  await withServer({ frontendBaseUrl: 'https://app.example' }, async (base) => {
    const res = await fetch(`${base}/reset-password`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://app.example/#/reset-password');
  });
});

test('an ordinary unknown code still 404s', async () => {
  await withServer({ frontendBaseUrl: 'https://app.example' }, async (base) => {
    // Regression guard: the frontend-route shortcut must not swallow codes.
    assert.equal((await fetch(`${base}/zzz777`, { redirect: 'manual' })).status, 404);
  });
});

test('the reset email contains a working hash-route link', async () => {
  const mailer = createCapturingMailer({ subjectIncludes: 'Reset your Linkly password' });

  await withServer(
    { frontendBaseUrl: 'https://app.example', sendMailImpl: mailer.sendMail },
    async (base, pool) => {
      await signUp(base, 'mail@example.com');

      const res = await fetch(`${base}/api/auth/forgot-password`, json({ email: 'mail@example.com' }));
      assert.equal(res.status, 200);

      assert.equal(mailer.sent.length, 1, 'exactly one mail was sent');
      assert.equal(mailer.sent[0].to, 'mail@example.com');

      const token = findToken(mailer.sent, 'password_reset');
      assert.ok(token, 'the mail body must carry the raw token');

      // The link must target the frontend as a hash route, not an API path.
      assert.match(
        mailer.sent[0].text,
        /https:\/\/app\.example\/#\/reset-password\?token=/,
        'the emailed link must be a frontend hash route'
      );
      assert.ok(!mailer.sent[0].text.includes('app.example/reset-password?'), 'no bare path');

      // And that token works end to end.
      const reset = await fetch(
        `${base}/api/auth/reset-password`,
        json({ token, password: 'brand-new-pass-7' })
      );
      assert.equal(reset.status, 200);
      assert.equal(pool.resets.length, 1);
      // Only the digest is persisted, never the raw token.
      assert.notEqual(pool.resets[0].token_hash, token);
    }
  );
});

test('registering sends a verification mail with a hash-route link', async () => {
  const mailer = createCapturingMailer({ subjectIncludes: 'Verify your Linkly' });

  await withServer(
    { frontendBaseUrl: 'https://app.example', sendMailImpl: mailer.sendMail },
    async (base) => {
      await signUp(base, 'verify-mail@example.com');

      assert.equal(mailer.sent.length, 1);
      assert.match(
        mailer.sent[0].text,
        /https:\/\/app\.example\/#\/verify-email\?token=/,
        'the verification link must be a frontend hash route'
      );

      const token = findToken(mailer.sent, 'email_verification');
      assert.ok(token);

      // Registration must still succeed when mail fails.
      assert.ok(token.split('.')[1].length >= 40);
    }
  );
});

test('registration is not blocked by a failing mail transport', async () => {
  const failing = {
    sendMail: async () => {
      throw new Error('SMTP is down');
    },
  };

  await withServer({ sendMailImpl: failing.sendMail }, async (base) => {
    const res = await fetch(
      `${base}/api/auth/register`,
      json({ email: 'mailfail@example.com', password: 'hunter2hunter2' })
    );

    assert.equal(res.status, 201, 'a mail failure must not fail registration');
    assert.ok((await res.json()).token);
  });
});

test('unknown paths return a JSON 404 instead of a redirect lookup', async () => {
  await withServer({}, async (base) => {
    for (const path of ['/nested/path', '/api/unknown', '/some.file.txt', '/a$b']) {
      const res = await fetch(`${base}${path}`, { redirect: 'manual' });
      assert.equal(res.status, 404, `${path} should 404`);
      assert.equal(res.headers.get('location'), null, `${path} must not redirect`);
    }
  });
});

test('can restrict CORS origins', async () => {
  await withServer({ corsOrigins: 'https://allowed.example' }, async (base) => {
    const allowed = await fetch(`${base}/`, { headers: { Origin: 'https://allowed.example' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://allowed.example');

    const denied = await fetch(`${base}/`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  });
});

test('allows any origin when CORS_ORIGINS is unset (demo/file:// mode)', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/`, { headers: { Origin: 'https://anything.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
});

// --- accounts -----------------------------------------------------------

test('registers an account and returns a session token', async () => {
  await withServer({}, async (base) => {
    const { res, body, auth } = await signUp(base);

    assert.equal(res.status, 201);
    assert.equal(body.user.email, 'user@example.com');
    assert.ok(body.token && body.token.length >= 32);
    assert.ok(new Date(body.expiresAt).getTime() > Date.now());

    const me = await fetch(`${base}/api/auth/me`, { headers: auth });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.email, 'user@example.com');
  });
});

test('never returns the password hash', async () => {
  await withServer({}, async (base) => {
    const { body } = await signUp(base);
    assert.equal('passwordHash' in body, false);
    assert.equal('password_hash' in body, false);
    assert.equal('password' in body, false);
  });
});

test('stores only a digest of the session token', async () => {
  await withServer({}, async (base, pool) => {
    const { body } = await signUp(base);
    const stored = pool.sessions[0].token_hash;

    assert.notEqual(stored, body.token, 'the raw token must not be persisted');
    assert.match(stored, /^[\w-]{43}$/);
  });
});

test('rejects duplicate emails case-insensitively', async () => {
  await withServer({}, async (base) => {
    await signUp(base, 'User@Example.com');
    const second = await fetch(
      `${base}/api/auth/register`,
      json({ email: 'user@example.com', password: 'hunter2hunter2' })
    );

    assert.equal(second.status, 409);
  });
});

test('rejects invalid registration input', async () => {
  await withServer({}, async (base) => {
    for (const body of [
      { email: 'nope', password: 'hunter2hunter2' },
      { email: 'a@b.co', password: 'short' },
      { email: 'a@b.co' },
      { password: 'hunter2hunter2' },
      {},
    ]) {
      const res = await fetch(`${base}/api/auth/register`, json(body));
      assert.equal(res.status, 400, `${JSON.stringify(body)} should be rejected`);
    }
  });
});

test('signs in with correct credentials and refuses wrong ones', async () => {
  await withServer({}, async (base) => {
    await signUp(base);

    const good = await fetch(
      `${base}/api/auth/login`,
      json({ email: 'user@example.com', password: 'hunter2hunter2' })
    );
    assert.equal(good.status, 200);
    assert.ok((await good.json()).token);

    for (const body of [
      { email: 'user@example.com', password: 'wrong' },
      { email: 'nobody@example.com', password: 'hunter2hunter2' },
      { email: 'nobody@example.com', password: 'wrong' },
    ]) {
      const res = await fetch(`${base}/api/auth/login`, json(body));
      assert.equal(res.status, 401, `${JSON.stringify(body)} should not sign in`);
    }
  });
});

test('login errors do not reveal whether an email exists', async () => {
  await withServer({}, async (base) => {
    await signUp(base);

    const wrongPassword = await fetch(
      `${base}/api/auth/login`,
      json({ email: 'user@example.com', password: 'nope-nope-nope' })
    );
    const unknownEmail = await fetch(
      `${base}/api/auth/login`,
      json({ email: 'ghost@example.com', password: 'nope-nope-nope' })
    );

    assert.equal(wrongPassword.status, unknownEmail.status);
    assert.deepEqual(await wrongPassword.json(), await unknownEmail.json());
  });
});

test('logout invalidates the session', async () => {
  await withServer({}, async (base) => {
    const { auth } = await signUp(base);

    assert.equal((await fetch(`${base}/api/auth/me`, { headers: auth })).status, 200);

    const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: auth });
    assert.equal(out.status, 200);

    assert.equal((await fetch(`${base}/api/auth/me`, { headers: auth })).status, 401);
  });
});

test('rejects malformed and oversized auth bodies as client errors', async () => {
  await withServer({}, async (base) => {
    const malformed = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{email: a@b.co}',
    });
    assert.equal(malformed.status, 400);

    const huge = await fetch(
      `${base}/api/auth/register`,
      json({ email: 'a@b.co', password: 'x'.repeat(64 * 1024) })
    );
    assert.equal(huge.status, 413);
  });
});

test('rate limits authentication attempts', async () => {
  await withServer({ authRateMax: 3, authRateWindowMs: 60_000 }, async (base) => {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await fetch(
        `${base}/api/auth/login`,
        json({ email: 'user@example.com', password: 'guess-guess-guess' })
      );
      statuses.push(res.status);
    }

    assert.ok(statuses.includes(429), `expected a 429 in ${statuses}`);
  });
});

// --- status codes are stable -------------------------------------------

test('auth endpoints return the documented status codes', async () => {
  await withServer({}, async (base) => {
    const { auth, body } = await signUp(base, 'codes@example.com');

    // 401 for bad credentials, not 400.
    const badLogin = await fetch(
      `${base}/api/auth/login`,
      json({ email: 'codes@example.com', password: 'wrong-password' })
    );
    assert.equal(badLogin.status, 401, 'a wrong password is 401, not a client error');
    assert.match((await badLogin.json()).error, /incorrect email or password/i);

    // 401 without a session.
    assert.equal((await fetch(`${base}/api/auth/me`)).status, 401);
    assert.equal((await fetch(`${base}/api/auth/logout`, { method: 'POST' })).status, 200);

    // 400 for malformed input.
    assert.equal(
      (await fetch(`${base}/api/auth/register`, json({ email: 'nope', password: 'long-enough-1' }))).status,
      400
    );
    assert.equal(
      (await fetch(`${base}/api/auth/register`, json({ email: 'x@y.co', password: 'short' }))).status,
      400
    );

    // 409 for a duplicate account.
    assert.equal((await fetch(`${base}/api/auth/register`, json({ email: 'codes@example.com', password: 'long-enough-1' }))).status, 409);

    // 403 for a permission failure, 404 for a missing resource.
    const guest = await (await create(base, { destinationUrl: 'https://a.co/x' })).json();
    assert.equal(
      (await fetch(`${base}/api/links/${guest.id}`, { method: 'DELETE' })).status,
      403
    );
    assert.equal(
      (await fetch(`${base}/api/links/999999`, { method: 'DELETE', headers: auth })).status,
      404
    );

    assert.ok(body.token && auth.Authorization);
  });
});

test('a wrong password is not reported as a 400', async () => {
  await withServer({}, async (base) => {
    await signUp(base, 'status@example.com', 'the-real-password');

    const res = await fetch(
      `${base}/api/auth/login`,
      json({ email: 'status@example.com', password: 'the-wrong-password' })
    );

    // A client bug would be 400; bad credentials are an auth failure.
    assert.equal(res.status, 401);
  });
});

// --- password reset ---------------------------------------------------

test('forgot-password always answers the same way', async () => {
  await withServer({}, async (base) => {
    const existingRes = await fetch(`${base}/api/auth/forgot-password`, json({ email: 'real@example.com' }));
    const unknownRes = await fetch(`${base}/api/auth/forgot-password`, json({ email: 'ghost@example.com' }));

    const existing = await existingRes.json();
    const unknown = await unknownRes.json();

    assert.equal(existingRes.status, unknownRes.status);
    assert.deepEqual(existing, unknown);
    assert.match(existing.message, /if that address/i);
  });

  await withServer({}, async (base, pool) => {
    await signUp(base, 'real@example.com');
    await fetch(`${base}/api/auth/forgot-password`, json({ email: 'real@example.com' }));

    assert.equal(pool.resets.length, 1, 'a token is stored for the real account');
    assert.equal(pool.resets[0].used_at, null);
  });
});

test('forgot-password rejects a malformed email', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/auth/forgot-password`, json({ email: 'nope' }));
    assert.equal(res.status, 400);
  });
});

test('a reset token changes the password and revokes sessions', async () => {
  await withServer({}, async (base, pool) => {
    const { auth, body } = await signUp(base, 'reset@example.com', 'old-password-1');

    assert.equal((await fetch(`${base}/api/auth/me`, { headers: auth })).status, 200);
    assert.equal(pool.sessions.length, 1);

    // Grab the token from the stored digest by replaying issuePasswordReset
    // through the same code path the endpoint uses.
    const { issuePasswordReset } = await import('../lib/tokens.js');
    const issued = await issuePasswordReset(pool.query, 'reset@example.com');
    assert.ok(issued.token);

    const res = await fetch(
      `${base}/api/auth/reset-password`,
      json({ token: issued.token, password: 'new-password-2' })
    );
    assert.equal(res.status, 200);

    // The old session must be gone.
    assert.equal(pool.sessions.length, 0, 'sessions are revoked on reset');
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: auth })).status, 401);

    // Old password no longer works; new one does.
    const oldLogin = await fetch(`${base}/api/auth/login`, json({ email: 'reset@example.com', password: 'old-password-1' }));
    assert.equal(oldLogin.status, 401);

    const newLogin = await fetch(`${base}/api/auth/login`, json({ email: 'reset@example.com', password: 'new-password-2' }));
    assert.equal(newLogin.status, 200);
    assert.ok(body.token);
  });
});

test('a reset token is single-use', async () => {
  await withServer({}, async (base, pool) => {
    await signUp(base, 'once@example.com', 'old-password-1');
    const { issuePasswordReset } = await import('../lib/tokens.js');
    const issued = await issuePasswordReset(pool.query, 'once@example.com');

    const first = await fetch(
      `${base}/api/auth/reset-password`,
      json({ token: issued.token, password: 'brand-new-pass-9' })
    );
    assert.equal(first.status, 200);

    const replay = await fetch(
      `${base}/api/auth/reset-password`,
      json({ token: issued.token, password: 'another-pass-123' })
    );
    assert.equal(replay.status, 400, 'the same token must not work twice');
    assert.match((await replay.json()).error, /invalid or has expired/i);
  });
});

test('invalid reset tokens are indistinguishable from expired ones', async () => {
  await withServer({}, async (base) => {
    const garbageRes = await fetch(
      `${base}/api/auth/reset-password`,
      json({ token: 'password_reset.totally-made-up', password: 'whatever-1234' })
    );
    const malformedRes = await fetch(
      `${base}/api/auth/reset-password`,
      json({ token: 'garbage', password: 'whatever-1234' })
    );

    const garbage = await garbageRes.json();
    const malformed = await malformedRes.json();

    assert.equal(garbageRes.status, malformedRes.status);
    assert.deepEqual(garbage, malformed);
  });
});

test('reset validates the new password', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(
      `${base}/api/auth/reset-password`,
      json({ token: 'password_reset.whatever-1234567', password: 'short' })
    );
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /at least 8/);
  });
});

test('a verification token confirms the address exactly once', async () => {
  await withServer({}, async (base, pool) => {
    const { body } = await signUp(base, 'verify@example.com');
    assert.equal(pool.verifications.length, 1, 'registering queues a verification');

    const user = pool.users.find((u) => u.email === 'verify@example.com');
    assert.equal(user.email_verified_at, null, 'unverified until confirmed');

    // The raw token is never stored, so re-issue one to exercise the endpoint.
    const { issueEmailVerification } = await import('../lib/tokens.js');
    const issued = await issueEmailVerification(pool.query, user.id, user.email);
    assert.ok(issued.token);
    assert.ok(body.token);

    const res = await fetch(`${base}/api/auth/verify-email`, json({ token: issued.token }));
    assert.equal(res.status, 200);
    assert.ok(user.email_verified_at, 'the address is now verified');

    const replay = await fetch(`${base}/api/auth/verify-email`, json({ token: issued.token }));
    assert.equal(replay.status, 400, 'a verification token is single-use');
  });
});

test('every user response agrees on the verification state', async () => {
  await withServer({}, async (base) => {
    // register, login and /me must all report emailVerified: the banner is
    // driven off that field, and a response that omits it hides the prompt
    // until the next page load.
    const { body, auth } = await signUp(base, 'agree@example.com');

    assert.equal(
      body.user.emailVerified,
      false,
      'register must report the address as unconfirmed'
    );

    const me = await (await fetch(`${base}/api/auth/me`, { headers: auth })).json();
    assert.equal(me.user.emailVerified, false, '/me must agree with register');

    const login = await fetch(
      `${base}/api/auth/login`,
      json({ email: 'agree@example.com', password: 'hunter2hunter2' })
    );
    const loggedIn = await login.json();
    assert.equal(loggedIn.user.emailVerified, false, 'login must agree too');
  });
});

test('the session endpoint keeps reporting the verification state', async () => {
  await withServer({}, async (base, pool) => {
    const { body, auth } = await signUp(base, 'state@example.com');

    // The frontend keys its "confirm your address" banner off
    // user.emailVerified === false. If /api/auth/me omits the field the banner
    // never appears after a reload, leaving no prompt to confirm at all.
    const before = await fetch(`${base}/api/auth/me`, { headers: auth });
    assert.equal(before.status, 200);
    const beforeUser = (await before.json()).user;
    assert.equal(
      beforeUser.emailVerified,
      false,
      'an unconfirmed address must be reported as unconfirmed on every load'
    );

    const user = pool.users.find((u) => u.email === 'state@example.com');
    const { issueEmailVerification } = await import('../lib/tokens.js');
    const issued = await issueEmailVerification(pool.query, user.id, user.email);
    await fetch(`${base}/api/auth/verify-email`, json({ token: issued.token }));

    const after = await fetch(`${base}/api/auth/me`, { headers: auth });
    assert.equal((await after.json()).user.emailVerified, true);

    // Sanity: the register response carried it too, so the two agree.
    assert.equal(body.user.emailVerified, false);
  });
});

test('resend-verification requires a session', async () => {
  await withServer({}, async (base) => {
    const anonymous = await fetch(`${base}/api/auth/resend-verification`, { method: 'POST' });
    assert.equal(anonymous.status, 401);

    const { auth } = await signUp(base, 'resend@example.com');
    const authed = await fetch(`${base}/api/auth/resend-verification`, {
      method: 'POST',
      headers: auth,
    });
    assert.equal(authed.status, 200);
  });
});

// --- session housekeeping ----------------------------------------------

test('pruneExpiredSessions removes only expired rows', async () => {
  await withServer({}, async (base, pool) => {
    const live = await signUp(base, 'keep@example.com');
    const doomed = await signUp(base, 'drop@example.com');

    assert.equal(pool.sessions.length, 2);

    // Expire exactly one session, by matching the token digest.
    const doomedDigest = createHash('sha256').update(doomed.body.token).digest('base64url');
    const target = pool.sessions.find((s) => s.token_hash === doomedDigest);
    assert.ok(target, 'the doomed session should be present');
    target.expires_at = new Date(Date.now() - 1000).toISOString();

    const removed = await pruneExpiredSessions(pool.query);
    assert.equal(removed, 1, 'exactly the expired session should go');

    // The live session survives, and its token still authenticates.
    const liveDigest = createHash('sha256').update(live.body.token).digest('base64url');
    assert.ok(
      pool.sessions.some((s) => s.token_hash === liveDigest),
      'the unexpired session must not be touched'
    );

    const me = await fetch(`${base}/api/auth/me`, {
      headers: { Authorization: `Bearer ${live.body.token}` },
    });
    assert.equal(me.status, 200, 'the surviving token must still work');
  });
});

test('pruneExpiredSessions is a no-op when nothing has expired', async () => {
  await withServer({}, async (base, pool) => {
    await signUp(base);
    const before = pool.sessions.length;

    assert.equal(await pruneExpiredSessions(pool.query), 0);
    assert.equal(pool.sessions.length, before);
  });
});

test('expired sessions are refused', async () => {
  await withServer({}, async (base, pool) => {
    const { auth, body } = await signUp(base);
    pool.sessions[0].expires_at = new Date(Date.now() - 1000).toISOString();

    const res = await fetch(`${base}/api/auth/me`, { headers: auth });
    assert.equal(res.status, 401);
    assert.ok(body.token);
  });
});

// --- favicon proxy ------------------------------------------------------

test('serves a favicon through the API', async () => {
  const icon = { ok: true, status: 200, url: 'https://example.com/favicon.ico',
    headers: { get: (n) => (n.toLowerCase() === 'content-type' ? 'image/png' : null) },
    arrayBuffer: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]) };

  await withServer({ fetchImpl: async () => icon }, async (base) => {
    const res = await fetch(`${base}/api/favicon?domain=example.com`);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('cache-control'), /max-age=86400/);
    assert.equal((await res.arrayBuffer()).byteLength, 4);
  });
});

test('returns 404 when a domain has no favicon', async () => {
  await withServer({ fetchImpl: async () => ({
    ok: false, status: 404, url: 'x', headers: { get: () => null } }) }, async (base) => {
    assert.equal((await fetch(`${base}/api/favicon?domain=nothing.test`)).status, 404);
  });
});

test('rejects internal addresses before making any request (SSRF)', async () => {
  let called = 0;
  const spy = {
    fetchImpl: async () => {
      called++;
      return {
        ok: true, status: 200, url: 'https://x/favicon.ico',
        headers: { get: () => 'image/png' },
        arrayBuffer: async () => Buffer.from([0x89, 0x50]),
      };
    },
  };

  await withServer(spy, async (base) => {
    for (const host of ['127.0.0.1', '169.254.169.254', '10.0.0.5', '192.168.1.1', 'localhost', '127.1']) {
      const res = await fetch(`${base}/api/favicon?domain=${host}`);
      assert.ok(res.status === 400 || res.status === 404, `${host} -> ${res.status}`);
    }

    assert.equal(called, 0, 'no outbound request may be made for an internal address');
  });
});

test('rejects a non-hostname domain before making any request', async () => {
  let called = 0;
  await withServer({ fetchImpl: async () => { called++; return { ok: false, status: 404, url: '', headers: { get: () => null } }; } },
    async (base) => {
      for (const bad of ['', 'localhost', 'http://x.com', 'x.com/path', 'user@x.com', 'a'.repeat(300)]) {
        const res = await fetch(`${base}/api/favicon?domain=${encodeURIComponent(bad)}`);
        assert.equal(res.status, 400, `${bad} must be rejected`);
      }
      assert.equal(called, 0);
    });
});

// --- link creation ------------------------------------------------------

test('creates a link as a guest and returns a one-time owner token', async () => {
  await withServer({}, async (base) => {
    const res = await create(base, { destinationUrl: 'https://example.com/page' });
    assert.equal(res.status, 201);

    const body = await res.json();
    assert.equal(body.destinationUrl, 'https://example.com/page');
    assert.equal(body.shortUrl, `https://lnk.test/${body.code}`);
    assert.ok(body.ownerToken && body.ownerToken.length === 43);
    assert.equal(body.owned, true);
  });
});

test('a signed-in creator gets no guest token', async () => {
  await withServer({}, async (base) => {
    const { auth } = await signUp(base);
    const res = await create(base, { destinationUrl: 'https://example.com/x' }, auth);

    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal('ownerToken' in body, false, 'account links use sessions, not guest tokens');
  });
});

test('listing links never leaks owner tokens', async () => {
  await withServer({}, async (base) => {
    const { auth } = await signUp(base);
    await create(base, { destinationUrl: 'https://example.com/a' }, auth);

    const body = await (await fetch(`${base}/api/links`, { headers: auth })).json();
    assert.equal(body.length, 1);
    assert.equal('ownerToken' in body[0], false);
    assert.equal('owner_token' in body[0], false);
  });
});

test('rejects invalid destinations and aliases', async () => {
  await withServer({}, async (base) => {
    for (const destinationUrl of ['', 'not a url', 'javascript:alert(1)', 'ftp://x.com']) {
      const res = await create(base, { destinationUrl });
      assert.equal(res.status, 400, `${destinationUrl} should be rejected`);
    }

    for (const customAlias of ['ab', 'a'.repeat(31), 'has space', 'sym$bol']) {
      const res = await create(base, { destinationUrl: 'https://a.co/x', customAlias });
      assert.equal(res.status, 400, `${customAlias} should be rejected`);
    }
  });
});

test('duplicate custom alias returns 409, not 500', async () => {
  await withServer({}, async (base) => {
    const first = await create(base, {
      destinationUrl: 'https://a.co/one',
      customAlias: 'my-slug',
    });
    assert.equal(first.status, 201);

    const second = await create(base, {
      destinationUrl: 'https://a.co/two',
      customAlias: 'my-slug',
    });
    assert.equal(second.status, 409);
    assert.match((await second.json()).error, /already in use/i);
  });
});

test('honours custom aliases', async () => {
  await withServer({}, async (base) => {
    const res = await create(base, {
      destinationUrl: 'https://a.co/x',
      customAlias: 'launch_2026',
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).code, 'launch_2026');
  });
});

test('generated codes do not encode the row id', async () => {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const base62Value = (code) =>
    [...code].reduce((acc, ch) => acc * 62 + alphabet.indexOf(ch), 0);

  await withServer({}, async (base, pool) => {
    const codes = new Set();
    for (let i = 0; i < 25; i++) {
      const body = await (await create(base, { destinationUrl: `https://a.co/${i}` })).json();
      codes.add(body.code);
    }

    assert.equal(codes.size, 25, 'codes must be unique');

    // The old scheme was base62(id), which made every code enumerable.
    for (const row of pool.rows) {
      assert.notEqual(base62Value(row.code), Number(row.id));
    }
  });
});

test('can require an API key for creation', async () => {
  await withServer({ apiKey: 'secret-key', requireApiKeyToCreate: true }, async (base) => {
    assert.equal((await create(base, { destinationUrl: 'https://a.co/x' })).status, 401);
    assert.equal(
      (await create(base, { destinationUrl: 'https://a.co/x' }, { 'x-api-key': 'secret-key' })).status,
      201
    );
  });
});

test('rate limits link creation', async () => {
  await withServer({ createRateMax: 3, createRateWindowMs: 60_000 }, async (base) => {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await create(base, { destinationUrl: `https://a.co/${i}` })).status);
    }

    assert.deepEqual(statuses.slice(0, 3), [201, 201, 201]);
    assert.ok(statuses.slice(3).every((s) => s === 429), `got ${statuses}`);
  });
});

// --- listing isolation --------------------------------------------------

test('listing requires authentication', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/api/links`)).status, 401);
  });
});

test('accounts only see their own links', async () => {
  await withServer({}, async (base) => {
    const alice = await signUp(base, 'alice@example.com');
    const bob = await signUp(base, 'bob@example.com');

    const aliceLink = await (await create(base, { destinationUrl: 'https://a.co/alice' }, alice.auth)).json();
    const bobLink = await (await create(base, { destinationUrl: 'https://a.co/bob' }, bob.auth)).json();

    const aliceList = await (await fetch(`${base}/api/links`, { headers: alice.auth })).json();
    const bobList = await (await fetch(`${base}/api/links`, { headers: bob.auth })).json();

    assert.equal(aliceList.length, 1);
    assert.equal(aliceList[0].id, aliceLink.id);
    assert.equal(bobList.length, 1);
    assert.equal(bobList[0].id, bobLink.id);

    // Bob must not see Alice's link even by guessing its id.
    assert.equal(aliceList.some((l) => l.id === bobLink.id), false);
  });
});

test('the operator key can list every link', async () => {
  await withServer({ apiKey: 'master' }, async (base) => {
    const alice = await signUp(base, 'alice@example.com');
    await create(base, { destinationUrl: 'https://a.co/1' }, alice.auth);
    await create(base, { destinationUrl: 'https://a.co/2' }); // guest

    const all = await (
      await fetch(`${base}/api/links?limit=100`, { headers: { 'x-api-key': 'master' } })
    ).json();

    assert.equal(all.length, 2);
  });
});

// --- redirect -----------------------------------------------------------

test('redirects and increments the click counter', async () => {
  await withServer({ apiKey: 'operator' }, async (base) => {
    const created = await (await create(base, { destinationUrl: 'https://example.com/target' })).json();

    for (let i = 1; i <= 3; i++) {
      const res = await fetch(`${base}/${created.code}`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), 'https://example.com/target');
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }

    const listed = await (
      await fetch(`${base}/api/links`, { headers: { 'x-api-key': 'operator' } })
    ).json();
    assert.equal(listed[0].clicks, 3, 'each redirect must increment exactly once');
  });
});

test('the click counter saturates instead of overflowing the integer column', async () => {
  // `clicks integer` tops out at 2147483647. Past that, `clicks + 1` raises
  // Postgres 22003, which turned every *subsequent* click into a 500 — the link
  // broke permanently because of a counter nobody reads to the unit.
  const CEILING = 2147483647;
  const clicks = new Map();

  const pool = {
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ').trim();

      if (sql.startsWith('INSERT INTO links')) {
        const row = {
          id: 1,
          code: 'saturate',
          destination_url: 'https://example.com/target',
          user_id: null,
          owner_token: 'tok',
          clicks: 0,
          created_at: new Date().toISOString(),
        };
        return { rows: [row] };
      }

      if (sql.startsWith('UPDATE links SET clicks')) {
        // $1 is the code, $2 is the ceiling.
        const ceiling = params[1];
        assert.equal(
          sql.includes('CASE WHEN clicks >= $2'),
          true,
          'the increment must be conditional, or it overflows the column'
        );
        const current = clicks.get(params[0]) ?? 0;
        // Mirrors the CASE expression the route issues.
        const next = current >= ceiling ? ceiling : current + 1;
        clicks.set(params[0], next);
        return { rows: [{ destination_url: 'https://example.com/target' }], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
  };

  const app = createApp({ pool, redirectRateMax: 10000 });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // One below the ceiling: must still increment.
    clicks.set('saturate', CEILING - 1);
    let res = await fetch(`${base}/saturate`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(clicks.get('saturate'), CEILING);

    // At the ceiling: must hold, and must not become a server error.
    for (let i = 0; i < 3; i++) {
      res = await fetch(`${base}/saturate`, { redirect: 'manual' });
      assert.equal(res.status, 302, `click ${i + 1} past the ceiling must still redirect`);
      assert.equal(res.headers.get('location'), 'https://example.com/target');
    }
    assert.equal(clicks.get('saturate'), CEILING, 'the counter must saturate, not wrap');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('unknown short code returns 404', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/nosuchcode`, { redirect: 'manual' })).status, 404);
  });
});

test('rate limits redirects', async () => {
  await withServer({ redirectRateMax: 2, redirectRateWindowMs: 60_000 }, async (base) => {
    const created = await (await create(base, { destinationUrl: 'https://example.com/t' })).json();

    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await fetch(`${base}/${created.code}`, { redirect: 'manual' })).status);
    }

    assert.equal(statuses[0], 302);
    assert.ok(statuses.includes(429), `expected a 429 in ${statuses}`);
  });
});

// --- deletion authorisation --------------------------------------------

test('rejects deletion without the owner token', async () => {
  await withServer({ apiKey: 'operator' }, async (base) => {
    const created = await (await create(base, { destinationUrl: 'https://a.co/x' })).json();

    assert.equal((await fetch(`${base}/api/links/${created.id}`, { method: 'DELETE' })).status, 403);
    assert.equal(
      (
        await fetch(`${base}/api/links/${created.id}`, {
          method: 'DELETE',
          headers: { 'x-owner-token': 'not-the-right-token' },
        })
      ).status,
      403
    );

    // The link must still be there.
    const all = await (
      await fetch(`${base}/api/links?limit=100`, { headers: { 'x-api-key': 'operator' } })
    ).json();
    assert.equal(all.length, 1);
  });
});

test('allows guest deletion with the owner token', async () => {
  await withServer({}, async (base, pool) => {
    const created = await (await create(base, { destinationUrl: 'https://a.co/x' })).json();

    const res = await fetch(`${base}/api/links/${created.id}`, {
      method: 'DELETE',
      headers: { 'x-owner-token': created.ownerToken },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).success, true);
    assert.equal(pool.rows.length, 0, 'the row must actually be gone');
  });
});

test('allows account deletion with a session', async () => {
  await withServer({}, async (base) => {
    const { auth } = await signUp(base);
    const created = await (await create(base, { destinationUrl: 'https://a.co/x' }, auth)).json();

    const res = await fetch(`${base}/api/links/${created.id}`, { method: 'DELETE', headers: auth });
    assert.equal(res.status, 200);

    const list = await (await fetch(`${base}/api/links`, { headers: auth })).json();
    assert.equal(list.length, 0);
  });
});

test('one account cannot delete another account’s link', async () => {
  await withServer({}, async (base) => {
    const alice = await signUp(base, 'alice@example.com');
    const bob = await signUp(base, 'bob@example.com');

    const aliceLink = await (await create(base, { destinationUrl: 'https://a.co/a' }, alice.auth)).json();

    const res = await fetch(`${base}/api/links/${aliceLink.id}`, {
      method: 'DELETE',
      headers: bob.auth,
    });
    assert.equal(res.status, 403);

    const list = await (await fetch(`${base}/api/links`, { headers: alice.auth })).json();
    assert.equal(list.length, 1);
  });
});

test('a guest owner token cannot delete an account-owned link', async () => {
  await withServer({}, async (base) => {
    const { auth } = await signUp(base);
    const link = await (await create(base, { destinationUrl: 'https://a.co/x' }, auth)).json();

    // Guessing a token should never work, and the link has no token at all.
    const res = await fetch(`${base}/api/links/${link.id}`, {
      method: 'DELETE',
      headers: { 'x-owner-token': 'guessed' },
    });
    assert.equal(res.status, 403);
  });
});

test('operator API key overrides ownership, including legacy rows', async () => {
  await withServer({ apiKey: 'master-key' }, async (base, pool) => {
    // A row created before owner tokens or accounts existed.
    pool.rows.push({
      id: '999',
      code: 'legacy',
      destination_url: 'https://a.co/legacy',
      clicks: 0,
      user_id: null,
      owner_token: null,
      created_at: new Date().toISOString(),
    });

    assert.equal((await fetch(`${base}/api/links/999`, { method: 'DELETE' })).status, 403);
    assert.equal(
      (
        await fetch(`${base}/api/links/999`, {
          method: 'DELETE',
          headers: { 'x-api-key': 'master-key' },
        })
      ).status,
      200
    );
  });
});

test('deletion of an unknown id returns 404 without leaking existence', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/links/424242`, {
      method: 'DELETE',
      headers: { 'x-owner-token': 'anything' },
    });
    assert.equal(res.status, 404);
  });
});

test('an owner token for one link cannot delete another', async () => {
  await withServer({}, async (base) => {
    const a = await (await create(base, { destinationUrl: 'https://a.co/a' })).json();
    const b = await (await create(base, { destinationUrl: 'https://a.co/b' })).json();

    const res = await fetch(`${base}/api/links/${b.id}`, {
      method: 'DELETE',
      headers: { 'x-owner-token': a.ownerToken },
    });
    assert.equal(res.status, 403);
  });
});