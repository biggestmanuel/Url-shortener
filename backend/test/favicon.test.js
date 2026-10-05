import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveFavicon, clearFaviconCache, faviconCacheSize, isValidDomain } from '../lib/favicon.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fakeFetch(handlers) {
  return async (url) => {
    for (const [pattern, response] of handlers) {
      if (pattern.test(url)) {
        if (typeof response === 'function') return response(url);
        return response;
      }
    }
    return { ok: false, status: 404, url, headers: new Map() };
  };
}

const okResponse = (body = PNG, type = 'image/png', url = 'https://example.com/favicon.ico') => ({
  ok: true,
  status: 200,
  url,
  headers: { get: (name) => (name.toLowerCase() === 'content-type' ? type : null) },
  arrayBuffer: async () => body,
});

// --- happy path ----------------------------------------------------------

test('resolves a favicon and reports its content type', async () => {
  clearFaviconCache();
  const icon = await resolveFavicon('example.com', {
    fetchImpl: fakeFetch([[/favicon\.ico$/, okResponse()]]),
  });

  assert.ok(icon);
  assert.equal(icon.contentType, 'image/png');
  assert.ok(icon.buffer.equals(PNG));
});

// --- caching -------------------------------------------------------------

test('caches a hit and does not refetch', async () => {
  clearFaviconCache();
  let calls = 0;
  const fetchImpl = fakeFetch([
    [/favicon\.ico$/, () => {
      calls++;
      return okResponse();
    }],
  ]);

  await resolveFavicon('cache-me.com', { fetchImpl });
  await resolveFavicon('cache-me.com', { fetchImpl });

  assert.equal(calls, 1, 'second lookup must be served from cache');
});

test('cache is keyed per domain', async () => {
  clearFaviconCache();
  let calls = 0;
  const fetchImpl = fakeFetch([
    [/favicon\.ico$/, () => {
      calls++;
      return okResponse();
    }],
  ]);

  await resolveFavicon('a.com', { fetchImpl });
  await resolveFavicon('b.com', { fetchImpl });

  assert.equal(calls, 2);
});

test('honours a zero TTL', async () => {
  clearFaviconCache();
  let calls = 0;
  const fetchImpl = fakeFetch([
    [/favicon\.ico$/, () => {
      calls++;
      return okResponse();
    }],
  ]);

  await resolveFavicon('ttl.com', { fetchImpl, ttlMs: 0 });
  await resolveFavicon('ttl.com', { fetchImpl, ttlMs: 0 });

  assert.equal(calls, 2);
});

test('clearFaviconCache empties it', async () => {
  clearFaviconCache();
  await resolveFavicon('x.com', { fetchImpl: fakeFetch([[/.*/, okResponse()]]) });
  assert.equal(faviconCacheSize(), 1);

  clearFaviconCache();
  assert.equal(faviconCacheSize(), 0);
});

// --- misses --------------------------------------------------------------

test('returns null when nothing is found', async () => {
  clearFaviconCache();
  const icon = await resolveFavicon('nothing-here.test', {
    fetchImpl: fakeFetch([[/.*/, { ok: false, status: 404, url: 'x', headers: { get: () => null } }]]),
  });

  assert.equal(icon, null);
});

test('rejects a non-image content type', async () => {
  clearFaviconCache();
  const icon = await resolveFavicon('sneaky.com', {
    fetchImpl: fakeFetch([[/.*/, okResponse(Buffer.from('<html>'), 'text/html')]]),
  });

  assert.equal(icon, null, 'an HTML body must never be served as an icon');
});

test('rejects an oversized body', async () => {
  clearFaviconCache();
  const icon = await resolveFavicon('huge.com', {
    fetchImpl: fakeFetch([[/.*/, okResponse(Buffer.alloc(200 * 1024), 'image/png')]]),
  });

  assert.equal(icon, null);
});

test('rejects an empty body', async () => {
  clearFaviconCache();
  const icon = await resolveFavicon('empty.com', {
    fetchImpl: fakeFetch([[/.*/, okResponse(Buffer.alloc(0), 'image/png')]]),
  });

  assert.equal(icon, null);
});

test('falls back to apple-touch-icon', async () => {
  clearFaviconCache();
  const seen = [];
  const fetchImpl = fakeFetch([
    [
      /apple-touch-icon/,
      okResponse(PNG, 'image/png', 'https://apple.com/apple-touch-icon.png'),
    ],
    [/.*/, () => {
      seen.push('fallback');
      return { ok: false, status: 404, url: 'x', headers: { get: () => null } };
    }],
  ]);

  const icon = await resolveFavicon('apple.com', { fetchImpl });
  assert.ok(icon, 'should fall back to the touch icon');
  assert.ok(seen.includes('fallback'));
});

// --- input validation ----------------------------------------------------

test('refuses private, loopback and metadata addresses (SSRF)', async () => {
  clearFaviconCache();
  const calls = { n: 0 };
  const fetchImpl = fakeFetch([
    [
      /.*/,
      () => {
        calls.n++;
        return okResponse();
      },
    ],
  ]);

  // The proxy makes outbound requests for whoever supplies this value, so
  // reaching an internal host or the cloud metadata endpoint is a real SSRF.
  const internal = [
    '127.0.0.1', // loopback
    '127.1', // loopback, short form
    '0.0.0.0', // "this network"
    '10.0.0.5', // RFC1918
    '10.255.255.255',
    '172.16.0.1', // RFC1918 lower bound
    '172.31.255.255', // RFC1918 upper bound
    '192.168.1.1', // RFC1918
    '169.254.169.254', // cloud metadata
    '169.254.0.1', // link-local
    '100.64.0.1', // CGNAT
    '192.0.2.1', // documentation range
    '198.18.0.1', // benchmarking
    '224.0.0.1', // multicast
    '240.0.0.1', // reserved
    '999.999.999.999', // not a real address
    '255.255.255.255', // broadcast, within the reserved 240/4 block
    'localhost',
    // Shorthand and hex notations that curl and browsers still resolve.
    '127.1',
    '0177.0.0.1',
    '0x7f000001',
    '0x7f.0.0.1',
    '10.1',
    '192.168.257',
    '169.254.169.254.',
  ];

  for (const host of internal) {
    assert.equal(isValidDomain(host), false, `${host} must be refused`);

    // Also assert at the resolver level: the gate must stop the request, not
    // merely return null after the fact.
    const icon = await resolveFavicon(host, { fetchImpl });
    assert.equal(icon, null, `${host} must resolve to no icon`);
  }

  // And nothing may have been sent anywhere.
  assert.equal(calls.n, 0, 'no request may be made for an internal address');
});

test('public IP addresses are still allowed', () => {
  // The RFC1918 boundaries are inclusive; these sit just outside them and must
  // not be refused. Guards against an off-by-one that breaks real hosts, and
  // against shorthand expansion corrupting a full four-octet address.
  for (const host of [
    '172.15.0.1', // just below RFC1918
    '172.32.0.1', // just above RFC1918
    '9.255.255.255', // just below RFC1918 10/8
    '11.0.0.1', // just above RFC1918 10/8
    '8.8.8.8', // Google DNS
    '1.1.1.1', // Cloudflare DNS
    '223.255.255.255', // upper public boundary
    '223.0.0.1', // just below multicast
  ]) {
    assert.equal(isValidDomain(host), true, `${host} is public and must be allowed`);
  }
});

test('still accepts ordinary public hosts', () => {
  for (const host of ['example.com', 'github.com', 'sub.domain.co.uk', 'xn--n3h.com', 'a.io']) {
    assert.equal(isValidDomain(host), true, `${host} must be accepted`);
  }
});

test('the cache is bounded', async () => {
  clearFaviconCache();
  const fetchImpl = fakeFetch([[/.*/, okResponse()]]);

  // Far more distinct domains than the cache should hold.
  for (let i = 0; i < 2200; i++) {
    await resolveFavicon(`host${i}.example.com`, { fetchImpl });
  }

  assert.ok(
    faviconCacheSize() <= 2048,
    `cache must be bounded, got ${faviconCacheSize()}`
  );

  clearFaviconCache();
});

test('rejects malformed or hostile domains without fetching', async () => {
  clearFaviconCache();
  let calls = 0;
  const fetchImpl = fakeFetch([
    [/.*/, () => {
      calls++;
      return okResponse();
    }],
  ]);

  const bad = [
    '',
    'not a domain',
    'localhost',
    'evil.com/../../etc',
    'http://example.com',
    'example.com:8080',
    'user:pass@example.com',
    'a'.repeat(300),
    null,
    undefined,
    123,
  ];

  for (const domain of bad) {
    const icon = await resolveFavicon(domain, { fetchImpl });
    assert.equal(icon, null, `${String(domain)} must be rejected`);
  }

  assert.equal(calls, 0, 'no request should be made for invalid input');
});

// --- SSRF hardening ------------------------------------------------------

/**
 * A redirect response carrying only a Location and no body — what a real
 * 302 looks like to fetch with redirect: 'manual'.
 */
function redirectResponse(location, status = 302) {
  return {
    ok: false,
    status,
    url: '',
    headers: { get: (name) => (name.toLowerCase() === 'location' ? location : null) },
  };
}

test('a redirect to an internal address is refused', async () => {
  clearFaviconCache();
  const seen = [];

  // A public host that bounces the request at the cloud metadata endpoint.
  const fetchImpl = async (url) => {
    seen.push(url);
    if (/favicon\.ico$/.test(url)) {
      return redirectResponse('https://169.254.169.254/latest/meta-data/');
    }
    if (/apple-touch-icon/.test(url)) {
      return redirectResponse('http://127.0.0.1/admin');
    }
    return okResponse();
  };

  const icon = await resolveFavicon('rebind.example.com', { fetchImpl });

  assert.equal(icon, null, 'an internal redirect target must be refused');
  assert.ok(
    !seen.some((u) => /169\.254\.169\.254|127\.0\.0\.1/.test(u)),
    `no request may reach an internal host, saw: ${seen.join(', ')}`
  );

  clearFaviconCache();
});

test('a same-host redirect chain is followed', async () => {
  clearFaviconCache();
  const icon = await resolveFavicon('chain.example.com', {
    fetchImpl: fakeFetch([
      // /favicon.ico 302s to the touch icon on the same host.
      [/\/favicon\.ico$/, () => redirectResponse('https://chain.example.com/apple-touch-icon.png')],
      [/apple-touch-icon/, okResponse(PNG, 'image/png', 'https://chain.example.com/apple-touch-icon.png')],
    ]),
  });

  assert.ok(icon, 'a same-host redirect should still be followed');
  assert.equal(icon.contentType, 'image/png');

  clearFaviconCache();
});

test('a redirect loop terminates', async () => {
  clearFaviconCache();
  const fetchImpl = fakeFetch([
    [/.*/, () => redirectResponse('https://loop.example.com/favicon.ico')],
  ]);

  const icon = await resolveFavicon('loop.example.com', { fetchImpl });
  assert.equal(icon, null, 'a loop must not spin forever');

  clearFaviconCache();
});

test('redirects are followed manually, not by the runtime', async () => {
  clearFaviconCache();
  let redirectMode;

  await resolveFavicon('mode.example.com', {
    fetchImpl: async (requested, init) => {
      redirectMode = init.redirect;
      return okResponse(PNG, 'image/png', requested);
    },
  });

  // 'follow' would hide intermediate hops from the private-address checks.
  assert.equal(redirectMode, 'manual');

  clearFaviconCache();
});

test('does not serve an icon that redirected to another host', async () => {
  clearFaviconCache();
  const icon = await resolveFavicon('redirector.com', {
    fetchImpl: fakeFetch([
      // Claims success, but reports a final URL on a different host.
      [/.*/, okResponse(PNG, 'image/png', 'https://attacker.internal/secret.png')],
    ]),
  });

  assert.equal(icon, null, 'a cross-host redirect must be discarded');
});

test('sends a browser-ish user agent', async () => {
  clearFaviconCache();
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = init;
    return okResponse();
  };

  await resolveFavicon('ua.com', { fetchImpl });

  assert.match(captured.headers['User-Agent'], /Linkly/);
  assert.ok(captured.signal, 'a timeout signal must be attached');
});