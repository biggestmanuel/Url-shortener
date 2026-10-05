import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/**
 * Per-link secret returned exactly once, at creation time. Deleting a guest
 * link requires it, so an anonymous visitor cannot destroy everyone's links.
 */
export function generateOwnerToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Session credentials. Only the digest is persisted, so a leaked database
 * cannot be replayed as live sessions.
 */
export function generateSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('base64url');
}

/**
 * Length-safe, timing-safe string comparison. When lengths differ we still run
 * a dummy comparison so response time does not leak the secret's length.
 */
export function timingSafeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;

  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');

  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/**
 * Hashes a password with scrypt and a per-password random salt.
 * Format: scrypt$N$r$p$<salt>$<hash>
 */
export function hashPassword(password, options = SCRYPT) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, options.keylen, {
    N: options.N,
    r: options.r,
    p: options.p,
    // scrypt needs roughly 128 * N * r bytes; the default is too small.
    maxmem: 256 * options.N * options.r,
  });

  return [
    'scrypt',
    options.N,
    options.r,
    options.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64url');
    expected = Buffer.from(parts[5], 'base64url');
  } catch {
    return false;
  }

  if (expected.length === 0) return false;

  let derived;
  try {
    derived = crypto.scryptSync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 256 * N * r,
    });
  } catch {
    return false;
  }

  return crypto.timingSafeEqual(derived, expected);
}

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;

export function validatePassword(password) {
  if (typeof password !== 'string') return 'Password is required';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  // scrypt is deliberately slow; an unbounded input is a cheap DoS.
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  return null;
}

export function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return 'Email is required';
  if (normalized.length > 254) return 'Email is too long';
  if (!EMAIL_PATTERN.test(normalized)) return 'Enter a valid email address';
  return null;
}

// ---------------------------------------------------------------------------
// Request authorisation helpers
// ---------------------------------------------------------------------------

/**
 * Optional operator-level key. When configured it acts as a master key for
 * any destructive or administrative action.
 */
export function hasValidApiKey(req, apiKey) {
  if (!apiKey) return false;
  return timingSafeEquals(req.get('x-api-key') || '', apiKey);
}

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Resolves the signed-in user from a Bearer session token.
 *
 * Looked up by token digest only, so no hash comparison is needed and an
 * invalid token cannot be distinguished from an expired one by timing.
 */
export async function resolveSession(query, req) {
  const token = bearerToken(req);
  if (!token) return null;

  const digest = hashToken(token);
  const result = await query(
    // email_verified_at must be selected here: /api/auth/me reports the user
    // from this row, and toUserResponse omits `emailVerified` when the column
    // is absent. That silently hid the "confirm your address" banner on every
    // page load after registration.
    `SELECT s.id AS session_id, s.expires_at, u.id, u.email, u.email_verified_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.expires_at > now()
      LIMIT 1`,
    [digest]
  );

  return result.rows[0] ?? null;
}

/**
 * Decides whether `req` may delete `row`.
 *
 * Precedence: operator API key, then session owning the row, then the guest
 * owner token. Legacy rows with neither are not deletable by anyone but the
 * operator key.
 */
export function canDeleteLink(req, row, session, apiKey) {
  if (hasValidApiKey(req, apiKey)) return true;

  if (row.user_id && session && String(row.user_id) === String(session.id)) {
    return true;
  }

  if (row.owner_token) {
    return timingSafeEquals(req.get('x-owner-token') || '', row.owner_token);
  }

  return false;
}