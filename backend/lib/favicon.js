/**
 * Server-side favicon resolution with an in-memory cache.
 *
 * The frontend used to call https://www.google.com/s2/favicons, which handed
 * every visitor's destination domain list to a third party. Fetching here
 * keeps that data inside the deployment.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // one day
const MAX_BYTES = 128 * 1024;
const FETCH_TIMEOUT_MS = 4000;
// The cache key is a caller-supplied domain, so its size must be bounded.
const MAX_CACHE_ENTRIES = 2048;
const MAX_REDIRECTS = 3;

/**
 * A bare, resolvable public hostname: at least one dot, only hostname
 * characters. This is the first gate, applied before anything is constructed,
 * so a crafted value can never reach URL parsing or DNS.
 */
const DOMAIN_PATTERN =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * True when the label is an IPv4 address in any of the non-public ranges:
 * loopback, RFC1918 private, link-local (including the 169.254.169.254 cloud
 * metadata endpoint), CGNAT, and the reserved blocks.
 */
function isPrivateIpv4(host) {
  const octets = host.split('.').map(parseIpv4Octet);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    // Not a well-formed IPv4 address. Anything numeric that does not parse is
    // rejected outright rather than guessed at — failing closed.
    return true;
  }

  const [a, b] = octets;

  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast

  return false;
}

export function isValidDomain(domain) {
  if (typeof domain !== 'string') return false;
  if (domain.length === 0 || domain.length > 253) return false;
  if (!DOMAIN_PATTERN.test(domain)) return false;

  // Numeric-shaped hostnames. `127.1`, `0177.0.0.1` and `0x7f.1` are all valid
  // IPv4 in notations browsers and curl accept, so they must be expanded and
  // checked rather than waved through as ordinary domains.
  //
  // Note each octet may be written in decimal or octal/hex, so the digits
  // are normalised per part before the range check runs.
  if (/^[0-9a-fx.]+$/i.test(domain) && /[0-9]/.test(domain)) {
    return !isPrivateIpv4(expandIpv4Shorthand(domain));
  }

  // Hexadecimal shorthand, e.g. 0x7f000001 for 127.0.0.1.
  if (/^0x[0-9a-f.]+$/i.test(domain)) {
    return !isPrivateIpv4(expandIpv4Hex(domain));
  }

  // A single-label host resolves only via a local search domain, which is
  // exactly the internal-network case we must refuse.
  if (!domain.includes('.')) return false;

  return true;
}

/**
 * Parses a single IPv4 octet, honouring the notations resolvers accept:
 * decimal (`127`), octal (`0177`) and hex (`0x7f`). A leading zero means
 * octal, so `0177` is 127 — a loopback address in disguise.
 *
 * Returns NaN for anything unparseable, which callers treat as invalid.
 */
function parseIpv4Octet(part) {
  if (typeof part !== 'string' || part.length === 0 || part.length > 3) return NaN;

  let value;
  if (/^0x[0-9a-f]+$/i.test(part)) {
    value = Number.parseInt(part.slice(2), 16);
  } else if (/^0[0-7]+$/.test(part)) {
    value = Number.parseInt(part.slice(1), 8);
  } else if (/^[0-9]{1,3}$/.test(part)) {
    value = Number.parseInt(part, 10);
  } else {
    return NaN;
  }

  return Number.isInteger(value) ? value : NaN;
}

/**
 * Expands the dotted shorthand forms of IPv4 (`127.1` -> `127.0.0.1`).
 *
 * Each part after the first is a count of trailing zero octets, so
 * `127.1` is 127.0.0.1 and `192.168.257` is 192.168.1.1.
 */
function expandIpv4Shorthand(host) {
  const parts = host.split('.');

  // A full four-octet address is already literal. Running it through the
  // shorthand maths would rewrite 255.255.255.255 into 0.0.255.255.
  if (parts.length === 4) return host;

  if (parts.length > 4) return host;

  // Trailing part supplies the low-order octets; anything left over is zero.
  const last = parseIpv4Octet(parts[parts.length - 1]);
  if (!Number.isInteger(last) || last < 0 || last > 255) return host;

  const leading = parts.slice(0, -1).map(parseIpv4Octet);
  if (leading.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return host;

  // The final value counts trailing zeros, so shift it into place.
  const shift = Math.pow(256, 4 - parts.length);
  const value = leading.reduce((acc, n) => acc * 256 + n, 0) * shift + last;

  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return host;

  return [24, 16, 8, 0].map((bitShift) => (value >>> bitShift) & 0xff).join('.');
}

/** Expands hex notation: 0x7f.0.0.1 and 0x7f000001 both mean 127.0.0.1. */
function expandIpv4Hex(host) {
  const plain = host.replace(/^0x/i, '');

  if (!plain.includes('.')) {
    const value = Number.parseInt(plain, 16);
    if (!Number.isInteger(value) || value > 0xffffffff) return host;
    return [24, 16, 8, 0].map((s) => (value >>> s) & 0xff).join('.');
  }

  const octets = plain.split('.').map((p) => Number.parseInt(p, 16));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n > 255)) return host;

  return octets.join('.');
}

const cache = new Map();

/** Only http(s) is fetchable; anything else is rejected before DNS. */
function assertFetchable(target) {
  const url = new URL(target);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('unsupported protocol');
  }

  // Credentials in the URL are a way to smuggle a host past naive checks.
  if (url.username || url.password) {
    throw new Error('credentials in URL are not allowed');
  }

  return url;
}

/**
 * Fetches a favicon for a bare hostname.
 *
 * @param {string} domain
 * @param {{ fetchImpl?: typeof fetch, ttlMs?: number }} [options]
 * @returns {Promise<{buffer: Buffer, contentType: string}|null>}
 */
export async function resolveFavicon(domain, options = {}) {
  // Reject before constructing any URL or opening a socket.
  if (!isValidDomain(domain)) return null;

  const key = domain.toLowerCase();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = Date.now();

  const cached = cache.get(key);
  if (cached && now - cached.at < ttlMs) {
    return cached.value;
  }

  const value = await fetchFavicon(key, fetchImpl);

  // Cache misses too, so a dead host is not re-probed on every page render.
  //
  // LRU eviction: the cache is keyed by attacker-supplied domains, so without
  // a bound it grows until the process exhausts memory.
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }

  cache.set(key, { at: now, value });

  return value;
}

/**
 * Follows a redirect chain manually, re-checking every hop.
 *
 * Each hop must still be http(s), carry no credentials, and resolve to a
 * public host — otherwise a public site could redirect us at an internal
 * address after the initial validation had already passed.
 *
 * @returns {Promise<{res: object, url: URL}|null>}
 */
async function followRedirects(res, initialTarget, fetchImpl, signal) {
  const requestedHost = new URL(initialTarget).hostname.toLowerCase();

  let current = res;
  let url = new URL(res.url || initialTarget);

  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    if (current.status >= 300 && current.status < 400) {
      const location = current.headers.get('location');
      if (!location) return null;

      let next;
      try {
        // A relative Location is resolved against the current URL.
        next = assertFetchable(new URL(location, url).toString());
      } catch {
        return null;
      }

      // The hop target must itself be a public hostname.
      if (!isValidDomain(next.hostname.toLowerCase())) return null;

      const redirected = await fetchImpl(next.toString(), {
        signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'Linkly/1.0 (+favicon-proxy)',
          Accept: 'image/*,*/*;q=0.8',
        },
      });

      current = redirected;
      url = next;
      continue;
    }

    if (!current.ok) return null;

    // The host we actually landed on must be the one we asked about; a
    // cross-host chain means we would be serving someone else's icon.
    if (url.hostname.toLowerCase() !== requestedHost) return null;

    return { res: current, url };
  }

  return null;
}

async function fetchFavicon(domain, fetchImpl) {
  const candidates = [
    `https://${domain}/favicon.ico`,
    `https://${domain}/apple-touch-icon.png`,
  ];

  for (const target of candidates) {
    try {
      assertFetchable(target);
    } catch {
      return null;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      // Redirects are followed manually so each hop can be re-checked against
      // the private-address rules. `redirect: 'follow'` would let a public host
      // bounce the request to 169.254.169.254 with nothing left to inspect.
      const res = await fetchImpl(target, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          // Many CDNs reject requests without a browser-ish UA.
          'User-Agent': 'Linkly/1.0 (+favicon-proxy)',
          Accept: 'image/*,*/*;q=0.8',
        },
      });

      clearTimeout(timer);

      // Walk any redirect chain by hand, re-validating every hop. Following
      // automatically would let a public host bounce us to an internal address
      // before the guard below ever runs.
      const followed = await followRedirects(res, target, fetchImpl, controller.signal);
      if (!followed) continue;

      const finalUrl = followed.url;
      if (finalUrl.hostname.toLowerCase() !== domain) continue;

      const contentType = (followed.res.headers.get('content-type') || '').toLowerCase();
      if (!contentType.startsWith('image/')) continue;

      const buffer = Buffer.from(await followed.res.arrayBuffer());
      if (buffer.length === 0 || buffer.length > MAX_BYTES) continue;

      return { buffer, contentType };
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

export function clearFaviconCache() {
  cache.clear();
}

/** Test seam: how many entries are cached. */
export function faviconCacheSize() {
  return cache.size;
}