/**
 * Linkly — Express REST API, session auth & redirect handler.
 *
 * Exported as a factory so tests can inject a stub pool. A port is only bound
 * when this module is executed directly.
 */

import { pathToFileURL } from 'node:url';

import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { ipKeyGenerator } from 'express-rate-limit';
import 'dotenv/config';

import { getPool, closePool } from './lib/db.js';
import { generateShortCode, isValidCode, ALIAS_PATTERN } from './lib/codes.js';
import { resolveFavicon, isValidDomain } from './lib/favicon.js';
import { pruneExpiredSessions } from './lib/sessions.js';
import { logConfigProblems, findFatalConfigProblems } from './lib/config.js';
import { sendMail } from './lib/mailer.js';
import {
  issuePasswordReset,
  consumePasswordReset,
  issueEmailVerification,
  consumeEmailVerification,
} from './lib/tokens.js';
import {
  generateOwnerToken,
  generateSessionToken,
  hashToken,
  hashPassword,
  verifyPassword,
  validatePassword,
  validateEmail,
  normalizeEmail,
  resolveSession,
  canDeleteLink,
  hasValidApiKey,
} from './lib/auth.js';

const MAX_URL_LENGTH = 2048;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const GENERATED_CODE_ATTEMPTS = 6;
const SESSION_TTL_DAYS = 30;
// Ceiling of the `clicks integer` column (2^31 - 1). The redirect saturates
// here instead of overflowing.
const MAX_CLICKS = 2147483647;

const UNIQUE_VIOLATION = '23505';
const INVALID_TEXT_REPRESENTATION = '22P02';

/**
 * Link ids are bigserial. Postgres rejects a non-numeric value with 22P02,
 * which would otherwise surface as a 500 and log a stack trace for what is
 * simply a bad request.
 */
function isValidLinkId(value) {
  return typeof value === 'string' && /^\d{1,19}$/.test(value);
}

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function numEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Reads an integer env var that is allowed to be 0.
 *
 * `numEnv` treats 0 as "unset" and falls back, which is right for a limit but
 * wrong for a setting whose documented "0 disables" case must actually
 * disable. Uses Math.trunc so "60.9" and "-0" are not silently rejected.
 */
function nonNegativeEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.trunc(parsed);
}

/**
 * Reads a boolean env var.
 *
 * `Boolean('false')` is true, so the obvious implementation silently
 * *enables* TRUST_PROXY for anyone who copies the .env.example default of
 * "false" — which would let a client spoof X-Forwarded-For and bypass every
 * per-IP rate limit. Only the documented spellings count as true.
 */
function boolEnv(name, fallback = false) {
  const raw = process.env[name];

  if (raw === undefined || raw === null || raw === '') return fallback;

  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;

  console.warn(`${name}="${raw}" is not a recognised boolean; treating it as ${fallback}.`);
  return fallback;
}

export function createApp(options = {}) {
  const {
    pool = null,
    publicBaseUrl = (process.env.PUBLIC_BASE_URL || 'http://localhost:3001').replace(/\/+$/, ''),
    // Where the emailed links point. The frontend is a static page, so these
    // use a hash route (#reset-password?token=...) rather than a path the
    // server would have to route: /reset-password would otherwise be matched
    // by the /:code catch-all and 404 as an unknown short code.
    frontendBaseUrl = (
      process.env.FRONTEND_BASE_URL || process.env.PUBLIC_BASE_URL || 'http://localhost:3001'
    ).replace(/\/+$/, ''),
    apiKey = process.env.API_KEY || '',
    requireApiKeyToCreate = process.env.REQUIRE_API_KEY_TO_CREATE === 'true',
    trustProxy = boolEnv('TRUST_PROXY', false),
    createRateMax = numEnv('CREATE_RATE_MAX', 30),
    createRateWindowMs = numEnv('CREATE_RATE_WINDOW_MS', 10 * 60 * 1000),
    redirectRateMax = numEnv('REDIRECT_RATE_MAX', 1200),
    redirectRateWindowMs = numEnv('REDIRECT_RATE_WINDOW_MS', 60 * 1000),
    authRateMax = numEnv('AUTH_RATE_MAX', 20),
    authRateWindowMs = numEnv('AUTH_RATE_WINDOW_MS', 15 * 60 * 1000),
    sessionTtlDays = numEnv('SESSION_TTL_DAYS', SESSION_TTL_DAYS),
    // Expired sessions are inert but still occupy rows, so sweep them.
    // Use nonNegativeEnv here: numEnv treats 0 as "unset", so a documented
    // SESSION_SWEEP_MINUTES=0 would silently fall back to 60 instead of
    // disabling the sweep.
    sessionSweepMinutes = nonNegativeEnv('SESSION_SWEEP_MINUTES', 60),
    resetTtlMinutes = numEnv('RESET_TOKEN_TTL_MINUTES', 60),
    verificationTtlMinutes = numEnv('VERIFY_TOKEN_TTL_MINUTES', 24 * 60),
    corsOrigins = process.env.CORS_ORIGINS || '',
    fetchImpl = undefined,
    faviconCacheTtlMs = undefined,
    // Injected in tests so the emailed link can be inspected without SMTP.
    sendMailImpl = undefined,
  } = options;

  let db = pool;

  async function query(text, params) {
    if (!db) db = getPool();
    return db.query(text, params);
  }

  const app = express();

  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);

  // Baseline security headers, written out rather than pulled from helmet:
  // this is a JSON API and a redirect handler, so the full helmet default set
  // would be mostly no-ops. These are the ones that actually mean something
  // here — every response is JSON or a redirect, never HTML.
  app.use((_req, res, next) => {
    // The API only ever emits JSON; without this a browser could be talked
    // into executing a response as HTML or script.
    res.set('X-Content-Type-Options', 'nosniff');
    // Nothing here should ever be framed.
    res.set('X-Frame-Options', 'DENY');
    // Do not leak the API origin (and any token in a query string) to whatever
    // a redirect sends the visitor to.
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    // Only meaningful over TLS, which a public deployment terminates upstream.
    res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');

    next();
  });

  // The API authenticates with bearer tokens, never cookies, so a reflected
  // origin cannot be leveraged for CSRF. Narrow this when deploying.
  const allowedOrigins = corsOrigins
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.use(cors(allowedOrigins.length > 0 ? { origin: allowedOrigins } : {}));
  app.use(express.json({ limit: '32kb' }));

  const createLimiter = rateLimit({
    windowMs: createRateWindowMs,
    limit: createRateMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many links created, please slow down' },
  });

  const redirectLimiter = rateLimit({
    windowMs: redirectRateWindowMs,
    limit: redirectRateMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });

  // Credential endpoints get a much tighter budget to blunt password guessing.
  const authLimiter = rateLimit({
    windowMs: authRateWindowMs,
    limit: authRateMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Too many attempts, please try again later' },
  });

  // Resolves the caller once per request and stashes it on `req.user`.
  app.use(async (req, _res, next) => {
    try {
      req.user = await resolveSession(query, req);
      next();
    } catch (err) {
      next(err);
    }
  });

  function toLinkResponse(row, { includeOwnerToken = false } = {}) {
    const payload = {
      id: row.id,
      code: row.code,
      shortUrl: `${publicBaseUrl}/${row.code}`,
      destinationUrl: row.destination_url,
      clicks: row.clicks,
      createdAt: row.created_at,
      owned: Boolean(row.user_id) || Boolean(row.owner_token),
    };

    // The guest secret is handed out exactly once, on creation. Listing links
    // must never leak it.
    if (includeOwnerToken && row.owner_token) {
      payload.ownerToken = row.owner_token;
    }

    return payload;
  }

  function toUserResponse(user) {
    return {
      id: String(user.id),
      email: user.email,
      // Absent rather than false when the column was not selected.
      ...(user.email_verified_at === undefined
        ? {}
        : { emailVerified: Boolean(user.email_verified_at) }),
    };
  }

  async function issueSession(userId) {
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + sessionTtlDays * 24 * 60 * 60 * 1000);

    await query(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, hashToken(token), expiresAt.toISOString()]
    );

    return { token, expiresAt };
  }

  /**
   * Builds an emailed action link against the *frontend*, as a hash route.
   *
   * A path link (/reset-password?token=...) would be matched by the /:code
   * catch-all and answered with 404 "Short link not found", because the API
   * serves no HTML. The hash keeps the token off the server entirely: it never
   * reaches a request line, access log, or Referer header.
   */
  function frontendActionLink(route, token) {
    return `${frontendBaseUrl}/#/${route}?token=${encodeURIComponent(token)}`;
  }

  const resetLinkFor = (token) => frontendActionLink('reset-password', token);
  const verifyLinkFor = (token) => frontendActionLink('verify-email', token);

  const mail = sendMailImpl ?? sendMail;

  /**
   * Inserts a link. Custom aliases fail fast on collision (409); generated
   * codes retry, relying on the unique index rather than a racy SELECT.
   */
  async function insertLink(destinationUrl, customAlias, userId) {
    const attempts = customAlias ? 1 : GENERATED_CODE_ATTEMPTS;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const code = customAlias ?? generateShortCode();
      // Signed-in creators get account ownership. Guests get a one-time
      // secret instead, so they can still delete their own link.
      const ownerToken = userId ? null : generateOwnerToken();

      try {
        const result = await query(
          `INSERT INTO links (code, destination_url, user_id, owner_token)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [code, destinationUrl, userId, ownerToken]
        );

        // RETURNING always yields a row, but reading .id off undefined throws
        // a TypeError that surfaces as an opaque 500. Fail as a retryable
        // allocation problem instead, which is what it would be.
        if (!result.rows[0]) return { exhausted: !customAlias, aliasTaken: Boolean(customAlias) };

        return { row: result.rows[0] };
      } catch (err) {
        if (err.code === UNIQUE_VIOLATION && !customAlias) continue;
        if (err.code === UNIQUE_VIOLATION) return { aliasTaken: true };
        throw err;
      }
    }

    return { exhausted: true };
  }

  /**
   * Liveness plus a real readiness signal.
   *
   * `db` reports whether the database answered, and 503 when it did not, so a
   * load balancer pulls this instance out of rotation instead of sending it
   * traffic that is guaranteed to fail. The frontend's startup health check
   * only inspects `ok`, so it still treats a database outage as "live" and
   * shows a real error rather than silently switching to local demo mode.
   */
  app.get('/', async (_req, res) => {
    let db;

    try {
      await query('SELECT 1');
      db = { ok: true, error: null };
    } catch (err) {
      // The code is useful to an operator; the message can carry host details
      // or credentials, so it is never returned.
      db = { ok: false, error: err.code || err.message };
    }

    res.status(db.ok ? 200 : 503).json({
      name: 'Linkly API',
      status: db.ok ? 'ok' : 'degraded',
      db,
      endpoints: {
        register: 'POST /api/auth/register',
        login: 'POST /api/auth/login',
        logout: 'POST /api/auth/logout',
        me: 'GET /api/auth/me',
        forgotPassword: 'POST /api/auth/forgot-password',
        resetPassword: 'POST /api/auth/reset-password',
        verifyEmail: 'POST /api/auth/verify-email',
        links: '/api/links',
        favicon: 'GET /api/favicon?domain=',
        redirect: '/:code',
      },
    });
  });

  // ---------------------------------------------------------------------
  // Reserved paths, registered before the /:code catch-all so that crawlers
  // and browsers never reach the database.
  // ---------------------------------------------------------------------

  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /\n');
  });

  app.get('/favicon.ico', (_req, res) => res.status(204).end());

  // GET /api/favicon?domain=example.com
  //
  // Resolved server-side so the frontend never contacts a third-party icon
  // service. Rate limited because each miss is an outbound request.
  app.get(
    '/api/favicon',
    rateLimit({
      windowMs: 60 * 1000,
      limit: numEnv('FAVICON_RATE_MAX', 120),
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      // ipKeyGenerator normalises IPv6 to a /64 subnet; without it a single
      // client could rotate through its address space to evade the limit.
      keyGenerator: (req) =>
        `${ipKeyGenerator(req.ip)}:${String(req.query.domain ?? '').toLowerCase()}`,
    }),
    async (req, res) => {
      const domain = String(req.query.domain ?? '').trim().toLowerCase();

      // Hostnames only: no scheme, path, port, or credentials.
      if (!isValidDomain(domain)) {
        return res.status(400).json({ error: 'Invalid domain' });
      }

      const icon = await resolveFavicon(domain, {
        fetchImpl,
        ttlMs: faviconCacheTtlMs,
      });

      if (!icon) {
        return res.status(404).type('text/plain').end();
      }

      res.set('Cache-Control', 'public, max-age=86400');
      res.type(icon.contentType).send(icon.buffer);
    }
  );

  // ---------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------

  app.post('/api/auth/register', authLimiter, async (req, res) => {
    const { email, password } = req.body ?? {};

    const emailError = validateEmail(email);
    if (emailError) return res.status(400).json({ error: emailError });

    const passwordError = validatePassword(password);
    if (passwordError) return res.status(400).json({ error: passwordError });

    const normalized = normalizeEmail(email);

    try {
      const inserted = await query(
        `INSERT INTO users (email, password_hash)
         VALUES ($1, $2)
         RETURNING id, email, email_verified_at`,
        [normalized, hashPassword(password)]
      );

      const user = inserted.rows[0];
      const session = await issueSession(user.id);

      // Mail the confirmation link. Failures here must not fail registration:
      // the address can always be re-sent from the signed-in UI.
      await issueEmailVerification(query, user.id, user.email, {
        ttlMinutes: verificationTtlMinutes,
        buildLink: verifyLinkFor,
        sendMailImpl: mail,
      }).catch((err) => console.error('Verification mail failed:', err.message));

      res.status(201).json({
        user: toUserResponse(user),
        token: session.token,
        expiresAt: session.expiresAt.toISOString(),
      });
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) {
        return res.status(409).json({ error: 'That email is already registered' });
      }
      console.error('Register error:', err);
      res.status(500).json({ error: 'Failed to create account' });
    }
  });

  app.post('/api/auth/login', authLimiter, async (req, res) => {
    const { email, password } = req.body ?? {};
    const normalized = normalizeEmail(email);

    // Always run a password verification so the response time does not
    // reveal whether the address exists.
    const lookup = await query('SELECT * FROM users WHERE email = $1', [normalized]);
    const user = lookup.rows[0];

    const passwordOk = user
      ? verifyPassword(password ?? '', user.password_hash)
      : verifyPassword(password ?? '', 'scrypt$16384$8$1$AAAA$AAAA');

    if (!user || !passwordOk) {
      return res.status(401).json({ error: 'Incorrect email or password' });
    }

    try {
      const session = await issueSession(user.id);
      res.json({
        user: toUserResponse(user),
        token: session.token,
        expiresAt: session.expiresAt.toISOString(),
      });
    } catch (err) {
      console.error('Login error:', err);
      res.status(500).json({ error: 'Failed to sign in' });
    }
  });

  app.post('/api/auth/logout', async (req, res) => {
    if (!req.user) return res.json({ success: true });

    try {
      await query('DELETE FROM sessions WHERE id = $1', [req.user.session_id]);
      res.json({ success: true });
    } catch (err) {
      console.error('Logout error:', err);
      res.status(500).json({ error: 'Failed to sign out' });
    }
  });

  app.get('/api/auth/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    res.json({ user: toUserResponse(req.user) });
  });

  // ---------------------------------------------------------------------
  // Password reset & email verification
  // ---------------------------------------------------------------------

  // Always answers the same way, whether or not the address exists.
  app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const emailError = validateEmail(email);
    if (emailError) return res.status(400).json({ error: emailError });

    try {
      const reset = await issuePasswordReset(query, email);

      if (reset.token) {
        const link = resetLinkFor(reset.token);
        await mail({
          to: reset.user.email,
          subject: 'Reset your Linkly password',
          text: [
            'A password reset was requested for your Linkly account.',
            '',
            link,
            '',
            `This link expires in ${resetTtlMinutes} minutes and can be used once.`,
            'If you did not request this, you can ignore this email — your password has not changed.',
          ].join('\n'),
        });
      }

      res.json({
        success: true,
        message: 'If that address has an account, a reset link is on its way.',
      });
    } catch (err) {
      console.error('Forgot password error:', err);
      res.status(500).json({ error: 'Could not process the request' });
    }
  });

  app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
    const { token, password } = req.body ?? {};

    if (typeof token !== 'string' || token.length === 0) {
      return res.status(400).json({ error: 'A reset token is required' });
    }

    const passwordError = validatePassword(password);
    if (passwordError) return res.status(400).json({ error: passwordError });

    try {
      const result = await consumePasswordReset(query, token, password, {
        hashPassword,
      });

      if (!result.ok) {
        return res.status(400).json({ error: result.error });
      }

      // Revoke the cookie/session context too if the caller had one.
      if (req.user) {
        await query('DELETE FROM sessions WHERE id = $1', [req.user.session_id]);
      }

      res.json({ success: true, message: 'Your password has been updated. Please sign in.' });
    } catch (err) {
      console.error('Reset password error:', err);
      res.status(500).json({ error: 'Could not reset the password' });
    }
  });

  // Re-sends the verification mail. Requires a session, so an attacker cannot
  // use this to mail-bomb an arbitrary address.
  app.post('/api/auth/resend-verification', authLimiter, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });

    const already = await query(
      'SELECT email_verified_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (already.rows[0]?.email_verified_at) {
      return res.json({ success: true, message: 'This address is already verified.' });
    }

    try {
      await issueEmailVerification(query, req.user.id, req.user.email, {
        ttlMinutes: verificationTtlMinutes,
        buildLink: verifyLinkFor,
        sendMailImpl: mail,
      });
      res.json({ success: true, message: 'Verification email sent.' });
    } catch (err) {
      console.error('Resend verification error:', err);
      res.status(500).json({ error: 'Could not send the verification email' });
    }
  });

  app.post('/api/auth/verify-email', async (req, res) => {
    const token = req.body?.token;

    if (typeof token !== 'string' || token.length === 0) {
      return res.status(400).json({ error: 'A verification token is required' });
    }

    try {
      const result = await consumeEmailVerification(query, token);
      if (!result.ok) {
        return res.status(400).json({ error: result.error });
      }
      res.json({ success: true, message: 'Email verified.' });
    } catch (err) {
      console.error('Verify email error:', err);
      res.status(500).json({ error: 'Could not verify the address' });
    }
  });

  // ---------------------------------------------------------------------
  // Links
  // ---------------------------------------------------------------------

  // POST /api/links -> create a short link
  app.post('/api/links', createLimiter, async (req, res) => {
    if (requireApiKeyToCreate && !hasValidApiKey(req, apiKey)) {
      return res.status(401).json({ error: 'A valid API key is required' });
    }

    const { destinationUrl, customAlias } = req.body ?? {};

    if (
      typeof destinationUrl !== 'string' ||
      destinationUrl.length === 0 ||
      destinationUrl.length > MAX_URL_LENGTH ||
      !isValidUrl(destinationUrl)
    ) {
      return res.status(400).json({
        error: `A valid http(s) URL is required (max ${MAX_URL_LENGTH} characters)`,
      });
    }

    let alias = null;
    if (customAlias !== undefined && customAlias !== null && customAlias !== '') {
      if (typeof customAlias !== 'string') {
        return res.status(400).json({ error: 'Custom alias must be a string' });
      }
      alias = customAlias.trim();
      if (!ALIAS_PATTERN.test(alias)) {
        return res.status(400).json({
          error: 'Custom alias must be 3-30 alphanumeric characters, hyphens, or underscores',
        });
      }
    }

    try {
      const result = await insertLink(destinationUrl, alias, req.user?.id ?? null);

      if (result.aliasTaken) {
        return res.status(409).json({ error: 'Custom alias is already in use' });
      }
      if (result.exhausted) {
        return res.status(503).json({ error: 'Could not allocate a unique short code' });
      }

      res.status(201).json(toLinkResponse(result.row, { includeOwnerToken: true }));
    } catch (err) {
      console.error('Create link error:', err);
      res.status(500).json({ error: 'Failed to create short link' });
    }
  });

  // GET /api/links -> the caller's own links, newest first.
  app.get('/api/links', async (req, res) => {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

    // An operator key may inspect the whole table; everyone else sees only
    // their own links, so ids cannot be walked to enumerate other people's.
    const isOperator = hasValidApiKey(req, apiKey);

    if (!req.user && !isOperator) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    try {
      const result = isOperator
        ? await query(
            `SELECT * FROM links
             WHERE code IS NOT NULL
             ORDER BY created_at DESC
             LIMIT $1`,
            [limit]
          )
        : await query(
            `SELECT * FROM links
             WHERE code IS NOT NULL
               AND user_id = $1
             ORDER BY created_at DESC
             LIMIT $2`,
            [req.user.id, limit]
          );

      res.json(result.rows.map((row) => toLinkResponse(row)));
    } catch (err) {
      console.error('List links error:', err);
      res.status(500).json({ error: 'Failed to fetch links' });
    }
  });

  // DELETE /api/links/:id
  app.delete('/api/links/:id', async (req, res) => {
    // Reject junk before querying: id is a bigint, so anything else is a
    // client error rather than a server fault.
    if (!isValidLinkId(req.params.id)) {
      return res.status(404).json({ error: 'Link not found' });
    }

    try {
      // Read first so an unauthorised caller learns nothing about whether
      // the id exists.
      const existing = await query('SELECT * FROM links WHERE id = $1', [req.params.id]);
      const row = existing.rows[0];

      if (!row) {
        return res.status(404).json({ error: 'Link not found' });
      }

      if (!canDeleteLink(req, row, req.user, apiKey)) {
        return res.status(403).json({
          error: 'You do not have permission to delete this link',
        });
      }

      await query('DELETE FROM links WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      console.error('Delete link error:', err);
      res.status(500).json({ error: 'Failed to delete link' });
    }
  });

  /**
   * Names the frontend owns. Emailed links are hash routes, so these should
   * never reach the API — but if a deployment is ever configured with
   * path-based links, or someone hand-types one, answer with a helpful
   * redirect instead of a bare 404 that looks like a dead short link.
   */
  const FRONTEND_ROUTES = new Map([
    ['reset-password', '/#/reset-password'],
    ['verify-email', '/#/verify-email'],
  ]);

  // GET /:code -> the short-link redirect. Registered last, deliberately.
  app.get('/:code', redirectLimiter, async (req, res, next) => {
    const { code } = req.params;

    const frontendRoute = FRONTEND_ROUTES.get(code);
    if (frontendRoute) {
      // Preserve the token, if one was supplied.
      const suffix = req.query.token ? `?token=${encodeURIComponent(req.query.token)}` : '';
      return res.redirect(302, `${frontendBaseUrl}${frontendRoute}${suffix}`);
    }

    // Anything that cannot be a generated code is not ours to look up.
    if (!isValidCode(code)) return next();

    try {
      // Single round trip: bump the counter and read the destination back.
      //
      // `clicks` is a 32-bit integer, so a popular link would eventually push
      // the increment past the column's ceiling — and Postgres raises 22003 on
      // overflow, which turned *every subsequent click* into a 500. Saturation
      // costs nothing, never errors, and keeps the column a plain integer so
      // the API response type does not change. A link this popular has bigger
      // problems than an off-by-a-lot counter.
      const result = await query(
        `UPDATE links
         SET clicks = CASE WHEN clicks >= $2 THEN $2 ELSE clicks + 1 END
         WHERE code = $1
         RETURNING destination_url`,
        [code, MAX_CLICKS]
      );

      const row = result.rows[0];
      if (!row) {
        return res.status(404).type('text/plain').send('Short link not found');
      }

      // Destinations are user-supplied, so never let a client or proxy
      // cache a redirect that follows someone else's click.
      res.set('Cache-Control', 'no-store');
      res.redirect(302, row.destination_url);
    } catch (err) {
      console.error('Redirect error:', err);
      res.status(500).type('text/plain').send('Something went wrong');
    }
  });

  // Expired sessions can never be used again, so removing them is invisible
  // to clients. Failures are logged and retried on the next tick rather than
  // crashing a long-running server.
  if (sessionSweepMinutes > 0) {
    const sweep = async () => {
      try {
        const removed = await pruneExpiredSessions(query);
        if (removed > 0) console.log(`Pruned ${removed} expired session(s).`);
      } catch (err) {
        console.error('Session sweep failed:', err.message);
      }
    };

    const timer = setInterval(sweep, sessionSweepMinutes * 60 * 1000);
    // Do not hold the process open just for the sweep.
    timer.unref?.();
  }

  // Anything the catch-all did not claim (nested paths, bad codes).
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err, _req, res, _next) => {
    // body-parser rejects malformed JSON and oversized payloads as client
    // errors; they must not be reported as server failures.
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body must be valid JSON' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body is too large' });
    }

    // A malformed value reaching a typed column is a client error, not a
    // server fault. Catch it generically so no route can leak a 500.
    if (err.code === INVALID_TEXT_REPRESENTATION) {
      return res.status(400).json({ error: 'Malformed identifier' });
    }

    const status = Number(err.status || err.statusCode);
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      return res.status(status).json({ error: 'Bad request' });
    }

    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

// --- entry point -------------------------------------------------------

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  // Refuse to serve production traffic with settings that would make every
  // generated link point at localhost. A warning scrolls past; failing here
  // cannot be missed.
  const fatal = findFatalConfigProblems();
  if (fatal.length > 0) {
    console.error('Refusing to start: NODE_ENV=production and the deployment is not usable.\n');
    for (const { variable, message } of fatal) {
      console.error(`  ${variable} ${message}`);
    }
    console.error(
      '\nSet a real PUBLIC_BASE_URL (and CORS_ORIGINS), or unset NODE_ENV to run ' +
        'in development mode.\nIf this really is a production deployment on a private ' +
        'network, set ALLOW_LOOPBACK_BASE_URL=true to override.'
    );
    process.exit(1);
  }

  const app = createApp();
  const port = Number(process.env.PORT) || 3001;
  const server = app.listen(port, () => {
    console.log(`Linkly backend running on port ${port}`);
    // Settings that are fine locally but wrong in production, each of which
    // otherwise fails silently. See lib/config.js.
    logConfigProblems();
  });

  /**
   * Close cleanly on SIGTERM/SIGINT.
   *
   * Without this, a rolling deploy kills the process mid-request and the pg
   * pool's sockets are torn down abruptly, which surfaces on Neon as dropped
   * connections. Draining first lets in-flight requests finish.
   */
  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, closing server...`);

    const force = setTimeout(() => {
      console.error('Graceful shutdown timed out, exiting.');
      process.exit(1);
    }, 10_000);
    force.unref();

    server.close(async () => {
      try {
        // The pool is lazy: close it only if this process actually created
        // one. Calling getPool() here would construct a pool solely to close
        // it, and throw on a server that never touched the database.
        await closePool();
      } catch (err) {
        console.error('Error closing the database pool:', err.message);
      }
      clearTimeout(force);
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}