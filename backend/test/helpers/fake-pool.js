/**
 * Minimal in-memory stand-in for the pg Pool.
 *
 * It implements just enough SQL for the statements server.js issues, so the
 * HTTP layer can be exercised without a live Postgres.
 */

export function createFakePool() {
  const users = [];
  const sessions = [];
  const resets = [];
  const verifications = [];
  const rows = [];

  let nextUserId = 1;
  let nextSessionId = 1;
  let nextResetId = 1;
  let nextVerificationId = 1;
  let nextId = 1;

  const normalize = (text) => text.replace(/\s+/g, ' ').trim();

  const findById = (id) => rows.find((r) => String(r.id) === String(id));
  const findByCode = (code) => rows.find((r) => r.code === code);

  async function query(text, params = []) {
    const sql = normalize(text);

    // Readiness probe from GET /.
    if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }], rowCount: 1 };

    // --- users ---------------------------------------------------------

    if (sql.startsWith('INSERT INTO users')) {
      const [email, passwordHash] = params;
      if (users.some((u) => u.email === email)) {
        const err = new Error('duplicate key value violates unique constraint "users_email_key"');
        err.code = '23505';
        throw err;
      }
      const user = {
        id: String(nextUserId++),
        email,
        password_hash: passwordHash,
        email_verified_at: null,
      };
      users.push(user);
      return { rows: [user] };
    }

    if (sql.startsWith('SELECT * FROM users WHERE email')) {
      return { rows: users.filter((u) => u.email === params[0]) };
    }

    if (sql.startsWith('SELECT email_verified_at FROM users WHERE id')) {
      const user = users.find((u) => String(u.id) === String(params[0]));
      return { rows: user ? [{ email_verified_at: user.email_verified_at ?? null }] : [] };
    }

    if (sql.startsWith('UPDATE users SET email_verified_at')) {
      const user = users.find((u) => String(u.id) === String(params[0]));
      if (user) user.email_verified_at = new Date().toISOString();
      return { rows: [], rowCount: user ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE users SET password_hash')) {
      const user = users.find((u) => String(u.id) === String(params[1]));
      if (user) user.password_hash = params[0];
      return { rows: user ? [{ id: user.id }] : [] };
    }

    // --- password resets ------------------------------------------------

    if (sql.startsWith('UPDATE password_resets SET used_at = now() WHERE user_id =')) {
      let n = 0;
      for (const row of resets) {
        if (String(row.user_id) === String(params[0]) && !row.used_at) {
          row.used_at = new Date().toISOString();
          n++;
        }
      }
      return { rows: [], rowCount: n };
    }

    if (sql.startsWith('UPDATE password_resets SET used_at = now() WHERE id')) {
      const row = resets.find((r) => String(r.id) === String(params[0]));
      if (row) row.used_at = new Date().toISOString();
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('INSERT INTO password_resets')) {
      const [userId, tokenHash, purpose, expiresAt] = params;
      const row = {
        id: String(nextResetId++),
        user_id: userId,
        token_hash: tokenHash,
        purpose,
        expires_at: expiresAt,
        used_at: null,
      };
      resets.push(row);
      return { rows: [row], rowCount: 1 };
    }

    // Atomic claim: consume and read in one statement.
    if (sql.startsWith('UPDATE password_resets SET used_at = now() WHERE token_hash')) {
      const row = resets.find(
        (r) =>
          r.token_hash === params[0] &&
          r.purpose === params[1] &&
          !r.used_at &&
          new Date(r.expires_at).getTime() > Date.now()
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.used_at = new Date().toISOString();
      return { rows: [{ user_id: row.user_id }], rowCount: 1 };
    }

    if (sql.startsWith('SELECT r.id, r.user_id')) {
      const row = resets.find(
        (r) =>
          r.token_hash === params[0] &&
          r.purpose === params[1] &&
          !r.used_at &&
          new Date(r.expires_at).getTime() > Date.now()
      );
      return { rows: row ? [{ id: row.id, user_id: row.user_id }] : [] };
    }

    // --- email verification ---------------------------------------------

    if (sql.startsWith('UPDATE email_verifications SET used_at = now() WHERE user_id')) {
      let n = 0;
      for (const row of verifications) {
        if (String(row.user_id) === String(params[0]) && !row.used_at) {
          row.used_at = new Date().toISOString();
          n++;
        }
      }
      return { rows: [], rowCount: n };
    }

    if (sql.startsWith('UPDATE email_verifications SET used_at = now() WHERE id')) {
      const row = verifications.find((r) => String(r.id) === String(params[0]));
      if (row) row.used_at = new Date().toISOString();
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('INSERT INTO email_verifications')) {
      const [userId, tokenHash, expiresAt] = params;
      const row = {
        id: String(nextVerificationId++),
        user_id: userId,
        token_hash: tokenHash,
        expires_at: expiresAt,
        used_at: null,
      };
      verifications.push(row);
      return { rows: [row], rowCount: 1 };
    }

    // Atomic claim, mirroring the real statement.
    if (sql.startsWith('UPDATE email_verifications SET used_at = now() WHERE token_hash')) {
      const row = verifications.find(
        (r) =>
          r.token_hash === params[0] && !r.used_at && new Date(r.expires_at).getTime() > Date.now()
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.used_at = new Date().toISOString();
      return { rows: [{ user_id: row.user_id }], rowCount: 1 };
    }

    if (sql.startsWith('SELECT id, user_id FROM email_verifications')) {
      const row = verifications.find(
        (r) =>
          r.token_hash === params[0] && !r.used_at && new Date(r.expires_at).getTime() > Date.now()
      );
      return { rows: row ? [{ id: row.id, user_id: row.user_id }] : [] };
    }

    // --- sessions ------------------------------------------------------

    if (sql.startsWith('INSERT INTO sessions')) {
      const [userId, tokenHash, expiresAt] = params;
      if (sessions.some((s) => s.token_hash === tokenHash)) {
        const err = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        throw err;
      }
      const session = {
        id: String(nextSessionId++),
        user_id: userId,
        token_hash: tokenHash,
        expires_at: expiresAt,
      };
      sessions.push(session);
      return { rows: [session] };
    }

    if (sql.startsWith('SELECT s.id AS session_id')) {
      const now = Date.now();
      const session = sessions.find(
        (s) => s.token_hash === params[0] && new Date(s.expires_at).getTime() > now
      );
      if (!session) return { rows: [] };
      const user = users.find((u) => String(u.id) === String(session.user_id));
      if (!user) return { rows: [] };
      return {
        rows: [
          {
            session_id: session.id,
            expires_at: session.expires_at,
            id: user.id,
            email: user.email,
            // Mirrors the real SELECT; without it /api/auth/me would omit the
            // verification flag.
            email_verified_at: user.email_verified_at ?? null,
          },
        ],
      };
    }

    if (sql.startsWith('DELETE FROM sessions WHERE user_id')) {
      const before = sessions.length;
      for (let i = sessions.length - 1; i >= 0; i--) {
        if (String(sessions[i].user_id) === String(params[0])) sessions.splice(i, 1);
      }
      return { rows: [], rowCount: before - sessions.length };
    }

    if (sql.startsWith('DELETE FROM sessions WHERE id')) {
      const idx = sessions.findIndex((s) => String(s.id) === String(params[0]));
      if (idx >= 0) sessions.splice(idx, 1);
      return { rows: [], rowCount: idx >= 0 ? 1 : 0 };
    }

    if (sql.startsWith('DELETE FROM sessions WHERE expires_at')) {
      const now = Date.now();
      const before = sessions.length;
      for (let i = sessions.length - 1; i >= 0; i--) {
        if (new Date(sessions[i].expires_at).getTime() <= now) sessions.splice(i, 1);
      }
      return { rows: [], rowCount: before - sessions.length };
    }

    // --- links ---------------------------------------------------------

    if (sql.startsWith('INSERT INTO links')) {
      const [code, destinationUrl, userId, ownerToken] = params;

      if (code !== null && code !== undefined && findByCode(code)) {
        const err = new Error('duplicate key value violates unique constraint "links_code_key"');
        err.code = '23505';
        throw err;
      }

      const row = {
        id: String(nextId++),
        code,
        destination_url: destinationUrl,
        clicks: 0,
        user_id: userId ?? null,
        owner_token: ownerToken ?? null,
        created_at: new Date().toISOString(),
      };
      rows.push(row);
      return { rows: [row] };
    }

    if (sql.startsWith('SELECT * FROM links WHERE id')) {
      const row = findById(params[0]);
      return { rows: row ? [row] : [] };
    }

    if (sql.startsWith('DELETE FROM links WHERE id')) {
      const row = findById(params[0]);
      if (!row) return { rows: [] };
      rows.splice(rows.indexOf(row), 1);
      return { rows: [row] };
    }

    if (sql.startsWith('UPDATE links SET clicks')) {
      const row = findByCode(params[0]);
      if (!row) return { rows: [] };
      row.clicks += 1;
      return { rows: [{ id: row.id, destination_url: row.destination_url }] };
    }

    // Operator listing: every link.
    if (sql.startsWith('SELECT * FROM links WHERE code IS NOT NULL ORDER BY')) {
      const limit = params[0] ?? 50;
      const sorted = rows
        .filter((r) => r.code !== null && r.code !== undefined)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return { rows: sorted.slice(0, limit) };
    }

    // Account listing: one user's links only.
    if (sql.includes('AND user_id = $1')) {
      const limit = params[1] ?? 50;
      const sorted = rows
        .filter((r) => r.code !== null && r.code !== undefined)
        .filter((r) => String(r.user_id) === String(params[0]))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return { rows: sorted.slice(0, limit) };
    }

    throw new Error(`Unhandled SQL in fake pool: ${sql}`);
  }

  return { query, rows, users, sessions, resets, verifications, findByCode, findById };
}