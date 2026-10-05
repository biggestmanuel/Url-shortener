import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

let defaultPool = null;

// Neon requires SSL. Explicitly use verify-full so pg's upcoming SSL-mode
// semantics do not weaken the connection.
function normalizeConnectionString(connectionString) {
  return connectionString.replace(
    /([?&])sslmode=(prefer|require|verify-ca)(?=(&|$))/i,
    '$1sslmode=verify-full'
  );
}

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  return new Pool({
    connectionString: normalizeConnectionString(connectionString),
    max: 20,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
}

/**
 * Lazily creates the process-wide pool. Deferring construction keeps
 * `server.js` importable from tests that never touch a real database.
 */
export function getPool() {
  if (!defaultPool) {
    defaultPool = createPool();
  }
  return defaultPool;
}

/**
 * Closes the pool if one was ever created.
 *
 * The pool is lazy, so a process that never issued a query has none. Calling
 * getPool() during shutdown would *create* one just to close it — and throw
 * "DATABASE_URL is not set" on a server that never needed a database.
 *
 * @returns {Promise<boolean>} whether a pool was actually closed
 */
export async function closePool() {
  if (!defaultPool) return false;

  const pool = defaultPool;
  defaultPool = null;
  await pool.end();
  return true;
}

/** Test seam: whether a pool exists right now. */
export function hasPool() {
  return Boolean(defaultPool);
}