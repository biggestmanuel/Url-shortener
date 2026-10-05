/**
 * Deployment configuration checks.
 *
 * Every problem found here fails *silently*: the server boots, reports healthy,
 * and hands out links nobody can open. That is far more expensive than a
 * refused start, so the checks live in one place and are used twice — as
 * boot-time warnings, and by `npm --prefix backend run doctor`, which exits
 * non-zero so CI or a deploy script can act on it.
 *
 * Kept free of side effects and of any dependency on server.js so it can be
 * unit tested against arbitrary environments.
 */

/** Loopback origins that cannot work for anyone but this machine. */
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i;

/** Shown for every unset variable, so the list is not just "these are wrong". */
const DESCRIPTIONS = {
  PUBLIC_BASE_URL:
    'the origin every short link is built from (unset falls back to http://localhost:3001)',
  FRONTEND_BASE_URL: 'the origin serving index.html, used to build emailed action links',
  CORS_ORIGINS: 'comma-separated origins allowed to call the API',
  TRUST_PROXY: 'true when running behind a reverse proxy or load balancer',
  API_KEY: 'operator key; also the only way to delete pre-account links',
  SMTP_HOST: 'SMTP server, so reset/verification tokens are emailed instead of logged',
};

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {Array<{variable: string, message: string}>}
 */
export function findConfigProblems(env = process.env) {
  const problems = [];
  const add = (variable, message) => problems.push({ variable, message });

  const publicBase = env.PUBLIC_BASE_URL || '';
  const frontendBase = env.FRONTEND_BASE_URL || '';

  if (!publicBase) {
    add(
      'PUBLIC_BASE_URL',
      'is not set. Every generated short link will point at ' +
        'http://localhost:3001 and be useless to anyone else. Set it to this ' +
        "deployment's public origin, e.g. https://lnk.example.com"
    );
  } else if (LOOPBACK_ORIGIN.test(publicBase)) {
    add(
      'PUBLIC_BASE_URL',
      `is "${publicBase}", which is only reachable from this machine. ` +
        'Generated links will not resolve for real visitors.'
    );
  } else if (!/^https?:\/\//i.test(publicBase)) {
    add(
      'PUBLIC_BASE_URL',
      `is "${publicBase}", which is not an absolute http(s) URL. ` +
        'Short links would be built from nonsense.'
    );
  } else if (publicBase.endsWith('/')) {
    add(
      'PUBLIC_BASE_URL',
      `is "${publicBase}", with a trailing slash. Generated links would come ` +
        'out as "https://host//code".'
    );
  }

  if (!frontendBase) {
    add(
      'FRONTEND_BASE_URL',
      'is not set, so password-reset and verification emails will link to ' +
        'localhost and be unusable. It should be the origin serving index.html, ' +
        'and is separate from PUBLIC_BASE_URL whenever the API has its own hostname.'
    );
  } else if (LOOPBACK_ORIGIN.test(frontendBase)) {
    add(
      'FRONTEND_BASE_URL',
      `is "${frontendBase}". Emailed action links will only open on the ` +
        'machine that received the email.'
    );
  }

  if (!env.CORS_ORIGINS) {
    add(
      'CORS_ORIGINS',
      "is not set, so any website can call this API from a visitor's browser. " +
        'Set it to the comma-separated origins serving your frontend.'
    );
  } else if (env.CORS_ORIGINS.split(',').some((o) => o.trim() === '*')) {
    add(
      'CORS_ORIGINS',
      'contains "*", which allows every origin. List your origins explicitly.'
    );
  }

  if (!env.API_KEY) {
    add(
      'API_KEY',
      'is not set. Guest owner tokens and account sessions still protect ' +
        'deletions, but links created before either existed can only be ' +
        'removed by setting API_KEY.'
    );
  }

  if (!env.SMTP_HOST) {
    add(
      'SMTP_HOST',
      'is not set. Password-reset and verification tokens will be written to ' +
        'the server log instead of emailed.'
    );
  }

  // Only meaningful once we know the deployment is meant to be public.
  const trustProxy = String(env.TRUST_PROXY || '')
    .trim()
    .toLowerCase();
  const trustProxyOn = ['1', 'true', 'yes', 'on'].includes(trustProxy);

  if (!trustProxyOn && /^https:\/\//i.test(publicBase)) {
    add(
      'TRUST_PROXY',
      'is off but PUBLIC_BASE_URL is https. If a proxy or load balancer ' +
        "terminates TLS in front of this app, rate limiting keys on the proxy's " +
        'IP, so one client can exhaust every per-IP limit. Set TRUST_PROXY=true.'
    );
  }

  return problems;
}

/**
 * Problems that should stop a *production* boot rather than warn about it.
 *
 * A warning scrolls past in a log nobody reads. These are the settings where
 * continuing means the deployment is broken in a way that is invisible until
 * someone reports that their short links don't work — so under NODE_ENV=production
 * the server refuses to start instead.
 *
 * Development and self-hosted setups on a private network are unaffected:
 * localhost is a legitimate choice there.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {Array<{variable: string, message: string}>}
 */
export function findFatalConfigProblems(env = process.env) {
  const isProduction = String(env.NODE_ENV || '').toLowerCase() === 'production';
  if (!isProduction) return [];

  // Escape hatch for a production deployment that really is on a private
  // network, where a loopback origin is intentional.
  const allowLoopback = ['1', 'true', 'yes', 'on'].includes(
    String(env.ALLOW_LOOPBACK_BASE_URL || '').trim().toLowerCase()
  );

  const problems = [];
  const publicBase = env.PUBLIC_BASE_URL || '';

  if (allowLoopback) return problems;

  if (!publicBase || LOOPBACK_ORIGIN.test(publicBase)) {
    problems.push({
      variable: 'PUBLIC_BASE_URL',
      message:
        publicBase
          ? `is "${publicBase}", which is only reachable from this machine. ` +
            'Every generated short link would point at localhost.'
          : 'is not set, so every generated short link would point at ' +
            'http://localhost:3001.',
    });
  }

  // A wildcard origin in production is a real exposure, not a style choice.
  if (env.CORS_ORIGINS && env.CORS_ORIGINS.split(',').some((o) => o.trim() === '*')) {
    problems.push({
      variable: 'CORS_ORIGINS',
      message: 'contains "*", which lets any website call this API from a visitor\'s browser.',
    });
  }

  return problems;
}

/** True when this process is meant to be serving real traffic. */
export function isProduction(env = process.env) {
  return String(env.NODE_ENV || '').toLowerCase() === 'production';
}

/**
 * Prints each problem as a single WARNING line.
 *
 * @param {Array<{variable: string, message: string}>} [problems]
 * @param {(line: string) => void} [log]
 */
export function logConfigProblems(problems = findConfigProblems(), log = console.warn) {
  for (const { variable, message } of problems) {
    log(`WARNING: ${variable} ${message}`);
  }
}

/** One-line reminder of what each variable is for, for the "unset" cases. */
export function describeVariables() {
  return DESCRIPTIONS;
}
