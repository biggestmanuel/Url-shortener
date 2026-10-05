Linkly — Next-Gen URL Shortener & Link Management
A URL shortener and link analytics platform built with vanilla HTML5, CSS3, JavaScript (ES6+), Express, and PostgreSQL/Neon. No build step, no frontend framework, no runtime dependencies in the browser.

> **Working on this repo?** Read [`AGENTS.md`](./AGENTS.md) first. It records the mistakes that have
> actually been made here — an SSRF hole in the favicon proxy, a rate-limit bypass from
> `Boolean('false')`, an XSS from an escaper that forgot quotes, a token race — plus the traps in
> this stack (PowerShell mangling inline JSON, jsdom needing an `http://` origin, Windows never
> delivering signals to Node). Most of it is also enforced by tests in
> `backend/test/invariants.guard.test.js`, so a regression fails the suite instead of shipping.

## ✨ Features

- **Accounts & sessions** — email/password sign-up, scrypt-hashed passwords, revocable bearer sessions. Links belong to an account and follow you across browsers.
- **Password reset & email verification** — single-use, time-limited tokens; a reset rotates the password and revokes every existing session. Emailed links are hash routes (`#reset-password?token=...`), so the token never reaches a request line, access log, or `Referer` header. `register`, `login` and `/api/auth/me` all report the same `emailVerified` state, so the "confirm your address" banner survives a reload.
- **Guest links still work** — no account needed to shorten or share. Anonymous creators receive a one-time delete token.
- **Modern SaaS UI** — glassmorphism navigation, ambient mesh glow, smooth card transitions, dark/light theme that follows your OS preference.
- **Zero build step** — open `index.html` and it runs. The entire browser payload is `index.html` + `styles.css` + `escape.js` + `qr.js` + `app.js`.
- **Hybrid offline/cloud resilience** — health-checks the API on boot and falls back to a full LocalStorage demo mode when the backend is unreachable.
- **QR codes, written from scratch** — a spec-compliant ISO/IEC 18004 encoder (versions 1–10, all four EC levels) with PNG and SVG export. See [QR encoder](#qr-encoder).
- **Real-time analytics** — total links, total clicks, top performer, average clicks per link.
- **Live search & multi-criteria sorting** — by domain, URL, or short code; sort by newest, oldest, most clicks, or fewest.
- **Favicons served by your own backend**, so the set of destination domains a visitor browses never reaches a third-party icon service.
- **CSV/JSON export**, **custom link aliases**, and **social sharing** to X, WhatsApp, LinkedIn, and Telegram.
- **Accessible modals** — `role="dialog"`, `aria-modal`, labelled titles, focus trapping, and focus restoration on close.
- **Keyboard shortcuts** — `/` focuses the input, `Esc` closes any modal.

## 🚀 Quick start

### 1. Frontend only (local demo mode)

Open `index.html` in a browser. With no backend running, Linkly operates entirely in **Local Demo Mode** with full local persistence, click simulation, QR generation, search, and export. Accounts require the backend, so the sign-in button hides itself when offline.

### 2. With the live backend

```bash
npm run setup                       # installs root tooling + backend deps
cp backend/.env.example backend/.env
# edit backend/.env and set DATABASE_URL (a Neon Postgres connection string)
npm --prefix backend run db:migrate # applies the schema (idempotent)
npm run doctor                      # checks config + database before you start
npm run dev                         # API on http://localhost:3001
```

Open `index.html`. The status pill switches from **Local Demo** to **Cloud Sync**.

`npm run doctor` is the step worth not skipping — see [Deployment settings](#deployment-settings).

### 3. Pointing at a hosted backend

Settings live in `localStorage`, so an operator key never lands in a file that gets served to every visitor. Set them from the browser console, or right-click → Inspect → Application → Local Storage:

```js
localStorage.setItem('linkly.apiBase', 'https://your-backend.example.com');
localStorage.setItem('linkly.repoUrl', 'https://github.com/you/linkly');
// Only for a REQUIRE_API_KEY_TO_CREATE backend:
localStorage.setItem('linkly.apiKey', 'your-operator-key');
```

The "View Source" GitHub button stays hidden until `linkly.repoUrl` is set, so the page never points at an unrelated repository. A `window.LINKLY_*` global still takes precedence, if a deployment prefers to inject defaults from its own markup.

## 🔐 Security model

### Ownership

A link is deletable only by the principal that created it, checked in this order:

1. **Operator `API_KEY`** — master key, overrides everything.
2. **Account session** — `Bearer` token matching the row's `user_id`.
3. **Guest owner token** — a 256-bit secret returned once at creation.

`GET /api/links` returns **only your links**. Ids can't be walked to enumerate or delete other people's links; unauthenticated listing is a `401`, and the frontend quietly falls back to local demo links in that case.

### Credentials

- **Passwords** use `scrypt` (N=16384, r=8, p=1) with a per-password random salt. Length is bounded at 200 characters, since scrypt is deliberately slow and unbounded input is a cheap DoS.
- **Sessions** are 256-bit random tokens, but only their **SHA-256 digest** is stored — a database dump cannot be replayed as live sessions. Sessions expire after 30 days, are revoked on logout, and expired rows are swept hourly so the table stays bounded.
- All secret comparisons use `crypto.timingSafeEqual`.
- **Login does not reveal whether an email exists** — the same scrypt verification runs either way, so response time and error text are identical. `forgot-password` behaves the same way and returns an identical body for known and unknown addresses.
- **Reset and verification tokens are single-use and stored only as digests.** A successful reset re-salts the password and **revokes every session** for that account, since a reset is the remedy for a compromised account. Requesting a new token invalidates any outstanding one.
- **Single-use is enforced by one statement, not two.** Each token is spent by a conditional `UPDATE ... WHERE used_at IS NULL RETURNING`. A `SELECT` followed by a separate `UPDATE` would let two requests carrying the same token both pass the "is it still unused?" check, and both would succeed — which is exactly the race an attacker would try.

### Email

Password resets and address verification go out over SMTP when `SMTP_HOST` is configured. Without it, the message body — including the token — is written to the server log instead, so a self-hosted instance stays usable and resets remain reachable. The token is never returned by the API either way. Install the optional transport with `npm --prefix backend install nodemailer`.

### Output and export safety

Link cards are assembled with **DOM APIs and `textContent`**, never by interpolating database values into an HTML string. Nothing from the database is ever parsed as markup, so attribute injection cannot become executable even if the escaping layer is later refactored. The only `innerHTML` in the render path is static icon markup authored in the source.

- **Output is still escaped** where it is genuinely needed. `escape.js` escapes `& < > " '` — quotes included, because destination URLs are user input and appear in `title="..."` attributes. (An earlier version escaped only angle brackets, which allowed a stored-XSS; there's a regression test.)
- **CSV exports neutralise formula injection**, so a URL like `=cmd|...` cannot execute when opened in Excel or Sheets.
- **Short codes are random base62**, not an encoding of the row id, so they're not enumerable.
- **Redirects are sent `Cache-Control: no-store`**, so a shared cache can't serve one visitor's redirect to another.
- **Baseline security headers on every response**, including error and redirect paths: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`, and HSTS. `X-Powered-By` is disabled. No HTML is ever served, so the full helmet set would be mostly no-ops — these are written out directly instead of taking a dependency.

### Favicon proxy

`GET /api/favicon?domain=example.com` resolves icons server-side with a 24-hour, size-bounded in-memory cache. Each miss is an outbound request made on behalf of whoever supplied the domain, so:

- The handler rejects anything that isn't a bare public hostname **before** constructing a URL.
- **Private, loopback, link-local and reserved addresses are refused** — including the `169.254.169.254` cloud metadata endpoint — and so are the shorthand notations resolvers accept (`127.1`, `0177.0.0.1`, `0x7f000001`). Without this the endpoint was an open SSRF proxy into your own network.
- Responses whose content type isn't `image/*` are discarded, bodies are capped at 128 KB, and a result whose final URL landed on a different host is rejected.
- The cache is bounded, so attacker-supplied keys cannot exhaust memory.
- The endpoint is rate limited per IP and per domain.

### Rate limiting

Per client IP: creation (30 / 10 min), redirects (1200 / min), authentication (20 / 15 min, successful requests not counted), favicon lookups (120 / min). Raise limits behind a reverse proxy with `TRUST_PROXY=true`. Only `1`/`true`/`yes`/`on` count as true, so the shipped `TRUST_PROXY=false` genuinely leaves proxy trust off — otherwise a client could spoof `X-Forwarded-For` and walk straight past every limit below.

### Deployment settings

Run this before deploying, and again after any `.env` change:

```bash
npm run doctor                     # report, exit 0
npm --prefix backend run doctor:strict   # exit 1 if anything is wrong
npm --prefix backend run doctor -- --strict --allow-localhost
```

`doctor` reports the settings that **fail silently** — the server starts, reports healthy, and hands
out links nobody can open — then confirms the database is reachable and carries every table and
column the running code expects. It never prints your connection string or any secret; when the
database is unreachable it reports the Postgres error *code* only.

| Exit | Meaning |
| --- | --- |
| `0` | No problems, or not run with `--strict`. |
| `1` | Configuration problems, under `--strict`. |
| `2` | The database is unreachable or the schema is incomplete. |

It also runs in CI, so a broken schema is caught on the pull request rather than in production.

#### The settings that matter most

| Variable | Purpose |
| --- | --- |
| `PUBLIC_BASE_URL` | **The origin every short link is built from.** Unset or left at `localhost` and every link you hand out points at your own machine — nothing errors. Start here. |
| `API_KEY` | Operator master key. Also the API-level way to delete pre-account links — but see [admin tooling](#admin-tooling) for the safer path. |
| `CORS_ORIGINS` | Comma-separated allowed origins. Empty reflects any origin, which demo/`file://` mode needs. Set it when deploying. |
| `TRUST_PROXY` | `true` behind a reverse proxy, or every request shares one rate-limit bucket. |
| `FRONTEND_BASE_URL` | Where the frontend is served, used to build emailed links. Defaults to `PUBLIC_BASE_URL`. Set it when they differ. |
| `SMTP_HOST` | SMTP server for reset/verification mail. Unset logs messages instead. |
| `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Standard SMTP settings. |
| `RESET_TOKEN_TTL_MINUTES` | Password reset lifetime (default 60). |
| `VERIFY_TOKEN_TTL_MINUTES` | Verification link lifetime (default 1440). |
| `SESSION_TTL_DAYS` | Session lifetime (default 30). |
| `SESSION_SWEEP_MINUTES` | Expired-session sweep interval (default 60). `0` genuinely disables. |
| `FAVICON_RATE_MAX` | Favicon lookups per IP per minute (default 120). |
| `REQUIRE_API_KEY_TO_CREATE` | `true` to gate creation. Note the key must then reach the browser — see below. |
| `NODE_ENV` | `production` makes misconfiguration **fatal** rather than advisory — see below. Leave unset locally. |
| `ALLOW_LOOPBACK_BASE_URL` | `true` waives the production loopback check for a genuine private-network deployment. |

#### Production refuses to start rather than serve broken links

With `NODE_ENV=production`, the server exits `1` before binding a port if `PUBLIC_BASE_URL` is unset
or loopback, or if `CORS_ORIGINS` contains `*`. A warning in a log nobody reads is not enough when
the failure mode is "every short link points at localhost and nobody notices for a week".

```
Refusing to start: NODE_ENV=production and the deployment is not usable.

  PUBLIC_BASE_URL is "http://localhost:3001", which is only reachable from this machine.
  Every generated short link would point at localhost.

Set a real PUBLIC_BASE_URL (and CORS_ORIGINS), or unset NODE_ENV to run in development mode.
If this really is a production deployment on a private network, set ALLOW_LOOPBACK_BASE_URL=true.
```

Leave `NODE_ENV` unset while developing: localhost is a legitimate choice there, so the checks stay
advisory.

Generate a key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

⚠️ **On `REQUIRE_API_KEY_TO_CREATE`:** any key shipped to the browser is readable by every visitor. This flag is for a trusted machine or internal tool, not a public frontend. It's off by default.

`PUBLIC_BASE_URL` is the one that matters most and is the easiest to miss: it is what every generated short link is built from. If it is unset or still `localhost`, links are handed out that nobody but you can open, and nothing errors. The server therefore checks the deployment-critical settings at boot and logs a warning for each one that is missing or still pointing at localhost — `PUBLIC_BASE_URL`, `FRONTEND_BASE_URL`, `CORS_ORIGINS`, `TRUST_PROXY`, `API_KEY` and `SMTP_HOST`. The output looks like this:

```
Linkly backend running on port 3001
WARNING: PUBLIC_BASE_URL is "http://localhost:3001", which is only reachable from this machine. Generated links will not resolve for real visitors.
WARNING: FRONTEND_BASE_URL is not set, so password-reset and verification emails will link to localhost and be unusable. ...
WARNING: CORS_ORIGINS is not set, so any website can call this API from a visitor's browser. ...
WARNING: API_KEY is not set. ...
WARNING: SMTP_HOST is not set. ...
```

### Health checks and shutdown

`GET /` is both a liveness and a readiness endpoint. It runs `SELECT 1` and returns **503** with `{"status":"degraded","db":{"ok":false,...}}` when the database is unreachable, so a load balancer pulls the instance out of rotation instead of feeding it traffic that is certain to fail. Only the Postgres error *code* is returned, never the message, which can carry host or credential details. On success it returns `200` with `db.ok: true`.

The frontend distinguishes the three states rather than treating anything non-200 as "offline": a reachable API reporting a database outage shows **Service Degraded** and hides the account controls, instead of silently falling back to LocalStorage and appearing to work.

`SIGTERM` and `SIGINT` trigger a graceful shutdown: the server stops accepting connections, in-flight requests finish, the `pg` pool is closed, and the process exits `0`. A 10-second watchdog forces exit if a request will not drain, so a deploy can never hang.

## 🛠 Admin tooling

Links created before accounts existed have neither an owner nor a guest token, so the HTTP API correctly refuses to delete them. These scripts talk to the database directly, as the operator of the deployment:

```bash
npm --prefix backend run doctor                    # config + schema + connection preflight
npm --prefix backend run db:inventory              # counts + link inventory
npm --prefix backend run db:classify               # groups links by pattern
npm --prefix backend run db:links -- list-orphans  # legacy links with no owner

# Claim a legacy link for an account (must already be registered)
npm --prefix backend run db:links -- claim <linkId> <email>

# Delete legacy links. Prints what it will do; --yes is required.
npm --prefix backend run db:links -- delete <linkId> --yes
npm --prefix backend run db:links -- delete-orphans --match <substring> --yes
```

The delete commands only ever match rows that are **genuinely unowned**, so they cannot be used to remove a link belonging to an account or a guest token — those must go through the API, where ownership is respected. `LIKE` patterns are escaped, so a match string is always literal.

To remove development/test accounts and the links they own:

```bash
npm --prefix backend run db:prune-tests           # dry run, prints both lists
npm --prefix backend run db:prune-tests -- --yes
```

The pruner matches only obviously synthetic addresses (`probe*@example.com`, `*@example.org`, `.test`, and similar). Anything else is listed under "will be kept" and never touched. It deletes the accounts' links explicitly rather than relying on `ON DELETE SET NULL`, which would leave orphaned rows behind.

Session health (read-only):

```bash
npm --prefix backend run db:sessions
```

## 📡 API reference

Authenticate with `Authorization: Bearer <session-token>`.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/` | Health check |
| `POST` | `/api/auth/register` | `{ email, password }` → `201` with `{ user, token, expiresAt }`. `409` if taken. |
| `POST` | `/api/auth/login` | `{ email, password }` → `{ user, token, expiresAt }`. |
| `POST` | `/api/auth/logout` | Revokes the current session. |
| `GET` | `/api/auth/me` | Current user, or `401`. |
| `POST` | `/api/auth/forgot-password` | `{ email }`. Always the same response, known address or not. |
| `POST` | `/api/auth/reset-password` | `{ token, password }`. Single-use; revokes all sessions on success. |
| `POST` | `/api/auth/resend-verification` | Requires a session. |
| `POST` | `/api/auth/verify-email` | `{ token }`. Single-use. |
| `POST` | `/api/links` | `{ destinationUrl, customAlias? }` → `201`. Signed-in creators get no guest token. |
| `GET` | `/api/links?limit=50` | **Your** links only, newest first. Operator key sees all. |
| `DELETE` | `/api/links/:id` | Owner or operator only. `403` otherwise. |
| `GET` | `/` | Health and readiness. `503` + `db.ok: false` when the database is unreachable. |
| `GET` | `/api/favicon?domain=` | Server-side favicon lookup. `400` if not a bare public hostname. |
| `GET` | `/:code` | Increments `clicks` and `302`s to the destination. |
| `GET` | `/robots.txt` | Disallows all crawlers. |
| `GET` | `/reset-password`, `/verify-email` | Redirects to the matching frontend hash route, preserving `?token=`. Handled inside `GET /:code`. A fallback in case a deployment is ever configured with path-based links. |

## 🧪 QR encoder

`qr.js` is a dependency-free QR Code generator written against ISO/IEC 18004. It's a classic script (exposing `window.QRCode`) so `index.html` still works from `file://`, and it also loads under Node for tests.

What it implements:

- Versions 1–10 across all four error-correction levels, with the correct Reed-Solomon block structure and **interleaved** multi-block symbols (needed from v5 onward).
- Byte mode with UTF-8, announced via ECI when the payload isn't pure ASCII.
- Remainder bits for versions 2–6.
- BCH-computed format information (15 bits, correct error-correction level and mask) and version information (18 bits, v7+).
- All eight data masks scored with the four ISO penalty rules; the lowest-penalty symbol wins.

```js
QRCode.toMatrix(url, { ecLevel: 'M' })   // { version, size, mask, level, modules }
QRCode.renderToCanvas(canvas, url, opts)  // PNG download
QRCode.toSvg(url, opts)                   // vector download
QRCode.capacityBytes(version, level)      // max payload for a version
```

Correctness is verified by **round-tripping every generated symbol through an independent decoder** (jsQR) — all 40 version/level capacity combinations, exact-fill payloads, multi-block symbols, and UTF-8 payloads. The byte-mode capacity table is pinned to the spec values, which is what actually catches a wrong EC block count.

## ✅ Testing & linting

```bash
npm run check      # lint + test + audit
npm run lint
npm test           # 247 tests, no test framework required
npm run audit      # production dependency advisories (high/critical)
npm run doctor     # deployment config + schema preflight
npm run loadtest   # k6, from backend/loadtest/linkly.js
```

`npm run audit` runs in CI too, so a vulnerable production dependency fails the build instead of quietly accumulating. It covers **both** projects and checks **production dependencies only** — a vulnerable dev-only package is a much smaller risk, and a gate that blocks on those tends to get bypassed. Fix those separately with `npm audit fix`.

Tests run on Node's built-in runner. The HTTP layer boots the Express app on an ephemeral port against an in-memory fake pool, so the suite needs no database.

### Security invariant guards

`backend/test/invariants.guard.test.js` doesn't test behaviour — it reads the source and asserts
that specific *shapes* still hold. Each check corresponds to a mistake that actually shipped here:

- Emailed tokens are built as a `#/` hash route, never a path.
- Reset and verification tokens are spent by one conditional `UPDATE … RETURNING`, never a `SELECT`
  followed by an `UPDATE`.
- No database value reaches `innerHTML`, and `escape.js` still escapes `"` and `'`.
- Every credential is digested before it is written; no table has a plaintext token column.
- No boolean env var is parsed with `Boolean()`.
- The favicon proxy refuses internal addresses in every shorthand notation, follows redirects
  manually, and keeps a bounded cache.
- A `NODE_ENV=production` boot refuses a loopback `PUBLIC_BASE_URL` **before** binding a port.

`backend/test/assets.test.js` guards the frontend the same way, against failures that produce no
error at all: every `var()` in `styles.css` must resolve to a declared custom property, both themes
must override the same tokens, and every file `index.html` loads must exist. An undefined `var()` is
not ignored — the declaration using it is *dropped*, which is how the auth inputs lost their focus
ring without anything reporting it.

If you change one of those areas, this file is what will tell you. [`AGENTS.md`](./AGENTS.md) explains
why each one exists.

### Frontend tests

`backend/test/frontend.test.js` runs `app.js` inside **jsdom**, parsing the real `index.html` so the markup and the script can never drift apart. It covers card rendering, the XSS boundary, search and sort, analytics, modal focus behaviour, the email hash routes, and configuration.

jsdom is a **devDependency only** — the browser payload (`index.html`, `styles.css`, `escape.js`, `qr.js`, `app.js`) still ships zero dependencies.

One test is worth calling out: it asserts that every `getElementById` in `app.js` resolves to an element in `index.html`. That catches the most likely class of frontend regression here, since there is no bundler to report a missing id at load time.

The load test registers one account in `setup()` and drives the real session-based flow. Because every VU shares one client IP, raise both budgets on the server first or the run will be nothing but `429`s:

```bash
CREATE_RATE_MAX=100000 AUTH_RATE_MAX=100000 npm run loadtest
```

## 📂 Project structure

```
index.html               # Semantic layout, stats, modals, SVG icons
styles.css               # Design system, CSS variables, glassmorphism, responsive grid
escape.js                # HTML/CSV escaping (also loads under Node)
qr.js                    # ISO/IEC 18004 QR encoder (also loads under Node)
app.js                   # App logic, auth, analytics, search/sort, local-storage fallback
eslint.config.mjs        # Lints the frontend and the backend together
AGENTS.md                # Rules, invariants and stack traps for agents and new contributors
backend/
  server.js              # Express REST API + auth + favicon proxy + redirects (a factory)
  schema.sql             # Idempotent schema; doubles as the migration
  scripts/
    doctor.js            # Config + schema + connection preflight
    migrate.js           # Applies schema.sql without needing psql
    inventory.js         # Read-only counts and link listing
    classify.js          # Groups links by pattern, for cleanup decisions
    links-admin.js       # Claim or delete legacy unowned links
    prune-test-accounts.js # Removes synthetic dev accounts and their links
    session-stats.js     # Read-only session health report
  loadtest/linkly.js     # k6 load test
  lib/
    config.js            # Deployment-config checks, shared by boot warnings and doctor
    auth.js              # Passwords, sessions, ownership checks
    tokens.js            # Password reset & email verification tokens
    mailer.js            # SMTP delivery, with a log fallback
    codes.js             # Random base62 short codes (rejection sampled)
    favicon.js           # SSRF-hardened favicon fetching with caching
    sessions.js          # Expired-session housekeeping
    db.js                # Lazily-created Postgres pool
  test/
    qr.test.js           # QR round-trips through jsQR
    api.test.js          # HTTP integration against a fake pool
    frontend.test.js     # app.js under jsdom, driven by the real index.html
    favicon.test.js      # Favicon proxy: caching, SSRF, content-type guards
    tokens.test.js       # Reset & verification token lifecycle
    escape.test.js       # Escaping / XSS regression tests
    csv.test.js          # CSV formula-injection tests
    auth.test.js         # Passwords, sessions, authorisation rules
    codes.test.js        # Code generation, distribution, validation
    config.test.js       # Deployment-config checks and the production fail-fast
    assets.test.js       # CSS custom properties, theme parity, referenced files
    schema.test.js       # Index hygiene: no redundant indexes, every FK and sweep indexed
    invariants.guard.test.js # Structural guards for the AGENTS.md invariants
    shutdown.test.js     # Graceful SIGTERM drain
```

## 🧑‍💻 Contributor notes

Traps that have cost real time here. The full version, with the reasoning, is in
[`AGENTS.md`](./AGENTS.md).

**PowerShell mangles inline JSON.** `curl.exe -d '{"a":1}'` strips the quotes and produces a
misleading `400`. Use `Invoke-RestMethod -Body (@{…} | ConvertTo-Json)` or
`curl.exe --data-binary @payload.json`. Don't chase a `400` that's really a quoting bug.

**`node --test` must be invoked bare.** On Node 24, `node --test test/*.test.js` and
`node --test test/` both fail. `npm test` is already the bare form.

**jsdom needs an `http://` origin.** `about:blank` is opaque and `localStorage` throws. The
`bootPage()` harness in `frontend.test.js` passes `http://localhost:8080/` and stubs the missing
2D canvas context — reuse it rather than building another.

**Windows never delivers signals to Node.** `kill('SIGTERM')` terminates the process before a
handler runs, so graceful shutdown is tested with a `--import` preload that calls
`process.emit('SIGTERM')` in-process, as `shutdown.test.js` does.

**The database is live.** `DATABASE_URL` points at a real Neon database. `db:migrate` is
idempotent and safe to re-run; anything that writes rows is not. After testing, run
`db:prune-tests -- --yes` and confirm with `db:inventory`. It should end empty: 0 links, 0 accounts,
0 sessions, 0 orphans.

**Confirm a regression test actually fails.** A test that passes both with and without the fix
proves nothing. Revert the fix, watch it fail, restore. Do this for every bug fix you add.

## 🛠 Tech notes

- Short codes use **rejection sampling** rather than `byte % 62`, which would bias the first characters of every code.
- Link creation is a single `INSERT` relying on the unique index for collision detection, so the old check-then-insert race (which surfaced as a `500`) is gone — a duplicate alias is a clean `409`.
- The redirect is a single `UPDATE ... RETURNING`, not a `SELECT` followed by an `UPDATE`. Its click counter **saturates** at the `integer` ceiling rather than overflowing into a `500` on every subsequent click.
- `sessions` carries no index on `token_hash`: the `unique` constraint already creates one, and a second identical b-tree just meant every login maintained both. The expired-session sweep filters on `expires_at`, which *is* indexed — unindexed, `EXPLAIN` over 20k sessions planned a sequential scan touching 10941 rows, hourly, forever.
- `backend/test/schema.test.js` keeps that honest: no index may duplicate a `unique` constraint, every foreign key must be indexed (Postgres does not do this for you), and every column a maintenance sweep filters on must have an index **on that table**.
- The click counter is incremented with a write on every hit, which makes a redirect non-idempotent: a proxy or browser retry double-counts. That is inherent to server-side click tracking, not a bug to fix here.
- `POST /api/links` no longer needs a dedicated pooled connection or an explicit transaction.
- `app.get('/:code')` validates the code shape before touching the database and yields to a JSON `404` for anything that isn't a short code, so `/favicon.ico` and friends never hit Postgres.
- Exports use `Blob` + `URL.createObjectURL` rather than `encodeURI` data URIs, which cannot represent `#` or newlines safely.