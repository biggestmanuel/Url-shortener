/**
 * Linkly — Next-Gen URL Shortener Application Script
 * Vanilla ES6+ with Hybrid Cloud/Local Fallback, QR Generation, Analytics & Rich UI
 */

(function () {
  'use strict';

  // --- Configuration ---
  //
  // Runtime settings live in localStorage rather than a config file:
  //   linkly.apiBase  -> API origin (defaults to http://localhost:3001)
  //   linkly.apiKey   -> operator key, only for REQUIRE_API_KEY_TO_CREATE
  //   linkly.repoUrl  -> repository for the "View Source" button
  //
  // Keeping these out of the served markup means an operator key never ships
  // to every visitor, and there is no optional-file request to 404. Set them
  // from the console, e.g. localStorage.setItem('linkly.apiBase', 'https://x').

  const CONFIG_KEYS = {
    apiBase: 'linkly.apiBase',
    apiKey: 'linkly.apiKey',
    repoUrl: 'linkly.repoUrl',
  };

  function readConfig(name) {
    try {
      return localStorage.getItem(name) || '';
    } catch {
      // Blocked or private-mode storage: fall back to the default.
      return '';
    }
  }

  // Read once at load: these are captured by every request closure, so a
  // change needs a reload.
  const API_BASE = (readConfig(CONFIG_KEYS.apiBase) || 'http://localhost:3001').replace(/\/+$/, '');
  const API_KEY = readConfig(CONFIG_KEYS.apiKey);
  const REPO_URL = readConfig(CONFIG_KEYS.repoUrl);

  const MAX_URL_LENGTH = 2048;
  const LOCAL_STORAGE_KEY = 'linkly_local_links';
  const THEME_STORAGE_KEY = 'linkly_theme';
  // Per-link delete secrets, keyed by link id. The server hands each one out
  // exactly once, at creation time.
  const OWNER_TOKENS_KEY = 'linkly_owner_tokens';
  // Session token for a signed-in account. Sent as `Authorization: Bearer`.
  const SESSION_KEY = 'linkly_session';

  // --- State ---
  let linksState = [];
  let isCloudBackend = false;
  let currentDeleteId = null;
  let activeQrUrl = '';
  let currentUser = null;

  // --- DOM Elements ---
  const form = document.getElementById('shortenForm');
  const urlInput = document.getElementById('url');
  const customAliasInput = document.getElementById('customAlias');
  const toggleAliasBtn = document.getElementById('toggleAliasBtn');
  const aliasDrawer = document.getElementById('aliasDrawer');
  const shortenBtn = document.getElementById('shortenBtn');
  const pasteBtn = document.getElementById('pasteBtn');
  const urlError = document.getElementById('urlError');
  const errorMessage = document.getElementById('errorMessage');

  const resultBox = document.getElementById('result');
  const shortLinkEl = document.getElementById('shortLink');
  const copyResultBtn = document.getElementById('copyResult');
  const qrResultBtn = document.getElementById('qrResultBtn');
  const shareResultBtn = document.getElementById('shareResultBtn');
  const visitResultBtn = document.getElementById('visitResultBtn');

  const linkListEl = document.getElementById('linkList');
  const linkCountEl = document.getElementById('linkCount');
  const loadingEl = document.getElementById('loading');
  const emptyState = document.getElementById('empty');
  const noResultsState = document.getElementById('noResults');

  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  const resetSearchBtn = document.getElementById('resetSearchBtn');
  const sortSelect = document.getElementById('sortSelect');

  const exportBtn = document.getElementById('exportBtn');
  const exportMenu = document.getElementById('exportMenu');
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  const exportJsonBtn = document.getElementById('exportJsonBtn');

  const statTotalLinks = document.getElementById('statTotalLinks');
  const statTotalClicks = document.getElementById('statTotalClicks');
  const statTopClicks = document.getElementById('statTopClicks');
  const statAvgClicks = document.getElementById('statAvgClicks');

  const backendStatus = document.getElementById('backendStatus');

  const authArea = document.getElementById('authArea');
  const authTrigger = document.getElementById('authTrigger');
  const authTriggerLabel = document.getElementById('authTriggerLabel');
  const authModal = document.getElementById('authModal');
  const closeAuthModal = document.getElementById('closeAuthModal');
  const authForm = document.getElementById('authForm');
  const authEmail = document.getElementById('authEmail');
  const authPassword = document.getElementById('authPassword');
  const authHint = document.getElementById('authHint');
  const authError = document.getElementById('authError');
  const authErrorMessage = document.getElementById('authErrorMessage');
  const authSubmit = document.getElementById('authSubmit');
  const authSubmitLabel = document.getElementById('authSubmitLabel');
  const authTabs = document.querySelector('.auth-tabs');
  const authTabSignIn = document.getElementById('authTabSignIn');
  const authTabRegister = document.getElementById('authTabRegister');
  const authSignOut = document.getElementById('authSignOut');
  const authEmailLabel = document.getElementById('authEmailLabel');
  const authForgotBtn = document.getElementById('authForgotBtn');
  const resetForm = document.getElementById('resetForm');
  const resetToken = document.getElementById('resetToken');
  const resetPassword = document.getElementById('resetPassword');
  const resetHint = document.getElementById('resetHint');
  const resetError = document.getElementById('resetError');
  const resetErrorMessage = document.getElementById('resetErrorMessage');
  const resetSubmit = document.getElementById('resetSubmit');
  const resetBackBtn = document.getElementById('resetBackBtn');
  const verifyBanner = document.getElementById('verifyBanner');
  const verifyBannerText = document.getElementById('verifyBannerText');
  const verifyResendBtn = document.getElementById('verifyResendBtn');
  const themeBtn = document.getElementById('theme');
  const toastContainer = document.getElementById('toastContainer');

  // Modals
  const qrModal = document.getElementById('qrModal');
  const qrCanvas = document.getElementById('qrCanvas');
  const qrModalUrl = document.getElementById('qrModalUrl');
  const closeQrModal = document.getElementById('closeQrModal');
  const downloadQrBtn = document.getElementById('downloadQrBtn');
  const downloadQrSvgBtn = document.getElementById('downloadQrSvgBtn');
  const qrMeta = document.getElementById('qrMeta');

  const shareModal = document.getElementById('shareModal');
  const shareModalUrlInput = document.getElementById('shareModalUrlInput');
  const shareModalCopyBtn = document.getElementById('shareModalCopyBtn');
  const closeShareModal = document.getElementById('closeShareModal');
  const shareXBtn = document.getElementById('shareXBtn');
  const shareWaBtn = document.getElementById('shareWaBtn');
  const shareInBtn = document.getElementById('shareInBtn');
  const shareTgBtn = document.getElementById('shareTgBtn');

  const deleteModal = document.getElementById('deleteModal');
  const deleteModalTarget = document.getElementById('deleteModalTarget');
  const closeDeleteModal = document.getElementById('closeDeleteModal');
  const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
  const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');

  // =========================================================================
  // Escaping Helpers (from escape.js)
  // =========================================================================
  // escapeHtml must keep escaping quotes as well as angle brackets:
  // destination URLs are user input and are interpolated into title="..."
  // attributes, where an unescaped " would allow attribute injection.
  const { escapeHtml, escapeCsvValue } = window.LinklyEscape;

  // =========================================================================
  // QR Code Generator
  // =========================================================================
  // Implemented in qr.js (ISO/IEC 18004, versions 1-10, all EC levels) and
  // exposed as the global `QRCode`. Kept in its own file so the encoder can
  // be unit tested under Node without a DOM.

  // =========================================================================
  // Toast & Alerts System
  // =========================================================================
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let iconSvg;
    if (type === 'success') {
      iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    } else if (type === 'error') {
      iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
    } else {
      iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
    }

    toast.innerHTML = `${iconSvg}<span>${escapeHtml(message)}</span>`;
    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(12px)';
      setTimeout(() => toast.remove(), 250);
    }, 3200);
  }

  function showError(msg = '') {
    if (msg) {
      errorMessage.textContent = msg;
      urlError.hidden = false;
    } else {
      urlError.hidden = true;
    }
  }

  // =========================================================================
  // Helpers & Utilities
  // =========================================================================
  function isValidUrl(val) {
    try {
      const u = new URL(val);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function extractDomain(urlStr) {
    try {
      return new URL(urlStr).hostname;
    } catch {
      return 'link';
    }
  }

  function formatRelativeTime(dateValue) {
    const d = new Date(dateValue);
    if (Number.isNaN(d.getTime())) return 'Recently';

    const now = new Date();
    const diffMs = now - d;
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSecs < 45) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 30) return `${diffDays}d ago`;

    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }).format(d);
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);

      try {
        ta.select();
        return document.execCommand('copy');
      } finally {
        // Without this the hidden textarea stays in the document whenever
        // execCommand throws, which is exactly when we need the fallback.
        ta.remove();
      }
    } catch {
      return false;
    }
  }

  function generateLocalCode() {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  // =========================================================================
  // Local Storage Data Layer
  // =========================================================================
  function getLocalLinks() {
    try {
      const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  }

  function saveLocalLinks(links) {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(links));
    } catch (e) {
      console.warn('LocalStorage save failed:', e);
    }
  }

  // =========================================================================
  // API Request Helpers
  // =========================================================================
  /**
 * Favicons are resolved by our own backend rather than a third-party icon
 * service, so the set of destination domains a visitor looks at never leaves
 * the deployment. Falls back to Google's service only in local demo mode,
 * where there is no backend to ask.
 */
function faviconUrlFor(domain) {
  return isCloudBackend
    ? `${API_BASE}/api/favicon?domain=${encodeURIComponent(domain)}`
    : `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

function apiHeaders(extra) {
    const token = getSessionToken();
    return Object.assign(
      { Accept: 'application/json' },
      token ? { Authorization: `Bearer ${token}` } : null,
      API_KEY ? { 'x-api-key': API_KEY } : null,
      extra || null
    );
  }

  // =========================================================================
  // Session Store
  // =========================================================================
  function getSessionToken() {
    try {
      return localStorage.getItem(SESSION_KEY) || '';
    } catch {
      return '';
    }
  }

  function saveSession(token) {
    try {
      if (token) localStorage.setItem(SESSION_KEY, token);
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) {
      console.warn('Session storage failed:', e);
    }
  }

  function setUser(user) {
    currentUser = user || null;
    updateAuthUI();
  }

  /**
   * Verifies the stored session against the API. An expired or revoked token
   * is discarded rather than left to fail every later request.
   */
  async function restoreSession() {
    if (!isCloudBackend || !getSessionToken()) {
      setUser(null);
      return null;
    }

    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, { headers: apiHeaders() });
      if (res.status === 401) {
        saveSession('');
        setUser(null);
        return null;
      }
      if (!res.ok) throw new Error('Session check failed');

      const data = await res.json();
      setUser(data.user);
      return data.user;
    } catch (err) {
      console.warn('Session restore failed:', err);
      setUser(null);
      return null;
    }
  }

  // =========================================================================
  // Owner Token Store
  // =========================================================================
  function getOwnerTokens() {
    try {
      const raw = localStorage.getItem(OWNER_TOKENS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function rememberOwnerToken(id, token) {
    if (!id || !token) return;
    const tokens = getOwnerTokens();
    tokens[String(id)] = token;
    try {
      localStorage.setItem(OWNER_TOKENS_KEY, JSON.stringify(tokens));
    } catch (e) {
      console.warn('Owner token storage failed:', e);
    }
  }

  function takeOwnerToken(id) {
    return getOwnerTokens()[String(id)] || '';
  }

  function forgetOwnerToken(id) {
    const tokens = getOwnerTokens();
    delete tokens[String(id)];
    try {
      localStorage.setItem(OWNER_TOKENS_KEY, JSON.stringify(tokens));
    } catch {
      /* non-fatal */
    }
  }

  // =========================================================================
  // Backend Connection & Health Check
  // =========================================================================
  async function checkBackendHealth() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${API_BASE}/`, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (res.ok) {
        isCloudBackend = true;
        backendStatus.className = 'status-pill status-live';
        backendStatus.querySelector('.status-text').textContent = 'Cloud Sync';
        backendStatus.title = `Connected to live API at ${API_BASE}`;
        return true;
      }

      // The API answered but is not ready: reachable, yet its database is
      // down. Falling back to local demo mode here would hide a real outage
      // behind a cheerful "Local Demo", and anything created would go only to
      // localStorage.
      if (res.status === 503) {
        isCloudBackend = false;
        backendStatus.className = 'status-pill status-warning';
        backendStatus.querySelector('.status-text').textContent = 'Service Degraded';
        backendStatus.title =
          'The Linkly API is reachable but reported its database as unavailable. ' +
          'Signing in and link creation will fail until it recovers.';
        return false;
      }
    } catch {
      // Backend not running or unreachable
    }

    isCloudBackend = false;
    backendStatus.className = 'status-pill status-local';
    backendStatus.querySelector('.status-text').textContent = 'Local Demo';
    backendStatus.title = 'Running in resilient offline mode with LocalStorage persistence';
    return false;
  }

  // =========================================================================
  // Data Fetching & Sync
  // =========================================================================
  async function loadLinks() {
    loadingEl.hidden = false;
    emptyState.hidden = true;
    noResultsState.hidden = true;

    if (isCloudBackend) {
      try {
        const res = await fetch(`${API_BASE}/api/links?limit=50`, {
          headers: apiHeaders()
        });

        // The list is per-account, so an anonymous visitor gets a 401. That
        // is expected, not an error: fall back to the locally stored links so
        // the dashboard still works before signing in.
        if (res.status === 401) {
          linksState = getLocalLinks();
        } else if (!res.ok) {
          throw new Error('API fetch failed');
        } else {
          const data = await res.json();
          linksState = Array.isArray(data) ? data : [];
        }
      } catch (err) {
        console.warn('Live API request failed, falling back to local:', err);
        linksState = getLocalLinks();
      }
    } else {
      linksState = getLocalLinks();
    }

    loadingEl.hidden = true;
    updateAnalytics();
    renderFilteredLinks();
  }

  // =========================================================================
  // Analytics Calculation
  // =========================================================================
  function updateAnalytics() {
    const total = linksState.length;
    const totalClicks = linksState.reduce((acc, l) => acc + (Number(l.clicks) || 0), 0);
    const topClicks = linksState.reduce((max, l) => Math.max(max, Number(l.clicks) || 0), 0);
    const avgClicks = total > 0 ? (totalClicks / total).toFixed(1) : '0.0';

    statTotalLinks.textContent = total.toLocaleString();
    statTotalClicks.textContent = totalClicks.toLocaleString();
    statTopClicks.textContent = topClicks.toLocaleString();
    statAvgClicks.textContent = avgClicks;
  }

  // =========================================================================
  // Link Rendering & Filtering
  // =========================================================================
  // Link cards are assembled with DOM APIs and textContent rather than an
  // innerHTML template. Nothing from the database is ever parsed as markup,
  // so an injected attribute cannot become executable even if escaping is
  // later refactored. The only innerHTML left is static icon markup we author.

  const PLACEHOLDER_ICON =
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' " +
    "viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2'><circle cx='12' cy='12' r='10'/></svg>";

  const svgIcon = (body) =>
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

  const COPY_ICON = svgIcon(
    '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>' +
      '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>'
  );

  const QR_ICON = svgIcon(
    '<rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect>' +
      '<rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect>'
  );

  const SHARE_ICON = svgIcon(
    '<circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle>' +
      '<circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>' +
      '<line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>'
  );

  const TRASH_ICON = svgIcon(
    '<path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>'
  );

  const CLOCK_ICON = svgIcon(
    '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>'
  );

  function iconButton(className, title, icon, dataset) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `action-icon-btn ${className}`;
    button.title = title;
    button.setAttribute('aria-label', title);

    for (const [key, value] of Object.entries(dataset)) {
      button.dataset[key] = value;
    }

    // Static, author-written markup only.
    button.innerHTML = icon;
    return button;
  }
  function getFilteredAndSortedLinks() {
    const query = searchInput.value.trim().toLowerCase();
    const sortVal = sortSelect.value;

    const filtered = linksState.filter(link => {
      if (!query) return true;
      const short = (link.shortUrl || '').toLowerCase();
      const code = (link.code || '').toLowerCase();
      const dest = (link.destinationUrl || '').toLowerCase();
      return short.includes(query) || code.includes(query) || dest.includes(query);
    });

    filtered.sort((a, b) => {
      if (sortVal === 'newest') {
        return new Date(b.createdAt) - new Date(a.createdAt);
      } else if (sortVal === 'oldest') {
        return new Date(a.createdAt) - new Date(b.createdAt);
      } else if (sortVal === 'clicks-desc') {
        return (Number(b.clicks) || 0) - (Number(a.clicks) || 0);
      } else if (sortVal === 'clicks-asc') {
        return (Number(a.clicks) || 0) - (Number(b.clicks) || 0);
      }
      return 0;
    });

    return filtered;
  }

  function renderFilteredLinks() {
    const filtered = getFilteredAndSortedLinks();
    linkListEl.innerHTML = '';

    linkCountEl.textContent = `${filtered.length} link${filtered.length === 1 ? '' : 's'}`;

    if (linksState.length === 0) {
      emptyState.hidden = false;
      noResultsState.hidden = true;
      return;
    }

    if (filtered.length === 0) {
      emptyState.hidden = true;
      noResultsState.hidden = false;
      return;
    }

    emptyState.hidden = true;
    noResultsState.hidden = true;

    for (const link of filtered) {
      const domain = extractDomain(link.destinationUrl);
      const faviconUrl = faviconUrlFor(domain);

      const card = document.createElement('article');
      card.className = 'link-card';
      card.dataset.id = link.id;

      const favicon = document.createElement('img');
      favicon.alt = '';
      favicon.loading = 'lazy';
      favicon.decoding = 'async';
      favicon.src = faviconUrl;
      // Swap in a neutral placeholder once, so a failing image cannot loop.
      favicon.dataset.fallback = '1';
      favicon.addEventListener(
        'error',
        () => {
          if (favicon.dataset.fallback !== '1') return;
          favicon.dataset.fallback = '0';
          favicon.src = PLACEHOLDER_ICON;
        },
        { once: true }
      );

      const faviconWrap = document.createElement('div');
      faviconWrap.className = 'link-favicon';
      faviconWrap.title = domain;
      faviconWrap.appendChild(favicon);

      const details = document.createElement('div');
      details.className = 'link-details';

      const urlRow = document.createElement('div');
      urlRow.className = 'link-url-row';

      const shortLink = document.createElement('a');
      shortLink.href = link.shortUrl;
      shortLink.target = '_blank';
      shortLink.rel = 'noopener noreferrer';
      shortLink.className = 'short-url-link';
      shortLink.dataset.trackClick = String(link.id);
      shortLink.textContent = link.shortUrl;
      urlRow.appendChild(shortLink);

      const original = document.createElement('span');
      original.className = 'original-url-text';
      original.title = link.destinationUrl;
      original.textContent = link.destinationUrl;

      const metaRow = document.createElement('div');
      metaRow.className = 'link-meta-row';

      const time = document.createElement('span');
      time.className = 'meta-time';
      time.innerHTML = CLOCK_ICON.replace('width="16" height="16"', 'width="12" height="12"');
      time.appendChild(document.createTextNode(formatRelativeTime(link.createdAt)));

      const dot = document.createElement('span');
      dot.textContent = '·';

      const domainText = document.createElement('span');
      domainText.textContent = domain;

      metaRow.append(time, dot, domainText);
      details.append(urlRow, original, metaRow);

      const main = document.createElement('div');
      main.className = 'link-card-main';
      main.append(faviconWrap, details);

      card.appendChild(main);

      // Click badge
      const badge = document.createElement('div');
      badge.className = 'link-clicks-badge';
      const badgeNum = document.createElement('strong');
      badgeNum.className = 'click-count-num';
      badgeNum.textContent = String(Number(link.clicks) || 0);
      const badgeLabel = document.createElement('span');
      badgeLabel.className = 'click-count-label';
      badgeLabel.textContent = 'Clicks';
      badge.append(badgeNum, badgeLabel);
      card.appendChild(badge);

      // Actions, built from data so no attribute interpolation is needed.
      const actions = document.createElement('div');
      actions.className = 'link-card-actions';
      actions.append(
        iconButton('copy-item-btn', 'Copy short link', COPY_ICON, { copy: link.shortUrl }),
        iconButton('qr-item-btn', 'View QR Code', QR_ICON, { qr: link.shortUrl }),
        iconButton('share-item-btn', 'Share link', SHARE_ICON, { share: link.shortUrl }),
        iconButton('delete-btn delete-item-btn', 'Delete link', TRASH_ICON, {
          deleteId: String(link.id),
          deleteUrl: link.shortUrl,
        })
      );
      card.appendChild(actions);

      linkListEl.appendChild(card);
    }

    attachCardListeners();
  }

  function attachCardListeners() {
    // Copy item
    linkListEl.querySelectorAll('.copy-item-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const text = btn.dataset.copy;
        const ok = await copyToClipboard(text);
        if (ok) {
          showToast('Copied link to clipboard!', 'success');
          btn.style.color = 'var(--success)';
          setTimeout(() => btn.style.color = '', 1000);
        } else {
          showToast('Failed to copy', 'error');
        }
      });
    });

    // QR Item
    linkListEl.querySelectorAll('.qr-item-btn').forEach(btn => {
      btn.addEventListener('click', () => openQrModal(btn.dataset.qr));
    });

    // Share Item
    linkListEl.querySelectorAll('.share-item-btn').forEach(btn => {
      btn.addEventListener('click', () => openShareModal(btn.dataset.share));
    });

    // Delete Item
    linkListEl.querySelectorAll('.delete-item-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        openDeleteModal(btn.dataset.deleteId, btn.dataset.deleteUrl);
      });
    });

    // Local Click Tracking for Demo Links
    linkListEl.querySelectorAll('[data-track-click]').forEach(linkEl => {
      linkEl.addEventListener('click', () => {
        const id = linkEl.dataset.trackClick;
        const item = linksState.find(l => String(l.id) === String(id));
        if (item) {
          item.clicks = (Number(item.clicks) || 0) + 1;
          if (!isCloudBackend) saveLocalLinks(linksState);
          updateAnalytics();
          const countEl = linkEl.closest('.link-card')?.querySelector('.click-count-num');
          if (countEl) countEl.textContent = item.clicks;
        }
      });
    });
  }

  // =========================================================================
  // Form Submission & Link Creation
  // =========================================================================
  function setSubmitting(isSubmitting) {
    shortenBtn.disabled = isSubmitting;
    shortenBtn.classList.toggle('loading', isSubmitting);
    urlInput.disabled = isSubmitting;
    if (customAliasInput) customAliasInput.disabled = isSubmitting;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    resultBox.hidden = true;

    const destUrl = urlInput.value.trim();
    const alias = customAliasInput ? customAliasInput.value.trim() : '';

    if (!destUrl) {
      showError('Please enter a URL to shorten.');
      urlInput.focus();
      return;
    }

    if (destUrl.length > MAX_URL_LENGTH) {
      showError(`URL exceeds the maximum length of ${MAX_URL_LENGTH} characters.`);
      return;
    }

    if (!isValidUrl(destUrl)) {
      showError('Please enter a valid URL including http:// or https://');
      urlInput.focus();
      return;
    }

    if (alias && !/^[a-zA-Z0-9_-]{3,30}$/.test(alias)) {
      showError('Custom alias must be 3-30 characters (letters, numbers, hyphens, underscores).');
      if (customAliasInput) customAliasInput.focus();
      return;
    }

    setSubmitting(true);

    try {
      let createdLink = null;

      if (isCloudBackend) {
        const res = await fetch(`${API_BASE}/api/links`, {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ destinationUrl: destUrl, customAlias: alias || undefined })
        });

        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error || 'Failed to shorten URL on server');
        createdLink = data;

        // Stash the delete secret now: this is the only chance we get it.
        if (data && data.ownerToken) {
          rememberOwnerToken(data.id, data.ownerToken);
        }
      } else {
        // Local Mode creation
        const code = alias || generateLocalCode();
        const shortUrl = `${window.location.origin.replace(/\/$/, '')}/${code}`;
        createdLink = {
          id: 'loc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
          code: code,
          shortUrl: shortUrl,
          destinationUrl: destUrl,
          clicks: 0,
          createdAt: new Date().toISOString()
        };

        const localList = getLocalLinks();
        localList.unshift(createdLink);
        saveLocalLinks(localList);
        linksState = localList;
      }

      // Display active result
      activeQrUrl = createdLink.shortUrl;
      shortLinkEl.textContent = createdLink.shortUrl;
      // In cloud mode "Visit" exercises the real short link (and its click
      // counter). Local demo links have no server behind them, so there the
      // destination itself is the only meaningful target.
      visitResultBtn.href = isCloudBackend
        ? createdLink.shortUrl
        : createdLink.destinationUrl;
      resultBox.hidden = false;

      // Clear input
      urlInput.value = '';
      if (customAliasInput) customAliasInput.value = '';
      if (aliasDrawer) aliasDrawer.hidden = true;
      toggleAliasBtn.classList.remove('open');

      // Account links are owned by the session and need no guest token.
      if (isCloudBackend && !currentUser && !createdLink.ownerToken) {
        showToast('Link created, but you will not be able to delete it without signing in.', 'info');
      }

      showToast('Short link generated successfully!', 'success');
      await loadLinks();
    } catch (err) {
      showError(err.message || 'An error occurred while shortening the link.');
    } finally {
      setSubmitting(false);
    }
  });

  // =========================================================================
  // Result Box Actions
  // =========================================================================
  copyResultBtn.addEventListener('click', async () => {
    const text = shortLinkEl.textContent;
    const ok = await copyToClipboard(text);
    if (ok) {
      copyResultBtn.classList.add('copied');
      copyResultBtn.querySelector('.copy-text').textContent = 'Copied!';
      showToast('Copied short link to clipboard!', 'success');
      setTimeout(() => {
        copyResultBtn.classList.remove('copied');
        copyResultBtn.querySelector('.copy-text').textContent = 'Copy';
      }, 2200);
    } else {
      showToast('Failed to copy', 'error');
    }
  });

  qrResultBtn.addEventListener('click', () => {
    if (activeQrUrl) openQrModal(activeQrUrl);
  });

  shareResultBtn.addEventListener('click', () => {
    if (activeQrUrl) openShareModal(activeQrUrl);
  });

  pasteBtn.addEventListener('click', async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text) {
          urlInput.value = text.trim();
          showError('');
          urlInput.focus();
          showToast('Pasted from clipboard!', 'info');
          return;
        }
      }
    } catch {
      // Permission denied or unsecure context
    }
    urlInput.focus();
  });

  toggleAliasBtn.addEventListener('click', () => {
    const isHidden = aliasDrawer.hidden;
    aliasDrawer.hidden = !isHidden;
    toggleAliasBtn.classList.toggle('open', !aliasDrawer.hidden);
    if (!aliasDrawer.hidden) customAliasInput.focus();
  });

  // =========================================================================
  // Search & Filter Controls
  // =========================================================================
  searchInput.addEventListener('input', () => {
    clearSearchBtn.hidden = !searchInput.value;
    renderFilteredLinks();
  });

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearSearchBtn.hidden = true;
    renderFilteredLinks();
    searchInput.focus();
  });

  resetSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearSearchBtn.hidden = true;
    renderFilteredLinks();
  });

  sortSelect.addEventListener('change', () => {
    renderFilteredLinks();
  });

  // =========================================================================
  // Export Functions
  // =========================================================================
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    exportMenu.hidden = !exportMenu.hidden;
  });

  document.addEventListener('click', () => {
    if (!exportMenu.hidden) exportMenu.hidden = true;
  });

  exportCsvBtn.addEventListener('click', () => {
    if (linksState.length === 0) {
      showToast('No links to export', 'error');
      return;
    }

    const headers = ['ID', 'Short Code', 'Short URL', 'Destination URL', 'Clicks', 'Created At'];
    const rows = linksState.map(l => [
      csvCell(l.id),
      csvCell(l.code),
      csvCell(l.shortUrl),
      csvCell(l.destinationUrl),
      Number(l.clicks) || 0,
      csvCell(l.createdAt)
    ]);

    // A Blob keeps the payload out of the URL, which encodeURI-based data
    // URIs cannot handle safely once a value contains "#" or a newline.
    downloadBlob(
      new Blob([[headers.join(','), ...rows.map(r => r.join(','))].join('\n')], {
        type: 'text/csv;charset=utf-8',
      }),
      `linkly_export_${new Date().toISOString().slice(0, 10)}.csv`
    );
    showToast('Exported CSV file!', 'success');
  });

  /** Quotes a CSV field and neutralises leading = + - @ (formula injection). */
  function csvCell(value) {
    const safe = escapeCsvValue(value === null || value === undefined ? '' : String(value));
    return `"${safe.replace(/"/g, '""')}"`;
  }

  function downloadBlob(blob, filename) {
    const href = URL.createObjectURL(blob);
    triggerDownload(href, filename);

    // Revoking in the same task can cancel the download in Firefox and Safari:
    // the navigation has been queued but not started. Give it a tick first.
    setTimeout(() => URL.revokeObjectURL(href), 0);
  }

  /** Clicks a download link. Kept separate so revocation timing lives in one place. */
  function triggerDownload(href, filename) {
    const link = document.createElement('a');
    link.href = href;
    link.download = filename;
    // Firefox historically ignored clicks on anchors outside the document.
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  exportJsonBtn.addEventListener('click', () => {
    if (linksState.length === 0) {
      showToast('No links to export', 'error');
      return;
    }

    downloadBlob(
      new Blob([JSON.stringify(linksState, null, 2)], { type: 'application/json' }),
      `linkly_export_${new Date().toISOString().slice(0, 10)}.json`
    );
    showToast('Exported JSON file!', 'success');
  });

  // =========================================================================
  // Modals Implementation
  // =========================================================================
  function openQrModal(url) {
    try {
      // Remember what is on screen: the download buttons name the file after
      // it, and a card's QR button can be for a link that is not the most
      // recently created one.
      activeQrUrl = url;

      const result = QRCode.toMatrix(url, { ecLevel: 'M' });
      QRCode.renderToCanvas(qrCanvas, url, { size: 220, ecLevel: 'M' });

      qrModalUrl.textContent = url;
      if (qrMeta) {
        qrMeta.textContent = `Version ${result.version} · Level ${result.level} · Mask ${result.mask}`;
      }
      openModal(qrModal);
    } catch (err) {
      showToast(err.message || 'Could not generate a QR code for that link', 'error');
    }
  }

  function qrFilename(ext) {
    let slug = 'linkly-qr';
    try {
      const code = new URL(activeQrUrl).pathname.split('/').filter(Boolean).pop();
      if (code) slug = `linkly-${code}`;
    } catch {
      /* fall back to the generic name */
    }
    return `${slug}.${ext}`;
  }

  closeQrModal.addEventListener('click', () => closeModal(qrModal));
  downloadQrBtn.addEventListener('click', () => {
    triggerDownload(qrCanvas.toDataURL('image/png'), qrFilename('png'));
    showToast('QR Code image downloaded!', 'success');
  });

  if (downloadQrSvgBtn) {
    downloadQrSvgBtn.addEventListener('click', () => {
      if (!activeQrUrl) return;

      downloadBlob(
        new Blob([QRCode.toSvg(activeQrUrl, { ecLevel: 'M' })], {
          type: 'image/svg+xml;charset=utf-8',
        }),
        qrFilename('svg')
      );

      showToast('QR Code SVG downloaded!', 'success');
    });
  }

  function openShareModal(url) {
    shareModalUrlInput.value = url;
    openModal(shareModal);

    const encodedUrl = encodeURIComponent(url);
    const encodedText = encodeURIComponent('Check out this link:');

    shareXBtn.onclick = () => {
      window.open(`https://twitter.com/intent/tweet?text=${encodedText}&url=${encodedUrl}`, '_blank', 'noopener,noreferrer');
    };

    shareWaBtn.onclick = () => {
      window.open(`https://api.whatsapp.com/send?text=${encodedText}%20${encodedUrl}`, '_blank', 'noopener,noreferrer');
    };

    shareInBtn.onclick = () => {
      window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`, '_blank', 'noopener,noreferrer');
    };

    shareTgBtn.onclick = () => {
      window.open(`https://t.me/share/url?url=${encodedUrl}&text=${encodedText}`, '_blank', 'noopener,noreferrer');
    };
  }

  closeShareModal.addEventListener('click', () => closeModal(shareModal));
  shareModalCopyBtn.addEventListener('click', async () => {
    const ok = await copyToClipboard(shareModalUrlInput.value);
    if (ok) showToast('Link copied!', 'success');
  });

  function openDeleteModal(id, url) {
    currentDeleteId = id;
    deleteModalTarget.textContent = url;
    openModal(deleteModal);
  }

  closeDeleteModal.addEventListener('click', () => closeModal(deleteModal));
  cancelDeleteBtn.addEventListener('click', () => closeModal(deleteModal));

  confirmDeleteBtn.addEventListener('click', async () => {
    if (!currentDeleteId) return;
    const id = currentDeleteId;
    closeModal(deleteModal);

    try {
      if (isCloudBackend) {
        const ownerToken = takeOwnerToken(id);

        const res = await fetch(`${API_BASE}/api/links/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: apiHeaders(ownerToken ? { 'x-owner-token': ownerToken } : null)
        });

        if (res.status === 403) {
          const body = await res.json().catch(() => null);
          throw new Error(
            body?.error ||
              'This link can only be deleted by the browser that created it.'
          );
        }
        if (res.status === 404) {
          throw new Error('That link no longer exists');
        }
        if (!res.ok) {
          throw new Error('Failed to delete on server');
        }

        forgetOwnerToken(id);
      } else {
        const updated = linksState.filter(l => String(l.id) !== String(id));
        saveLocalLinks(updated);
        linksState = updated;
      }

      showToast('Link deleted', 'info');
      await loadLinks();
    } catch (err) {
      showToast(err.message || 'Failed to delete link', 'error');
    }
  });

  // =========================================================================
  // Accounts: Sign in / Register / Sign out
  // =========================================================================
  let authMode = 'signin';

  function setAuthMode(mode) {
    authMode = mode;

    const isRegister = mode === 'register';
    authTabSignIn.classList.toggle('active', !isRegister);
    authTabRegister.classList.toggle('active', isRegister);
    authTabSignIn.setAttribute('aria-selected', String(!isRegister));
    authTabRegister.setAttribute('aria-selected', String(isRegister));

    authSubmitLabel.textContent = isRegister ? 'Create account' : 'Sign in';
    authPassword.setAttribute('autocomplete', isRegister ? 'new-password' : 'current-password');
    authHint.textContent = isRegister
      ? 'Password must be at least 8 characters.'
      : 'Your links follow you across browsers and devices.';
  }

  function showAuthError(message) {
    if (!message) {
      authError.hidden = true;
      return;
    }
    authErrorMessage.textContent = message;
    authError.hidden = false;
  }

  /**
   * Switches the auth dialog between the credential form and the reset form.
   * Only one is ever visible, so the dialog height stays stable.
   */
  function setResetMode(isReset) {
    // A signed-in user has no business on the reset step.
    const showReset = isReset && !currentUser;

    authForm.hidden = showReset;
    resetForm.hidden = !showReset;
    authSignOut.hidden = !currentUser;
    if (authTabs) authTabs.hidden = showReset;
  }

  function showResetError(message) {
    if (!message) {
      resetError.hidden = true;
      return;
    }
    resetErrorMessage.textContent = message;
    resetError.hidden = false;
  }

  function updateAuthUI() {
    const signedIn = Boolean(currentUser);
    const unverified = signedIn && currentUser.emailVerified === false;

    // Keep the auth dialog consistent with the current session. This also
    // collapses the reset step, which is only ever shown on demand.
    setResetMode(false);

    // Unverified addresses are not blocked from using the product; this is
    // informational, with a way to re-send the mail.
    if (verifyBanner) {
      verifyBanner.hidden = !unverified;
      if (unverified) {
        verifyBannerText.textContent = `${currentUser.email} is not confirmed yet.`;
      }
    }

    authTriggerLabel.textContent = signedIn ? currentUser.email : 'Sign in';
    authTrigger.title = signedIn ? `Signed in as ${currentUser.email}` : 'Sign in to sync your links';

    authEmailLabel.textContent = signedIn ? currentUser.email : '';

    // The account dialog only makes sense with a reachable backend.
    authArea.hidden = !isCloudBackend;
  }

  /**
   * @param {{step?: 'signin'|'reset', force?: boolean}} [options]
   *   `step: 'reset'` opens directly on the token step, which is what an
   *   emailed link needs.
   */
  function openAuthModal(options = {}) {
    if (!isCloudBackend && !options.force) {
      showToast('Accounts need the Linkly backend running', 'error');
      return;
    }

    setAuthMode('signin');
    showAuthError('');
    showResetError('');
    authEmail.value = '';
    authPassword.value = '';
    resetToken.value = '';
    resetPassword.value = '';

    const wantReset = options.step === 'reset' && !currentUser;
    setResetMode(wantReset);

    authSignOut.hidden = !currentUser;

    openModal(authModal);
    (currentUser ? authSignOut : wantReset ? resetToken : authEmail).focus();
  }

  authTrigger.addEventListener('click', openAuthModal);
  closeAuthModal.addEventListener('click', () => closeModal(authModal));
  authTabSignIn.addEventListener('click', () => setAuthMode('signin'));
  authTabRegister.addEventListener('click', () => setAuthMode('register'));

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    showAuthError('');

    const email = authEmail.value.trim();
    const password = authPassword.value;

    if (!email || !password) {
      showAuthError('Enter your email and password.');
      return;
    }

    authSubmit.classList.add('loading');
    authSubmit.disabled = true;

    try {
      const res = await fetch(`${API_BASE}/api/auth/${authMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        showAuthError(data?.error || (authMode === 'register' ? 'Could not create account' : 'Could not sign in'));
        return;
      }

      saveSession(data.token);
      setUser(data.user);
      closeModal(authModal);

      showToast(authMode === 'register' ? 'Account created!' : `Welcome back, ${data.user.email}`, 'success');

      // Pull the account's links, which replace the local demo set.
      await loadLinks();
    } catch (err) {
      showAuthError(err.message || 'Network error, please try again');
    } finally {
      authSubmit.classList.remove('loading');
      authSubmit.disabled = false;
    }
  });

  // --- password reset ---------------------------------------------------

  /**
   * The backend answers identically for known and unknown addresses, so the
   * UI must too. Only report the transport outcome, never whether the account
   * exists.
   */
  authForgotBtn.addEventListener('click', async () => {
    const email = authEmail.value.trim();

    if (!email) {
      showAuthError('Enter your email address first.');
      return;
    }

    authForgotBtn.disabled = true;

    try {
      const res = await fetch(`${API_BASE}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        showAuthError(data?.error || 'Could not start the reset');
        return;
      }

      // Move to the token step without implying anything about the account.
      setResetMode(true);
      resetToken.value = '';
      resetPassword.value = '';
      resetHint.textContent = data.message || 'If that address has an account, a reset link is on its way.';
      showResetError('');
      resetToken.focus();
    } catch (err) {
      showAuthError(err.message || 'Network error, please try again');
    } finally {
      authForgotBtn.disabled = false;
    }
  });

  resetBackBtn.addEventListener('click', () => {
    setResetMode(false);
    showResetError('');
  });

  resetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    showResetError('');

    const token = resetToken.value.trim();
    const password = resetPassword.value;

    if (!token || !password) {
      showResetError('Enter both the reset token and a new password.');
      return;
    }

    resetSubmit.classList.add('loading');
    resetSubmit.disabled = true;

    try {
      const res = await fetch(`${API_BASE}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ token, password })
      });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        showResetError(data?.error || 'Could not reset the password');
        return;
      }

      closeModal(authModal);
      setResetMode(false);
      setAuthMode('signin');
      authPassword.value = '';

      // Every session was revoked server-side, so drop the local one.
      saveSession('');
      setUser(null);

      showToast(data.message || 'Password updated, please sign in.', 'success');
      await loadLinks();
    } catch (err) {
      showResetError(err.message || 'Network error, please try again');
    } finally {
      resetSubmit.classList.remove('loading');
      resetSubmit.disabled = false;
    }
  });

  if (verifyResendBtn) {
    verifyResendBtn.addEventListener('click', async () => {
      verifyResendBtn.disabled = true;
      try {
        const res = await fetch(`${API_BASE}/api/auth/resend-verification`, {
          method: 'POST',
          headers: apiHeaders()
        });
        const data = await res.json().catch(() => null);

        if (!res.ok) {
          showToast(data?.error || 'Could not send the verification email', 'error');
          return;
        }

        showToast(data.message || 'Verification email sent.', 'success');
      } catch (err) {
        showToast(err.message || 'Network error, please try again', 'error');
      } finally {
        verifyResendBtn.disabled = false;
      }
    });
  }

  authSignOut.addEventListener('click', async () => {
    try {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: 'POST',
        headers: apiHeaders()
      });
    } catch (err) {
      console.warn('Logout request failed, clearing local session anyway:', err);
    }

    saveSession('');
    setUser(null);
    closeModal(authModal);

    showToast('Signed out', 'info');
    await loadLinks();
  });

  // =========================================================================
  // Focus & Modal Accessibility
  // =========================================================================
  const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const MODALS = [qrModal, shareModal, deleteModal, authModal];

  let previouslyFocused = null;

  function focusableWithin(modal) {
    // offsetParent is null for position:fixed subtrees and for anything
    // inside a [hidden] ancestor, so getClientRects() is the reliable check.
    return Array.from(modal.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
      (node) => node.getClientRects().length > 0
    );
  }

  function openModal(modal) {
    previouslyFocused = document.activeElement;
    modal.hidden = false;
    const targets = focusableWithin(modal);
    if (targets.length > 0) {
      targets[0].focus();
    } else {
      // Fall back to the dialog itself so focus never escapes to the page
      // behind the backdrop.
      modal.setAttribute('tabindex', '-1');
      modal.focus();
    }
  }

  function closeModal(modal) {
    if (modal.hidden) return;
    modal.hidden = true;
    previouslyFocused?.focus?.();
  }

  function closeAllModals() {
    MODALS.forEach((modal) => closeModal(modal));
  }

  // Close modals on clicking backdrop
  MODALS.forEach((modal) => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal(modal);
    });
  });

  // =========================================================================
  // Keyboard Shortcuts & Navigation
  // =========================================================================
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllModals();
      if (!exportMenu.hidden) exportMenu.hidden = true;
    } else if (e.key === '/' && document.activeElement !== urlInput && document.activeElement !== searchInput) {
      e.preventDefault();
      urlInput.focus();
      urlInput.select();
    }
  });

  // Trap Tab inside whichever modal is open.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;

    const open = MODALS.find((modal) => !modal.hidden);
    if (!open) return;

    const targets = focusableWithin(open);
    if (targets.length === 0) return;

    const first = targets[0];
    const last = targets[targets.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  function applyTheme(theme) {
    document.body.classList.toggle('dark', theme === 'dark');
    themeBtn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    themeBtn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Best effort: private-mode storage failures must not break the toggle.
    }
  }

  themeBtn.addEventListener('click', () => {
    const isDark = document.body.classList.contains('dark');
    applyTheme(isDark ? 'light' : 'dark');
  });

  const savedTheme = (function () {
    try { return localStorage.getItem(THEME_STORAGE_KEY); } catch { return null; }
  })();
  const systemPrefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  // Previously this was `(systemPrefersDark ? 'dark' : 'dark')`, which made
  // the check pointless and ignored the OS preference entirely.
  applyTheme(savedTheme || (systemPrefersDark ? 'dark' : 'light'));

  // =========================================================================
  // Hash Routes (emailed action links)
  // =========================================================================
  // Emails point at `#reset-password?token=...` and `#verify-email?token=...`
  // rather than a path: the API's /:code catch-all would otherwise answer a
  // path link with "Short link not found", and a hash keeps the token out of
  // request lines, access logs and Referer headers entirely.

  function readHashAction() {
    const hash = window.location.hash.replace(/^#\/?/, '');
    if (!hash) return null;

    const queryIndex = hash.indexOf('?');
    const route = queryIndex === -1 ? hash : hash.slice(0, queryIndex);
    const query = queryIndex === -1 ? '' : hash.slice(queryIndex + 1);

    return { route, params: new URLSearchParams(query) };
  }

  /**
   * Clears the hash without adding a history entry, so a reload does not
   * resubmit a spent token, and the Back button leaves the reset flow.
   */
  function clearHashAction() {
    if (window.location.hash) {
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search
      );
    }
  }

  async function handleHashAction(action) {
    const { route, params } = action;
    const token = params.get('token') || '';

    if (route === 'reset-password') {
      if (!token) {
        showToast('That reset link is missing its token.', 'error');
        clearHashAction();
        return;
      }

      // `force` because the health check may not have settled, or may have
      // failed while the emailed link was still opened. Submitting the form
      // will surface a real network error if the API is genuinely down.
      openAuthModal({ step: 'reset', force: true });

      if (resetForm.hidden) {
        // openAuthModal declined (a session is already active).
        clearHashAction();
        return;
      }

      resetToken.value = token;
      resetPassword.value = '';
      resetHint.textContent =
        'Choose a new password. The token from your email is already filled in.';
      showResetError('');
      resetPassword.focus();
      clearHashAction();
      return;
    }

    if (route === 'verify-email') {
      clearHashAction();

      if (!token) {
        showToast('That verification link is missing its token.', 'error');
        return;
      }

      showToast('Confirming your email address...', 'info');

      try {
        const res = await fetch(`${API_BASE}/api/auth/verify-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ token })
        });
        const data = await res.json().catch(() => null);

        if (!res.ok) {
          showToast(data?.error || 'That verification link is invalid or expired', 'error');
          return;
        }

        showToast('Email confirmed.', 'success');

        // Reflect the new state if this browser owns that account.
        await restoreSession();
        await loadLinks();
      } catch (err) {
        showToast(err.message || 'Network error, please try again', 'error');
      }
    }
  }

  // =========================================================================
  // Source Link
  // =========================================================================
  function applyRepoLink() {
    const link = document.getElementById('githubLink');
    if (!link) return;

    // Only show the button when a repository is actually configured, so the
    // page never points at an unrelated project.
    if (!REPO_URL || !/^https?:\/\//i.test(REPO_URL)) {
      link.hidden = true;
      return;
    }

    link.href = REPO_URL;
    link.hidden = false;
  }

  applyRepoLink();

  // =========================================================================
  // Initialization
  // =========================================================================
  async function init() {
    applyRepoLink();
    await checkBackendHealth();
    await restoreSession();

    // Emailed action links run *after* session restore: restoreSession() calls
    // setUser(), which re-renders the auth dialog and would collapse the
    // reset step if it had already been opened.
    const action = readHashAction();
    if (action && (action.route === 'reset-password' || action.route === 'verify-email')) {
      await handleHashAction(action);
    }

    await loadLinks();
  }

  init();
})();
