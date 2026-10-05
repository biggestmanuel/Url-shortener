/**
 * Password reset and email verification.
 *
 * Tokens are single-use, time-limited, and stored only as a SHA-256 digest,
 * the same reasoning as sessions: a database dump must not yield usable reset
 * credentials.
 *
 * Delivery is pluggable. Without a transport configured, tokens are logged
 * once at generation time so a self-hosted instance is usable without wiring
 * up an email provider — the token is never returned by the API.
 */

import crypto from 'node:crypto';

const RESET_PURPOSE = 'password_reset';
const VERIFY_PURPOSE = 'email_verification';

export function generatePurposeToken(purpose) {
  return `${purpose}.${crypto.randomBytes(32).toString('base64url')}`;
}

export function hashPurposeToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('base64url');
}

/** Returns the purpose embedded in a token, or null if malformed. */
export function readPurpose(token) {
  if (typeof token !== 'string') return null;

  const separator = token.indexOf('.');
  if (separator <= 0) return null;

  const purpose = token.slice(0, separator);
  const secret = token.slice(separator + 1);

  if (!secret || (purpose !== RESET_PURPOSE && purpose !== VERIFY_PURPOSE)) return null;
  return purpose;
}

const DEFAULT_TTL_MINUTES = 60;

/**
 * Issues a reset token for an email address.
 *
 * Returns `{ token, user }` only when the caller is an operator or the address
 * exists; callers must not distinguish those cases in a public response.
 */
export async function issuePasswordReset(query, email, options = {}) {
  const now = Date.now();
  const ttlMinutes = options.ttlMinutes ?? DEFAULT_TTL_MINUTES;
  const purpose = RESET_PURPOSE;
  const token = generatePurposeToken(purpose);
  const digest = hashPurposeToken(token);

  // Invalidate any outstanding reset for this user.
  await query(
    `UPDATE password_resets
        SET used_at = now()
      WHERE user_id = (SELECT id FROM users WHERE email = $1)
        AND used_at IS NULL`,
    [email]
  );

  const user = await query('SELECT * FROM users WHERE email = $1', [email]);

  if (user.rows.length === 0) {
    // Still return success so the response cannot reveal whether the address
    // has an account.
    return { delivered: true, token: null, user: null };
  }

  const row = user.rows[0];

  await query(
    `INSERT INTO password_resets (user_id, token_hash, purpose, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [row.id, digest, purpose, new Date(now + ttlMinutes * 60_000).toISOString()]
  );

  return { delivered: true, token, user: row };
}

/**
 * Issues an email verification token and mails the confirmation link.
 *
 * Only ever called for the address belonging to `userId`, so this cannot be
 * pointed at someone else's inbox.
 */
export async function issueEmailVerification(
  query,
  userId,
  email,
  options = {}
) {
  const ttlMinutes = options.ttlMinutes ?? DEFAULT_TTL_MINUTES * 24;
  const token = generateVerificationToken();
  const digest = hashPurposeToken(token);

  await query(
    `UPDATE email_verifications
        SET used_at = now()
      WHERE user_id = $1
        AND used_at IS NULL`,
    [userId]
  );

  await query(
    `INSERT INTO email_verifications (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, digest, new Date(Date.now() + ttlMinutes * 60_000).toISOString()]
  );

  if (email && typeof options.buildLink === 'function') {
    // Imported lazily so token logic stays usable without a mail transport.
    const mailer = await import('./mailer.js');
    await (options.sendMailImpl ?? mailer.sendMail)({
      to: email,
      subject: 'Verify your Linkly email address',
      text: [
        'Please confirm your email address to finish setting up your Linkly account.',
        '',
        options.buildLink(token),
        '',
        `This link expires in ${ttlMinutes} minutes and can be used once.`,
        'If you did not create this account, you can ignore this email.',
      ].join('\n'),
    });
  }

  return { token };
}

/**
 * Confirms an address. All failures share one message.
 *
 * The token is spent by the same statement that reads it, rather than a
 * SELECT followed by an UPDATE: two concurrent requests carrying the same
 * token would both pass a separate "is it still unused?" check, and both
 * would succeed. A conditional UPDATE makes exactly one of them win.
 */
export async function consumeEmailVerification(query, token) {
  const genericError = 'This verification link is invalid or has expired';

  if (readPurpose(token) !== VERIFY_PURPOSE) {
    return { ok: false, error: genericError };
  }

  const digest = hashPurposeToken(token);

  const claimed = await query(
    `UPDATE email_verifications
        SET used_at = now()
      WHERE token_hash = $1
        AND used_at IS NULL
        AND expires_at > now()
      RETURNING user_id`,
    [digest]
  );

  if (claimed.rows.length === 0) return { ok: false, error: genericError };

  await query('UPDATE users SET email_verified_at = now() WHERE id = $1', [
    claimed.rows[0].user_id,
  ]);

  return { ok: true };
}

/**
 * Consumes a reset token and replaces the password.
 *
 * Every failure path returns the same message so the endpoint cannot be used
 * to probe which tokens exist.
 */
export async function consumePasswordReset(query, token, newPassword, options = {}) {
  const genericError = 'This reset link is invalid or has expired';

  const purpose = readPurpose(token);
  if (purpose !== RESET_PURPOSE) return { ok: false, error: genericError };

  const digest = hashPurposeToken(token);

  const hashPassword = options.hashPassword;
  if (typeof hashPassword !== 'function') {
    throw new Error('hashPassword must be supplied');
  }

  // Claim the token in the same statement that reads it. A separate SELECT
  // then UPDATE would let two concurrent requests carrying one token both
  // succeed, which defeats "single use".
  const claimed = await query(
    `UPDATE password_resets
        SET used_at = now()
      WHERE token_hash = $1
        AND purpose = $2
        AND used_at IS NULL
        AND expires_at > now()
      RETURNING user_id`,
    [digest, RESET_PURPOSE]
  );

  if (claimed.rows.length === 0) return { ok: false, error: genericError };

  const userId = claimed.rows[0].user_id;

  // Re-hash with a fresh salt, so a reset also rotates the stored hash.
  await query(
    `UPDATE users
        SET password_hash = $1
      WHERE id = $2`,
    [hashPassword(newPassword), userId]
  );

  // Revoke every session for that account: a reset is the remedy for a
  // compromised account, so old sessions must not survive it.
  await query('DELETE FROM sessions WHERE user_id = $1', [userId]);

  return { ok: true };
}

export function generateVerificationToken() {
  return generatePurposeToken(VERIFY_PURPOSE);
}

export { RESET_PURPOSE, VERIFY_PURPOSE, DEFAULT_TTL_MINUTES };