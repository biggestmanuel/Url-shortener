/**
 * RULES FOR AI AGENTS AND NEW CONTRIBUTORS
 * ========================================
 *
 * Read this before changing anything. It records the mistakes that have
 * actually been made in this repository and the traps in the stack, so the
 * next session does not repeat them.
 *
 * The theme of every item below is the same: something that looked fine in a
 * test, in a review, or on a developer's machine, and was wrong in production
 * or under concurrency.
 */

# 1. Non-negotiable security invariants

Do not relax any of these. Each one exists because its absence was a real bug.

## 1.1 Never interpolate a database value into HTML

Link cards are built with **DOM APIs and `textContent`**, never by building an
HTML string. The only `innerHTML` in the render path is static icon markup
authored in `app.js` (`COPY_ICON`, `QR_ICON`, `TRASH_ICON`, …).

The original bug: `escapeHtml` escaped `& < >` but **not quotes**, and
destination URLs were interpolated into `title="..."`. A URL containing a
double quote broke out of the attribute. Fixing the escaper alone would have
been a patch; the DOM-API rewrite made the class of bug impossible. Keep it.

`escape.js` still escapes `& < > " '` and is used for text inserted into
markup strings (toasts). Don't "simplify" it back to a `textContent`-based
version — that was the original defect.

## 1.2 The favicon proxy is an SSRF boundary

`GET /api/favicon?domain=` makes an outbound request **on behalf of whoever
supplied the value**. That makes it a server-side request forgery primitive
unless it is fenced in.

The original bug: `isValidDomain` blocked `localhost` but its regex happily
matched `169.254.169.254` and every RFC1918 address. Anyone could point the
proxy at cloud metadata or an internal service.

Rules:
- Refuse private, loopback, link-local (incl. `169.254.169.254`), CGNAT and
  reserved IPv4 ranges, **including** the shorthand notations a resolver
  accepts: `127.1`, `0177.0.0.1`, `0x7f000001`, `0x7f.0.0.1`, `10.1`.
- Refuse single-label hosts — they resolve only via a local search domain.
- Follow redirects **manually** and re-check every hop. `redirect: 'follow'`
  lets a public host bounce the request internally with nothing left to
  inspect.
- Keep the cache bounded; its keys are attacker-supplied.

When touching this code, add the address to the refuse-list in
`backend/test/favicon.test.js` and assert `isValidDomain` returns `false`
**and** that no request was made.

## 1.3 Single-use tokens must be spent atomically

A `SELECT` to check "is this token still unused?" followed by a separate
`UPDATE` is a race: two concurrent requests carrying one token both pass the
check and both succeed.

Consume with a single conditional statement that returns the row:

```sql
UPDATE password_resets SET used_at = now()
 WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
 RETURNING user_id
```

If `RETURNING` is empty, the token was already spent or expired. Don't split
this into two round trips for "clarity".

## 1.4 A password reset revokes every session

A reset is the remedy for a compromised account, so old sessions must not
survive it. `consumePasswordReset` deletes all sessions for the user. Keep it.

## 1.5 Secrets at rest are digests, not values

Sessions, reset tokens and verification tokens are stored **only** as SHA-256
digests, so a database dump cannot be replayed. Passwords use scrypt
(N=16384, r=8, p=1) with a per-password salt.

`owner_token` is the deliberate exception: it is stored **plaintext**, because
you cannot verify a digest you cannot reproduce. That makes it weaker than a
password hash — don't pretend otherwise in docs, and don't "fix" it by
hashing without a redesign.

## 1.6 Never put an operator key in served markup

Runtime config lives in `localStorage` (`linkly.apiBase`, `linkly.apiKey`,
`linkly.repoUrl`), not in a config file or a `window.LINKLY_*` global that
ships to every visitor.

⚠️ `REQUIRE_API_KEY_TO_CREATE` is documented as **trusted-machine-only**. An
API key in the browser is obscurity, not security: anyone who opens devtools
has it. Don't enable it for a public frontend and don't describe it otherwise.

## 1.7 Tokens in emails go in the URL **fragment**

Emailed links are `#/reset-password?token=…` and `#/verify-email?token=…`.

Why: a path-style link (`/reset-password?token=…`) is matched by the
`/:code` catch-all and answered with `404 Short link not found` — this was a
real shipping bug. A fragment also keeps the token out of request lines, access
logs and `Referer` headers entirely.

Keep the `FRONTEND_ROUTES` fallback in `backend/server.js` if you ever need to
tolerate path-style links, but the hash form is the contract.

## 1.8 The CSS must not reference undefined custom properties

`styles.css` uses `var(--token)` throughout, and **a `var()` with no matching
declaration is dropped, not ignored** — the whole declaration using it
disappears, silently.

Four invented names (`--accent-primary`, `--accent-glow`, `--bg-subtle`,
`--text-primary`) crept into the account UI. The result: the auth inputs lost
their background *and their entire focus ring*, in both themes, with no console
error and no failing test. A keyboard user tabbing through the sign-in dialog
had no visible focus indicator.

`backend/test/assets.test.js` now fails on any undefined `var()` and on a
theme-specific token that `body.dark` fails to override. Use the tokens that
exist: `--primary`, `--primary-hover`, `--primary-subtle`, `--primary-border`,
`--primary-glow`, `--bg-input`, `--bg-surface`, `--bg-surface-hover`,
`--text-main`, `--text-muted`, `--text-subtle`, `--border-subtle`,
`--border-strong`, `--border-focus`. Before adding a token, define it in
**both** `:root` and `body.dark`.

## 1.9 Indexes are not optional, and neither is removing the wrong ones

Both mistakes here are silent: no error, no failing test, just a slower app
until one day it isn't.

## 1.10 Public routes stay public

Routes that are intentionally public (no accounts by design) must be documented
as such in `README.md` and protected with rate limits, input limits, and
spending caps instead of auth. Never add auth to a public route without asking
the operator first — public-by-design is an architectural decision, not an
oversight to fix.

- **Don't index a column that a `unique` constraint already indexes.**
  `token_hash text unique` creates `sessions_token_hash_key` on its own. A
  second `create index ... on sessions (token_hash)` meant every login — the
  hottest write in the app — maintained two identical b-trees for no query
  benefit.
- **Do index every column a maintenance sweep filters on.** The hourly
  expired-session sweep deletes on `sessions.expires_at`. Unindexed, `EXPLAIN`
  over 20k sessions planned a sequential scan touching 10941 rows, and the cost
  grows linearly with retained logins.
- **Index foreign keys.** Postgres does not create these. `sessions.user_id`
  and `links.user_id` cascade on user delete; without an index each delete
  scans the child table.
- **Include the sort column in a composite index.** `links_user_id_idx` is
  `(user_id, created_at desc)` so the dashboard's `ORDER BY created_at DESC`
  needs no sort. Splitting it into `(user_id)` forces a full sort of every
  matching row.

`backend/test/schema.test.js` enforces all four. When you add a column or an
index, run `npm --prefix backend run db:migrate` (idempotent) and the suite
will tell you if you duplicated or forgot something.

Note that the guard checks the index **on the table being swept**. An index on
`password_resets(expires_at)` says nothing about `sessions`, and a version of
that check which pooled columns across all tables passed with no
`sessions.expires_at` index at all.

# 2. Traps in this stack

These cost real time. They are not obvious.

## 2.1 `node --test` invocation

On Node 24, `npm test` must be the **bare** `node --test`. Both of these fail:

```bash
node --test test/*.test.js    # glob form: does not expand on Windows
node --test test/             # also fails
```

## 2.2 PowerShell mangles inline JSON

`curl.exe -d '{"a":1}'` in PowerShell **strips the quotes**, producing a
malformed body and a misleading `400`. Use one of:

```powershell
Invoke-RestMethod -Method Post -ContentType 'application/json' -Body (@{...} | ConvertTo-Json)
curl.exe --data-binary @payload.json
```

Do not chase a "400" that is really a quoting bug.

## 2.3 jsdom needs a real origin

`new JSDOM(html)` with `about:blank` has an **opaque origin**, and
`localStorage` access throws. Always pass `url: 'http://localhost:8080/'`.

jsdom also has no canvas backend, so `getContext('2d')` returns `null` and the
QR renderer's first `fillRect` throws. `bootPage()` in
`backend/test/frontend.test.js` stubs it. Reuse that harness rather than
building a new one — it evaluates the **real** `index.html` and the **real**
`app.js`, so markup and script can't drift apart.

## 2.4 Windows does not deliver signals to Node

`process.kill(pid, 'SIGTERM')` on Windows terminates the target
unconditionally; a Node signal handler never runs. So:

- Don't verify graceful shutdown with a spawned child and `kill('SIGTERM')`.
- Use a `--import` preload that calls `process.emit('SIGTERM')` in-process, as
  `backend/test/shutdown.test.js` does.

## 2.5 `node --test` reports duplicate test names

A failing test appears twice in output. Match on `^not ok` with the TAP
reporter rather than counting failures by eye.

## 2.6 Neon and the live database

`DATABASE_URL` in `backend/.env` points at a **real** Neon database.

- `npm --prefix backend run db:migrate` is idempotent and safe to re-run.
- Anything that writes rows is not. After testing against the live DB, clean
  up: `npm --prefix backend run db:prune-tests` (dry run by default, needs
  `--yes`). Verify with `db:inventory`.
- The database is expected to end **empty**: 0 links, 0 accounts, 0 sessions,
  0 orphans. Leave it that way.

## 2.7 `Boolean('false')` is `true`

This shipped a real vulnerability. `Boolean(process.env.TRUST_PROXY)` enables
proxy trust for anyone who copies the shipped `.env.example` value of
`false` — and with proxy trust on, a client can spoof `X-Forwarded-For` and
walk past every per-IP rate limit.

Use `boolEnv()` in `backend/server.js`, which only accepts
`1/true/yes/on` and `0/false/no/off`. Same reasoning applies to any new
boolean env var: don't reach for `Boolean(...)`.

Related: `numEnv()` treats `0` as *unset* and falls back. That's correct for a
limit but wrong for a setting whose documented "0 disables" must actually
disable — `SESSION_SWEEP_MINUTES` uses `nonNegativeEnv()` for that reason.

# 3. Before you commit

Automate everything that can be automated: tests, lint, builds, audits, scans,
migration checks, and repeated manual steps. Run them and report results.
Never automate irreversible or outward-facing actions — merging, deploying,
deleting data, force-pushing, spending money, sending messages. Those require
explicit approval before they run.

The full gate, from the repository root:

```bash
npm run check     # lint + all tests + production-dependency audit + secret scan
npm run doctor    # deployment config + schema + connection preflight
```

Non-negotiable expectations:

- **Zero lint errors.**
- **All tests pass.**
- **`npm audit --omit=dev` reports 0 vulnerabilities** in both trees. The CI
  gate is production deps only; don't introduce a new dependency casually, and
  don't "fix" an audit by widening the gate.
- **`npm run audit:secrets` reports no findings.** This repository is public,
  so a credential in a commit is leaked from the moment it is pushed, and a
  later deletion does not revoke it.
- No `probe.mjs` / scratch files left behind.
- No background `node` processes still listening.
- The database is back to empty.
- No secrets committed. `.env` is gitignored; `.env.example` must never
  contain a real value.

### Never run `npm audit fix --omit=dev` here

It **deletes devDependencies** to satisfy a production-only report — it would
remove `jsdom` and `jsqr` and silently gut the frontend and QR test suites.
When a transitive advisory appears, update that one package within the range
its parent already allows (`npm --prefix backend update <pkg>`), and check
`git diff` afterwards to confirm only the lockfile entry moved.

For example `proxy-addr` (via Express) had a critical IP-spoofing advisory.
Express 4.22.3 requires `~2.0.7`, which already permits the fixed 2.0.8, so
the correct fix was one package and seven lockfile lines — not a migration to
Express 5 and not a dependency purge.

### If the secret scan ever fails

Rotate the credential **first**, then decide whether to rewrite history. Those
are independent: rotation is what actually revokes it, and history rewriting is
cosmetic if the value was already public. Do the rotation even if you rewrite.

## 3.1 Git workflow (branch and pull request, never push to `main`)

Never commit or push directly to `main`. `main` receives merges only. Work on a
branch from an up-to-date `main`:

```bash
git switch main
git pull
git switch -c <short-descriptive-name>
# make the change, run the gate, commit
git push -u origin <branch>
```

Commit and push to your branch after every coherent change — one change, one
commit, pushed, then move on. Do not batch unrelated work and do not leave work
uncommitted. A commit is one coherent change that leaves the repo consistent,
not one file and not one keystroke. Never commit a half-finished refactor. Two
unrelated fixes means two commits. Refactoring beside a bug fix is a separate
commit.

Merging: when you believe the branch is ready, say so, with your reasoning, CI
status, and a summary of the diff. Open the PR and wait. Merge only after the
user explicitly confirms. Before asking, confirm CI is green and the diff
matches your report.

Reverting is a commit. History is append-only. If a pushed commit was wrong, add
a commit that undoes it and say in the message what was wrong.

Before committing, run the full gate:

1. Make the change.
2. Run `npm run check` — lint, all tests, production-dependency audit, secret
   scan. A commit that fails them does not happen. Fix it, or explain in the
   commit message why the exception is correct. No `--no-verify` without a
   documented reason.
3. `git add -A`
4. `node scripts/audit-secrets.mjs` — confirm the staged index is clean.
5. `git commit`
6. `git push -u origin <branch>`

Run the secret scan on the **staged index** at step 4, before committing rather
than after. `git commit --amend` can rewrite a commit to remove a value, but
the object still sits in the store, and if the commit was already pushed it is
already public. Checking the index is the last point where a leak is still
cheap.

Expect the push to be **rejected** if the diff contains a credential-shaped
string. GitHub push protection is stricter than the scanner in this repository
and will refuse on a planted fixture even though the value is obviously fake.
That is not a false positive to work around by clicking "unblock" — build the
fixture from fragments instead, the way `plant()` in
`backend/test/secrets.test.js` does. If a push is rejected, read the violation
before retrying; do not retry unchanged.

> **Note on work already done:** Several commits were committed and pushed
> directly to `main` before these rules were in place (commits `b84e18e`,
> `761f68c`, `1f712e1`). Going forward, all work must be on branches and merged
> via PR.

## 3.0 The invariants above are enforced, not just documented

`backend/test/invariants.guard.test.js` asserts the *shape* of the code for
every rule in section 1: that emailed tokens are hash routes, that token
consumption is a single conditional `UPDATE`, that nothing dynamic reaches
`innerHTML`, that credentials are digested before being written, that no
boolean env var uses `Boolean()`, that the favicon proxy keeps its SSRF
fences, and that a production boot refuses a loopback base URL before it
binds a port.

`backend/test/assets.test.js` does the same for the frontend's silent
failures: undefined CSS custom properties, themes that disagree about which
tokens exist, and files `index.html` references that are not there.

`backend/test/schema.test.js` covers the index hygiene in section 1.9. When
you add a regression test for a *bug* rather than a shape, call the real
function — an earlier test duplicated a regex from `escape.js` into the test
body, so it kept passing even when `escape.js` stopped matching on any of the
payloads it claimed to cover.

`backend/test/secrets.test.js` does the same for `scripts/audit-secrets.mjs`:
it plants a dozen known-bad strings in a throwaway repository and asserts each
one is detected. Two real defects were found this way and would otherwise have
shipped:

- The scanner's `npg_` pattern required 20 characters after the prefix. The
  actual Neon password on this project is 14 — the scanner would have reported
  the repo clean while missing the one credential that actually mattered.
- It treated any `.env` value over 12 characters as a live secret, so
  `PUBLIC_BASE_URL=http://localhost:3001` matched 43 times across the code and
  docs. A scanner that cries wolf gets switched off; that fix required an
  entropy floor and an explicit "configuration is not a credential" list.

Never write a scanner or a guard you have not seen fail. "It says clean" is
only evidence if "it says dirty" has been demonstrated.

Two things follow from that:

- **If you legitimately change one of those areas, update the guard and say
  why in your summary.** A guard that fails because the design intentionally
  changed should be replaced deliberately, not deleted to make the suite green.
- **When adding a fix, add its guard.** The guard tests have been verified to
  fail when the corresponding bug is reintroduced. If a fix has no guard,
  the same mistake is available to the next session.

## 3.1 Confirm a new test actually fails

A test that passes both before and after a fix proves nothing. Before keeping a
regression test, revert the fix, watch the test fail, then restore. Do this
for **every** bug fix added to the suite — it's the only way to know the test
is load-bearing.

## 3.2 Don't add a dependency to solve something you can write

This repo has zero browser dependencies and a five-package backend, and that is
deliberate. The security headers, the boolean env parser, the IPv4 range checks
and the graceful-shutdown handler are all hand-written for exactly this reason.
Reach for a package only when writing it yourself would be genuinely worse —
and say why in the commit message.

# 4. Layout

```
index.html app.js styles.css     frontend, served as-is, no build step
escape.js qr.js                  browser globals (window.LinklyEscape, window.QRCode)
backend/server.js                Express factory; exports createApp() for tests
backend/lib/auth.js              scrypt, session tokens, resolveSession, canDeleteLink
backend/lib/tokens.js            reset + verification token lifecycle
backend/lib/codes.js             base62 code generation (rejection-sampled)
backend/lib/favicon.js           SSRF-hardened favicon fetch + bounded cache
backend/lib/config.js            deployment-config checks (boot warnings + doctor)
backend/lib/sessions.js          expired-session sweep
backend/lib/db.js                lazy pg Pool
backend/schema.sql               idempotent; doubles as the migration path
backend/scripts/doctor.js        config + schema + connection preflight
backend/scripts/                 operator CLIs (inventory, classify, links, prune)
backend/test/                    node:test + jsdom
```

`createApp()` is a factory and a port is bound only when `server.js` is run
directly. Tests inject a stub pool. Keep it that way — anything that binds a
port or connects to Neon at import time makes the suite unusable.

# 5. The one setting most likely to be left wrong

`PUBLIC_BASE_URL` is what every short link is built from. If it is unset, or
still `http://localhost:3001`, then Linkly starts, reports healthy, and hands
out links that nobody but you can open. Nothing errors. Nothing warns unless you
look.

It needs a real hostname that only the operator can choose, so it is never set
automatically. Two mechanisms guard it, so it cannot pass unnoticed:

- `npm run doctor` reports it along with `FRONTEND_BASE_URL`, `CORS_ORIGINS`,
  `TRUST_PROXY`, `API_KEY` and `SMTP_HOST`, and exits non-zero under
  `--strict` so a deploy script can act on it.
- With `NODE_ENV=production` the server **refuses to start** (exit 1) if
  `PUBLIC_BASE_URL` is unset or loopback, or `CORS_ORIGINS` contains `*`.
  `ALLOW_LOOPBACK_BASE_URL=true` waives the loopback check for a genuine
  private-network deployment.

Don't "fix" a production boot failure by unsetting `NODE_ENV` or by adding
`*` to `CORS_ORIGINS`; set the real values.
