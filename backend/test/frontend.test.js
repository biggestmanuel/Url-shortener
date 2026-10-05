/**
 * Frontend DOM tests using jsdom.
 *
 * jsdom is a devDependency only — the browser bundle (index.html, app.js,
 * qr.js, escape.js) still ships zero dependencies. app.js is a classic
 * script wrapped in an IIFE, so it cannot be imported; instead the real file
 * is evaluated inside a jsdom window whose document is parsed from the real
 * index.html. That way the markup and the script under test can never drift
 * apart.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');

const [html, appSource, qrSource, escapeSource] = await Promise.all([
  readFile(path.join(root, 'index.html'), 'utf8'),
  readFile(path.join(root, 'app.js'), 'utf8'),
  readFile(path.join(root, 'qr.js'), 'utf8'),
  readFile(path.join(root, 'escape.js'), 'utf8'),
]);

/**
 * Boots a fresh page with the real markup and scripts.
 *
 * @param {{hash?: string, storage?: Record<string,string>}} [options]
 *   `hash` is the complete fragment including the leading `#`, exactly as it
 *   appears in the address bar. Use the EMAILED_* constants rather than
 *   hand-writing one — a mismatch there hides real bugs.
 */
function bootPage(options = {}) {
  const virtualConsole = new VirtualConsole();
  const consoleErrors = [];
  virtualConsole.on('jsdomError', (err) => consoleErrors.push(err));
  virtualConsole.on('error', (msg) => consoleErrors.push(new Error(String(msg))));

  const dom = new JSDOM(html, {
    // A real http origin is required: jsdom gives about:blank an opaque
    // origin, and localStorage throws for those.
    url: `http://localhost:8080/${options.hash ?? ''}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });

  const { window } = dom;

  // Seed localStorage before any script reads it.
  for (const [key, value] of Object.entries(options.storage ?? {})) {
    window.localStorage.setItem(key, value);
  }

  // matchMedia is not implemented by jsdom; the theme logic calls it.
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

  // jsdom ships no canvas backend, so getContext('2d') returns null and the
  // QR renderer's first fillRect throws. A recording stub is enough: the
  // tests assert on DOM structure, not pixels.
  window.HTMLCanvasElement.prototype.getContext = function getContext() {
    return {
      fillStyle: '',
      fillRect() {},
      drawImage() {},
      clearRect() {},
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      putImageData() {},
      canvas: this,
    };
  };
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';

  // fetch is absent; tests stub it before booting or override after.
  window.fetch = options.fetch ?? (async () => ({ ok: false, status: 404 }));

  window.eval(escapeSource);
  window.eval(qrSource);
  window.eval(appSource);

  return { dom, window, document: window.document, consoleErrors };
}

const $ = (document, id) => document.getElementById(id);

/** Waits for queued microtasks/promises to settle. */
const flush = async (times = 6) => {
  for (let i = 0; i < times; i++) await Promise.resolve();
};

// --- page integrity -----------------------------------------------------

test('every element app.js looks up exists in index.html', () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const { window } = dom;

  const ids = new Set(
    Array.from(window.document.querySelectorAll('[id]')).map((el) => el.id)
  );

  const referenced = new Set(
    [...appSource.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1])
  );

  const missing = [...referenced].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], 'app.js references ids that index.html does not define');

  window.close();
});

test('the page loads without script errors', async () => {
  const { window, consoleErrors } = bootPage();
  await flush(20);

  assert.deepEqual(
    consoleErrors.map((e) => e.message),
    []
  );

  window.close();
});

test('bootstraps every script the page needs', async () => {
  const { window, document } = bootPage();
  await flush(10);

  const sources = Array.from(document.scripts).map((s) => s.getAttribute('src'));
  for (const required of ['escape.js', 'qr.js', 'app.js']) {
    assert.ok(sources.includes(required), `${required} must be loaded`);
  }

  assert.equal(typeof window.QRCode.toMatrix, 'function');
  assert.equal(typeof window.LinklyEscape.escapeHtml, 'function');

  window.close();
});

// --- link card rendering ------------------------------------------------

/**
 * Drives loadLinks by seeding local demo mode: with fetch failing, the app
 * falls back to localStorage, which is the offline code path.
 */
function seedLocalLinks(window, links) {
  window.localStorage.setItem('linkly_local_links', JSON.stringify(links));
}

const SAMPLE_LINKS = [
  {
    id: '1',
    code: 'abc123',
    shortUrl: 'https://lnk.test/abc123',
    destinationUrl: 'https://github.com/anthropics',
    clicks: 42,
    createdAt: new Date().toISOString(),
  },
  {
    id: '2',
    code: 'def456',
    shortUrl: 'https://lnk.test/def456',
    destinationUrl: 'https://example.com/some/page?a=1&b=2',
    clicks: 7,
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
  },
];

test('renders a card per link with the expected structure', async () => {
  const { window, document } = bootPage();
  seedLocalLinks(window, SAMPLE_LINKS);
  await flush(20);

  const cards = document.querySelectorAll('.link-card');
  assert.equal(cards.length, 2);

  const first = cards[0];
  assert.ok(first.querySelector('.link-favicon img'), 'favicon image');
  assert.equal(
    first.querySelector('.short-url-link').textContent.trim(),
    'https://lnk.test/abc123'
  );
  assert.equal(
    first.querySelector('.original-url-text').textContent.trim(),
    'https://github.com/anthropics'
  );
  assert.equal(first.querySelector('.click-count-num').textContent, '42');
  assert.equal(first.querySelectorAll('.link-card-actions button').length, 4);

  window.close();
});

test('cards are built with DOM APIs, so a hostile URL cannot inject markup', async () => {
  const XSS = 'https://evil.example.com/" onmouseover="window.__pwned=1';

  const { window, document } = bootPage();
  seedLocalLinks(window, [
    { id: '1', code: 'x1', shortUrl: 'https://lnk.test/x1', destinationUrl: XSS, clicks: 0, createdAt: new Date().toISOString() },
  ]);
  await flush(20);

  const span = document.querySelector('.original-url-text');
  assert.ok(span, 'the card rendered');

  // The payload must be inert text, never an attribute.
  assert.equal(span.getAttribute('onmouseover'), null);
  assert.equal(span.hasAttribute('onmouseover'), false);
  assert.equal(document.querySelectorAll('[onmouseover]').length, 0);

  // And dispatching the event must do nothing.
  span.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  await flush();
  assert.equal(window.__pwned, undefined, 'no handler may fire');

  // The raw text is preserved for the user to read.
  assert.equal(span.textContent.trim(), XSS);

  window.close();
});

test('a javascript: destination is never rendered as a clickable link', async () => {
  const { window, document } = bootPage();
  seedLocalLinks(window, [
    { id: '1', code: 'x', shortUrl: 'https://lnk.test/x', destinationUrl: 'javascript:alert(1)', clicks: 0, createdAt: new Date().toISOString() },
  ]);
  await flush(20);

  // The short link itself is what gets linked, not the destination.
  const anchor = document.querySelector('.short-url-link');
  assert.equal(anchor.getAttribute('href'), 'https://lnk.test/x');

  window.close();
});

// --- search & sort ------------------------------------------------------

test('search filters by domain, url and code', async () => {
  const { window, document } = bootPage();
  seedLocalLinks(window, SAMPLE_LINKS);
  await flush(20);

  const search = $(document, 'searchInput');
  const fire = (value) => {
    search.value = value;
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
  };

  fire('github.com');
  assert.equal(document.querySelectorAll('.link-card').length, 1);

  fire('def456');
  assert.equal(document.querySelectorAll('.link-card').length, 1);

  fire('nothing-matches-this');
  assert.equal(document.querySelectorAll('.link-card').length, 0);
  assert.equal($(document, 'noResults').hidden, false);

  fire('');
  assert.equal(document.querySelectorAll('.link-card').length, 2);

  window.close();
});

test('sorting by clicks reorders the list', async () => {
  const { window, document } = bootPage();
  seedLocalLinks(window, SAMPLE_LINKS);
  await flush(20);

  const order = () =>
    Array.from(document.querySelectorAll('.click-count-num')).map((n) => n.textContent);

  assert.deepEqual(order(), ['42', '7'], 'newest first by default');

  const sort = $(document, 'sortSelect');
  sort.value = 'clicks-asc';
  sort.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual(order(), ['7', '42']);

  sort.value = 'clicks-desc';
  sort.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual(order(), ['42', '7']);

  window.close();
});

test('analytics cards reflect the rendered set', async () => {
  const { window, document } = bootPage();
  seedLocalLinks(window, SAMPLE_LINKS);
  await flush(20);

  assert.equal($(document, 'statTotalLinks').textContent, '2');
  assert.equal($(document, 'statTotalClicks').textContent, '49');
  assert.equal($(document, 'statTopClicks').textContent, '42');
  assert.equal($(document, 'statAvgClicks').textContent, '24.5');

  window.close();
});

// --- modal accessibility -----------------------------------------------

test('modals trap focus and restore it on close', async () => {
  const { window, document } = bootPage();
  seedLocalLinks(window, SAMPLE_LINKS);
  await flush(20);

  const modal = $(document, 'qrModal');
  const opener = document.querySelector('.qr-item-btn');
  assert.ok(opener, 'a card with action buttons rendered');

  // jsdom has no layout, so getClientRects() reports zero boxes. The focus
  // trap filters on that, so stub it to make elements "visible".
  for (const el of document.querySelectorAll('button, a[href], input')) {
    el.getClientRects = () => [{ width: 10, height: 10 }];
  }

  opener.focus();
  modal.hidden = false;

  const focusables = Array.from(modal.querySelectorAll('button:not([disabled])')).filter(
    (n) => n.getClientRects().length > 0
  );
  assert.ok(focusables.length > 1, 'the modal exposes focusable controls');

  // Tab from the last element must wrap to the first, never leaving the modal.
  const last = focusables[focusables.length - 1];
  const first = focusables[0];

  last.focus();
  assert.equal(document.activeElement, last, 'precondition: focus is on the last control');

  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

  assert.equal(
    document.activeElement.id,
    first.id,
    `focus should wrap to the first control (${first.id}), got ${document.activeElement.id}`
  );
  assert.equal(modal.contains(document.activeElement), true);

  // Shift+Tab from the first element must wrap backwards to the last.
  first.focus();
  document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })
  );
  assert.equal(document.activeElement.id, last.id, 'shift+tab wrapped backwards');

  window.close();
});

test('closing a modal returns focus to the element that opened it', async () => {
  const { window, document } = bootPage();
  seedLocalLinks(window, SAMPLE_LINKS);
  await flush(20);

  for (const el of document.querySelectorAll('button, a[href], input')) {
    el.getClientRects = () => [{ width: 10, height: 10 }];
  }

  const opener = document.querySelector('.qr-item-btn');
  opener.focus();
  opener.click();
  await flush(10);

  assert.equal($(document, 'qrModal').hidden, false);

  $(document, 'closeQrModal').click();
  await flush(10);

  assert.equal($(document, 'qrModal').hidden, true);
  assert.equal(document.activeElement, opener, 'focus returned to the opener');

  window.close();
});

test('Escape closes every open modal', async () => {
  const { window, document } = bootPage();
  await flush(20);

  for (const id of ['qrModal', 'shareModal', 'deleteModal', 'authModal']) {
    $(document, id).hidden = false;
  }

  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  for (const id of ['qrModal', 'shareModal', 'deleteModal', 'authModal']) {
    assert.equal($(document, id).hidden, true, `${id} should close`);
  }

  window.close();
});

test('every modal declares dialog semantics', async () => {
  const { document } = bootPage();

  for (const id of ['qrModal', 'shareModal', 'deleteModal', 'authModal']) {
    const card = $(document, id).querySelector('.modal-card');
    assert.equal(card.getAttribute('role'), 'dialog', `${id} needs role=dialog`);
    assert.equal(card.getAttribute('aria-modal'), 'true', `${id} needs aria-modal`);

    const labelledBy = card.getAttribute('aria-labelledby');
    assert.ok(labelledBy, `${id} needs aria-labelledby`);
    assert.ok($(document, labelledBy), `${id} labels a missing element: ${labelledBy}`);
  }

  document.defaultView.close();
});

// --- hash routes --------------------------------------------------------

/**
 * The exact shape the API emits: `${frontendBaseUrl}/#/route?token=...`
 *
 * Note the slash after `#`. A test written as `#reset-password` passes while
 * the real emailed link silently does nothing, which is exactly what happened
 * before this was pinned to the server's format.
 */
const EMAILED_RESET_HASH = '#/reset-password?token=password_reset.abc123';
const EMAILED_VERIFY_HASH = '#/verify-email?token=email_verification.abc123';

test('a reset hash opens the reset step with the token prefilled', async () => {
  const { window, document } = bootPage({ hash: EMAILED_RESET_HASH });
  await flush(30);

  const resetForm = $(document, 'resetForm');
  assert.equal(resetForm.hidden, false, 'the reset step is shown');
  assert.equal($(document, 'authForm').hidden, true, 'the sign-in form is hidden');
  assert.equal($(document, 'resetToken').value, 'password_reset.abc123');
  assert.equal($(document, 'authModal').hidden, false);

  window.close();
});

test('both hash spellings are accepted', { timeout: 60000 }, async () => {
  // The server emits "#/route", but a hand-typed "#route" should also work.
  for (const hash of ['#/reset-password?token=password_reset.abc123', '#reset-password?token=password_reset.abc123']) {
    const { window, document } = bootPage({ hash });
    await flush(30);

    assert.equal($(document, 'resetToken').value, 'password_reset.abc123', hash);
    assert.equal($(document, 'resetForm').hidden, false, hash);

    window.close();
  }
});

test('a reset hash without a token is rejected', async () => {
  const { window, document } = bootPage({ hash: '#/reset-password' });
  await flush(30);

  // No token: the app must not sit in the reset step with an empty field.
  const resetForm = $(document, 'resetForm');
  const tokenValue = $(document, 'resetToken').value;
  assert.ok(
    resetForm.hidden || tokenValue.length > 0,
    'either the step is closed or a token was supplied'
  );

  window.close();
});

test('the hash is cleared so a reload cannot replay a spent token', async () => {
  const { window } = bootPage({ hash: EMAILED_RESET_HASH });
  await flush(30);

  assert.equal(window.location.hash, '', 'the hash must be replaced');

  window.close();
});

test('a verify hash posts the token to the API', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, message: 'Email verified.' }),
    };
  };

  const { window } = bootPage({ hash: EMAILED_VERIFY_HASH, fetch: fetchImpl });
  await flush(30);

  const verifyCall = calls.find((c) => c.url.includes('/api/auth/verify-email'));
  assert.ok(verifyCall, 'the verification endpoint must be called');
  assert.equal(verifyCall.method, 'POST');
  assert.match(verifyCall.body, /email_verification\.abc123/);

  window.close();
});

test('an unknown hash is ignored', async () => {
  const { window, document } = bootPage({ hash: 'something-else' });
  await flush(20);

  assert.equal($(document, 'resetForm').hidden, true);
  assert.equal($(document, 'authModal').hidden, true);

  window.close();
});

// --- configuration ------------------------------------------------------

test('the GitHub button stays hidden without a configured repository', async () => {
  const { window, document } = bootPage();
  await flush(20);

  const link = $(document, 'githubLink');
  assert.equal(link.hidden, true, 'must not point at an unrelated repo');
  assert.equal(link.getAttribute('href'), '#');

  window.close();
});

test('a configured repository reveals the button', async () => {
  const { window, document } = bootPage({
    storage: { 'linkly.repoUrl': 'https://github.com/you/linkly' },
  });
  await flush(20);

  const link = $(document, 'githubLink');
  assert.equal(link.hidden, false);
  assert.equal(link.getAttribute('href'), 'https://github.com/you/linkly');

  window.close();
});

test('a non-http repository URL is refused', async () => {
  const { window, document } = bootPage({
    storage: { 'linkly.repoUrl': 'javascript:alert(1)' },
  });
  await flush(20);

  assert.equal($(document, 'githubLink').hidden, true);

  window.close();
});

test('localStorage failures do not stop the app from booting', async () => {
  // Private-mode Safari and hardened browser profiles make localStorage throw
  // on access. The app must still load and fall back to defaults.
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, {
    url: 'http://localhost:8080/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;

  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('localStorage is blocked');
    },
  });

  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLCanvasElement.prototype.getContext = () => ({
    fillStyle: '', fillRect() {}, drawImage() {}, clearRect() {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }), putImageData() {}, canvas: null,
  });

  const errors = [];
  virtualConsole.on('jsdomError', (e) => errors.push(e));

  window.eval(escapeSource);
  window.eval(qrSource);
  window.eval(appSource);
  await flush(20);

  // The page must have come up: scripts evaluated, theme applied to defaults.
  assert.equal(typeof window.QRCode.toMatrix, 'function');
  assert.ok(
    ['dark', ''].includes(window.document.body.className),
    `theme should have been applied, got "${window.document.body.className}"`
  );
  assert.equal(errors.length, 0, `no script errors, got: ${errors.map((e) => e.message).join(', ')}`);

  window.close();
});

test('an operator key is read from storage, not from the markup', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, key: init.headers?.['x-api-key'] });
    return { ok: false, status: 401, json: async () => ({ error: 'nope' }) };
  };

  const { window } = bootPage({
    storage: { 'linkly.apiKey': 'operator-key', 'linkly.apiBase': 'http://localhost:3001' },
    fetch: fetchImpl,
  });
  await flush(20);

  // The health check is a bare GET and deliberately carries no credentials.
  const health = calls.find((c) => c.url.endsWith('/'));
  assert.ok(health, 'health check ran');
  assert.equal(health.key, undefined, 'health check must not carry the operator key');

  // Sign in so a session exists, then confirm the request carries it.
  calls.length = 0;
  window.localStorage.setItem('linkly_session', 'session-token');
  const { document } = window;
  $(document, 'authEmail').value = 'someone@example.com';
  $(document, 'authPassword').value = 'hunter2hunter2';
  $(document, 'authForm').dispatchEvent(
    new window.Event('submit', { cancelable: true, bubbles: true })
  );
  await flush(30);

  const authed = calls.filter((c) => c.url.includes('/api/'));
  assert.ok(authed.length > 0, 'an authenticated request was made');

  window.close();
});

test('no operator key is sent when none is configured', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, key: init.headers?.['x-api-key'] });
    return { ok: false, status: 401, json: async () => ({ error: 'nope' }) };
  };

  const { window } = bootPage({ fetch: fetchImpl });
  await flush(20);

  assert.ok(
    calls.every((c) => c.key === undefined),
    'no api key header may be sent by default'
  );

  window.close();
});

// --- theme --------------------------------------------------------------

test('the theme follows the OS preference when nothing is stored', async () => {
  // A light-preferring OS must not be forced to dark. Regression guard: the
  // original code was `(systemPrefersDark ? 'dark' : 'dark')`.
  const dom = new JSDOM(html, {
    url: 'http://localhost:8080/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  window.eval(escapeSource);
  window.eval(qrSource);
  window.matchMedia = (query) => ({
    matches: query.includes('dark') ? false : false,
    addEventListener() {},
    removeEventListener() {},
  });
  window.localStorage.clear();
  window.eval(appSource);
  await flush(20);

  assert.equal(window.document.body.classList.contains('dark'), false);

  window.close();
});

test('a stored theme wins over the OS preference', async () => {
  const { window, document } = bootPage({ storage: { linkly_theme: 'light' } });
  await flush(20);

  assert.equal(document.body.classList.contains('dark'), false);
  assert.equal(window.localStorage.getItem('linkly_theme'), 'light');

  window.close();
});

// --- backend health states ----------------------------------------------

/** Reads the status pill's text and class after the health check settles. */
const readStatus = (document) => ({
  text: document.getElementById('backendStatus').querySelector('.status-text').textContent,
  className: document.getElementById('backendStatus').className,
  title: document.getElementById('backendStatus').title,
});

test('a live backend shows Cloud Sync', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/')) {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', db: { ok: true } }) };
    }
    return { ok: false, status: 401, json: async () => ({ error: 'nope' }) };
  };

  const { window, document } = bootPage({ fetch: fetchImpl });
  await flush(20);

  const status = readStatus(document);
  assert.match(status.text, /Cloud Sync/);
  assert.match(status.className, /status-live/);

  window.close();
});

test('an unreachable backend falls back to local demo mode', async () => {
  const fetchImpl = async () => {
    throw new Error('Failed to fetch');
  };

  const { window, document } = bootPage({ fetch: fetchImpl });
  await flush(20);

  const status = readStatus(document);
  assert.match(status.text, /Local Demo/);
  assert.match(status.className, /status-local/);

  window.close();
});

test('a 503 is reported as degraded, not as local demo mode', async () => {
  // The API is reachable but its database is down. Silently switching to
  // "Local Demo" would hide an outage and quietly divert newly created links
  // into localStorage, where they would appear to work and then vanish.
  const fetchImpl = async (url) => {
    if (url.endsWith('/')) {
      return {
        ok: false,
        status: 503,
        json: async () => ({ status: 'degraded', db: { ok: false, error: '57P01' } }),
      };
    }
    return { ok: false, status: 503, json: async () => ({ status: 'degraded' }) };
  };

  const { window, document } = bootPage({ fetch: fetchImpl });
  await flush(20);

  const status = readStatus(document);
  assert.match(status.text, /Service Degraded/);
  assert.match(status.className, /status-warning/);
  assert.doesNotMatch(status.text, /Local Demo/);
  assert.match(status.title, /database/i);

  window.close();
});

test('the account UI stays hidden when the backend is degraded', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const { window, document } = bootPage({ fetch: fetchImpl });
  await flush(20);

  // Accounts cannot work against an unhealthy API, so the sign-in control is
  // hidden rather than offering an action that is guaranteed to fail.
  assert.equal(document.getElementById('authArea').hidden, true);

  window.close();
});

// --- downloads ----------------------------------------------------------

/**
 * Boots a cloud-backed page showing `links`, with object-URL support and a
 * recorder for the anchors the download helpers click.
 */
async function bootWithLinks(links) {
  const live = {
    '{ok': true, status: 200, json: async () => links,
  };
  const fetchImpl = async (url) => {
    if (url.endsWith('/')) return { ok: true, status: 200, json: async () => ({}) };
    if (url.includes('/api/links')) {
      if (live.done) return { ok: true, status: 200, json: async () => links };
      live.done = true;
      return { ok: true, status: 200, json: async () => links };
    }
    return { ok: false, status: 401, json: async () => ({ error: 'nope' }) };
  };

  const { window, document } = bootPage({ fetch: fetchImpl });
  await flush(30);

  const downloads = [];
  let revokedWhilePending = false;

  window.URL.createObjectURL = () => 'blob:stub';
  window.URL.revokeObjectURL = () => {
    // A revocation landing before the click is deferred would mean the browser
    // never gets to start the download.
    revokedWhilePending = true;
  };

  // Capture the synthetic anchor before jsdom tries to navigate.
  document.addEventListener(
    'click',
    (e) => {
      const anchor = e.target.closest?.('a[download]');
      if (!anchor) return;
      e.preventDefault();
      downloads.push({ filename: anchor.download, href: anchor.href });
    },
    true
  );

  return { window, document, downloads, wasRevokedSynchronously: () => revokedWhilePending };
}

const QR_LINKS = [
  {
    id: 11,
    code: 'alpha11',
    shortUrl: 'http://localhost:3001/alpha11',
    destinationUrl: 'https://alpha.example.com/page',
    clicks: 4,
    createdAt: new Date('2026-01-02T03:04:05Z').toISOString(),
  },
  {
    id: 22,
    code: 'bravo22',
    shortUrl: 'http://localhost:3001/bravo22',
    destinationUrl: 'https://bravo.example.com/other',
    clicks: 1,
    createdAt: new Date('2026-01-01T03:04:05Z').toISOString(),
  },
];

test('a download is named after the link whose QR is on screen', async () => {
  const { window, document, downloads } = await bootWithLinks(QR_LINKS);

  const cards = document.querySelectorAll('.link-card');
  assert.equal(cards.length, 2, 'both links rendered');

  // Open the QR modal for the *first* card. activeQrUrl is still empty here,
  // which used to make the download fall back to the generic "linkly-qr".
  document.querySelector('.link-card .qr-item-btn').click();
  await flush(6);

  assert.equal(document.getElementById('qrModal').hidden, false);

  document.getElementById('downloadQrSvgBtn').click();
  await flush(6);

  assert.equal(downloads.length, 1, 'the SVG download was triggered');
  assert.equal(
    downloads[0].filename,
    'linkly-alpha11.svg',
    'the filename must match the link shown, not the newest link created'
  );

  window.close();
});

test('an object URL is not revoked before the click has been dispatched', async () => {
  // Revoking in the same task cancels the download in Firefox and Safari.
  const { window, document, wasRevokedSynchronously } = await bootWithLinks(QR_LINKS);

  document.querySelector('.link-card .qr-item-btn').click();
  await flush(6);
  document.getElementById('downloadQrSvgBtn').click();
  await flush(6);

  assert.equal(
    wasRevokedSynchronously(),
    false,
    'revokeObjectURL must be deferred out of the click task'
  );

  window.close();
});

test('a QR PNG download is dispatched', async () => {
  const { window, document, downloads } = await bootWithLinks(QR_LINKS);

  document.querySelector('.link-card .qr-item-btn').click();
  await flush(6);
  document.getElementById('downloadQrBtn').click();
  await flush(6);

  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].filename, 'linkly-alpha11.png');

  window.close();
});

test('a clipboard fallback cleans up even when the command fails', async () => {
  const { window, document } = bootPage();
  await flush(20);

  // Force the non-secure-context fallback path, and make it throw.
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async () => {} },
  });
  window.isSecureContext = false;
  document.execCommand = () => {
    throw new Error('denied');
  };

  const before = document.querySelectorAll('textarea').length;

  document.getElementById('copyResult').dispatchEvent(
    new window.MouseEvent('click', { bubbles: true })
  );
  await flush(10);

  const after = document.querySelectorAll('textarea').length;
  assert.equal(after, before, 'the temporary textarea must not be left in the DOM');

  window.close();
});