import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generatePurposeToken,
  hashPurposeToken,
  readPurpose,
  issuePasswordReset,
  consumePasswordReset,
  issueEmailVerification,
  consumeEmailVerification,
  RESET_PURPOSE,
  VERIFY_PURPOSE,
} from '../lib/tokens.js';
import { hashPassword, verifyPassword } from '../lib/auth.js';

/**
 * Minimal query double for the token flows. Records every call so the tests
 * can assert on what was actually persisted, not just the return value.
 */
function createQueryStub(users = []) {
  const calls = [];
  const resets = [];
  const verifications = [];
  const sessions = [];
  let nextResetId = 1;
  let nextVerificationId = 1;

  const query = async (text, params = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    calls.push({ sql, params });

    // The real statement resolves the user from the email in a subquery, so
    // the stub does the same before matching.
    if (sql.startsWith('UPDATE password_resets SET used_at = now() WHERE user_id')) {
      const target = users.find((u) => u.email === params[0]);
      let n = 0;
      if (target) {
        for (const r of resets) {
          if (String(r.user_id) === String(target.id) && !r.used_at) {
            r.used_at = new Date().toISOString();
            n++;
          }
        }
      }
      return { rows: [], rowCount: n };
    }

    if (sql.startsWith('UPDATE password_resets SET used_at = now() WHERE id')) {
      const r = resets.find((x) => String(x.id) === String(params[0]));
      if (r) r.used_at = new Date().toISOString();
      return { rows: [], rowCount: r ? 1 : 0 };
    }

    if (sql.startsWith('SELECT * FROM users WHERE email')) {
      return { rows: users.filter((u) => u.email === params[0]) };
    }

    if (sql.startsWith('INSERT INTO password_resets')) {
      const row = {
        id: String(nextResetId++),
        user_id: params[0],
        token_hash: params[1],
        purpose: params[2],
        expires_at: params[3],
        used_at: null,
      };
      resets.push(row);
      return { rows: [row], rowCount: 1 };
    }

    // Atomic claim: consume and read in a single conditional UPDATE.
    if (sql.startsWith('UPDATE password_resets SET used_at = now() WHERE token_hash')) {
      const row = resets.find(
        (r) =>
          r.token_hash === params[0] &&
          r.purpose === params[1] &&
          !r.used_at &&
          new Date(r.expires_at).getTime() > Date.now()
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.used_at = new Date().toISOString();
      return { rows: [{ user_id: row.user_id }], rowCount: 1 };
    }

    if (sql.startsWith('SELECT r.id, r.user_id')) {
      const row = resets.find(
        (r) =>
          r.token_hash === params[0] &&
          r.purpose === params[1] &&
          !r.used_at &&
          new Date(r.expires_at).getTime() > Date.now()
      );
      return { rows: row ? [{ id: row.id, user_id: row.user_id }] : [] };
    }

    if (sql.startsWith('UPDATE users SET password_hash')) {
      const user = users.find((u) => String(u.id) === String(params[1]));
      if (user) user.password_hash = params[0];
      return { rows: [], rowCount: user ? 1 : 0 };
    }

    if (sql.startsWith('DELETE FROM sessions WHERE user_id')) {
      const before = sessions.length;
      for (let i = sessions.length - 1; i >= 0; i--) {
        if (String(sessions[i].user_id) === String(params[0])) sessions.splice(i, 1);
      }
      return { rows: [], rowCount: before - sessions.length };
    }

    if (sql.startsWith('UPDATE email_verifications SET used_at = now() WHERE user_id')) {
      let n = 0;
      for (const v of verifications) {
        if (String(v.user_id) === String(params[0]) && !v.used_at) {
          v.used_at = new Date().toISOString();
          n++;
        }
      }
      return { rows: [], rowCount: n };
    }

    if (sql.startsWith('UPDATE email_verifications SET used_at = now() WHERE id')) {
      const v = verifications.find((x) => String(x.id) === String(params[0]));
      if (v) v.used_at = new Date().toISOString();
      return { rows: [], rowCount: v ? 1 : 0 };
    }

    if (sql.startsWith('INSERT INTO email_verifications')) {
      const row = {
        id: String(nextVerificationId++),
        user_id: params[0],
        token_hash: params[1],
        expires_at: params[2],
        used_at: null,
      };
      verifications.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE email_verifications SET used_at = now() WHERE token_hash')) {
      const row = verifications.find(
        (v) =>
          v.token_hash === params[0] && !v.used_at && new Date(v.expires_at).getTime() > Date.now()
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.used_at = new Date().toISOString();
      return { rows: [{ user_id: row.user_id }], rowCount: 1 };
    }

    if (sql.startsWith('SELECT id, user_id FROM email_verifications')) {
      const row = verifications.find(
        (v) =>
          v.token_hash === params[0] && !v.used_at && new Date(v.expires_at).getTime() > Date.now()
      );
      return { rows: row ? [{ id: row.id, user_id: row.user_id }] : [] };
    }

    if (sql.startsWith('UPDATE users SET email_verified_at')) {
      const user = users.find((u) => String(u.id) === String(params[0]));
      if (user) user.email_verified_at = new Date().toISOString();
      return { rows: [], rowCount: user ? 1 : 0 };
    }

    throw new Error(`Unhandled SQL: ${sql}`);
  };

  return { query, calls, resets, verifications, sessions, users };
}

// --- token shape --------------------------------------------------------

test('tokens encode their purpose and carry no plaintext', () => {
  const token = generatePurposeToken(RESET_PURPOSE);

  assert.ok(token.startsWith(`${RESET_PURPOSE}.`));
  assert.equal(token.split('.')[1].length, 43, '256 bits of base64url entropy');
  assert.notEqual(hashPurposeToken(token), token);
  assert.equal(hashPurposeToken(token).length, 43);
});

test('generated tokens are unique', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(generatePurposeToken(RESET_PURPOSE));
  assert.equal(seen.size, 5000);
});

test('readPurpose only accepts known purposes', () => {
  assert.equal(readPurpose(generatePurposeToken(RESET_PURPOSE)), RESET_PURPOSE);
  assert.equal(readPurpose(generatePurposeToken(VERIFY_PURPOSE)), VERIFY_PURPOSE);

  for (const bad of ['', 'nonsense', '.onlysecret', 'reset.', 'admin.' + 'x'.repeat(20), null, 42]) {
    assert.equal(readPurpose(bad), null, `${String(bad)} must not parse`);
  }
});

test('a verification token cannot be used as a reset token', async () => {
  const { query, resets } = createQueryStub();
  const token = generatePurposeToken(VERIFY_PURPOSE);

  const result = await consumePasswordReset(query, token, 'new-password-1', { hashPassword });
  assert.equal(result.ok, false);
  assert.equal(resets.length, 0);
});

// --- issuing ------------------------------------------------------------

test('an unknown address still reports success and stores nothing', async () => {
  const { query, resets } = createQueryStub();

  const result = await issuePasswordReset(query, 'ghost@example.com');

  assert.equal(result.delivered, true);
  assert.equal(result.token, null, 'no token leaks for an unknown address');
  assert.equal(result.user, null);
  assert.equal(resets.length, 0);
});

test('a known address gets a token, stored only as a digest', async () => {
  const user = { id: '1', email: 'real@example.com', password_hash: 'x' };
  const { query, resets } = createQueryStub([user]);

  const result = await issuePasswordReset(query, 'real@example.com');

  assert.ok(result.token);
  assert.equal(resets.length, 1);
  assert.equal(resets[0].token_hash, hashPurposeToken(result.token));
  assert.ok(!resets[0].token_hash.includes(result.token.split('.')[1]), 'raw secret must not be stored');
});

test('issuing a second reset invalidates the first', async () => {
  const user = { id: '1', email: 'real@example.com', password_hash: 'x' };
  const { query, resets } = createQueryStub([user]);

  const first = await issuePasswordReset(query, 'real@example.com');
  const second = await issuePasswordReset(query, 'real@example.com');

  assert.ok(first.token !== second.token);
  assert.equal(resets.length, 2);
  assert.ok(resets[0].used_at, 'the earlier token is spent');
  assert.equal(resets[1].used_at, null);

  // And the older token no longer works.
  const result = await consumePasswordReset(query, first.token, 'whatever-1234', { hashPassword });
  assert.equal(result.ok, false);
});

// --- consuming ----------------------------------------------------------

test('a reset sets a fresh salt and revokes sessions', async () => {
  const user = {
    id: '1',
    email: 'real@example.com',
    password_hash: hashPassword('original-pass-1'),
  };
  const { query, sessions } = createQueryStub([user]);
  sessions.push({ id: 's1', user_id: '1' }, { id: 's2', user_id: '1' });

  const issued = await issuePasswordReset(query, 'real@example.com');
  const result = await consumePasswordReset(query, issued.token, 'replacement-2', { hashPassword });

  assert.equal(result.ok, true);
  assert.equal(verifyPassword('replacement-2', user.password_hash), true);
  assert.equal(verifyPassword('original-pass-1', user.password_hash), false);
  assert.notEqual(user.password_hash, 'original-pass-1');
  assert.equal(sessions.length, 0, 'every session is revoked');
});

test('a reset token works exactly once', async () => {
  const user = { id: '1', email: 'real@example.com', password_hash: 'x' };
  const { query } = createQueryStub([user]);

  const issued = await issuePasswordReset(query, 'real@example.com');
  assert.equal((await consumePasswordReset(query, issued.token, 'first-pass-1', { hashPassword })).ok, true);

  const replay = await consumePasswordReset(query, issued.token, 'second-pass-2', { hashPassword });
  assert.equal(replay.ok, false);
  assert.match(replay.error, /invalid or has expired/i);
});

test('an expired token is refused', async () => {
  const user = { id: '1', email: 'real@example.com', password_hash: 'x' };
  const { query, resets } = createQueryStub([user]);

  const issued = await issuePasswordReset(query, 'real@example.com', { ttlMinutes: 1 });
  assert.ok(issued.token);

  // Age the stored row past its expiry.
  resets[0].expires_at = new Date(Date.now() - 1000).toISOString();

  const result = await consumePasswordReset(query, issued.token, 'new-pass-1', { hashPassword });
  assert.equal(result.ok, false);
  assert.match(result.error, /invalid or has expired/i);
});

test('every malformed token yields the same message', async () => {
  const { query } = createQueryStub();

  const results = [];
  for (const token of ['', 'garbage', 'password_reset.', 'password_reset.abc', 'admin.abc', null]) {
    results.push(await consumePasswordReset(query, token, 'new-pass-1', { hashPassword }));
  }

  const messages = new Set(results.map((r) => r.error));
  assert.equal(messages.size, 1, 'one message for every failure mode');
  for (const r of results) assert.equal(r.ok, false);
});

// --- verification -------------------------------------------------------

test('verification marks the user and is single-use', async () => {
  const user = { id: '7', email: 'new@example.com', email_verified_at: null };
  const { query, verifications } = createQueryStub([user]);

  const issued = await issueEmailVerification(query, '7', 'new@example.com');
  assert.ok(issued.token);
  assert.equal(user.email_verified_at, null);

  assert.equal((await consumeEmailVerification(query, issued.token)).ok, true);
  assert.ok(user.email_verified_at, 'address is confirmed');

  const replay = await consumeEmailVerification(query, issued.token);
  assert.equal(replay.ok, false);
  assert.equal(verifications.filter((v) => !v.used_at).length, 0);
});

test('a reset token cannot confirm an address', async () => {
  const user = { id: '7', email: 'new@example.com', email_verified_at: null };
  const { query } = createQueryStub([user]);

  const reset = generatePurposeToken(RESET_PURPOSE);
  const result = await consumeEmailVerification(query, reset);

  assert.equal(result.ok, false);
  assert.equal(user.email_verified_at, null);
});

test('re-issuing verification invalidates the previous token', async () => {
  const user = { id: '7', email: 'new@example.com', email_verified_at: null };
  const { query, verifications } = createQueryStub([user]);

  const first = await issueEmailVerification(query, '7', 'new@example.com');
  const second = await issueEmailVerification(query, '7', 'new@example.com');

  assert.equal((await consumeEmailVerification(query, first.token)).ok, false);
  assert.equal((await consumeEmailVerification(query, second.token)).ok, true);
  assert.equal(verifications.filter((v) => !v.used_at).length, 0);
});