/**
 * Housekeeping for the sessions table.
 *
 * Expired sessions are already inert — `resolveSession` filters on
 * `expires_at > now()` — so deleting them is invisible to clients. Without
 * this sweep the table grows without bound.
 */

/**
 * Deletes sessions that have already expired.
 *
 * @param {(text: string, params?: unknown[]) => Promise<{rowCount: number}>} query
 * @returns {Promise<number>} how many rows were removed
 */
export async function pruneExpiredSessions(query) {
  const result = await query('DELETE FROM sessions WHERE expires_at <= now()');
  return result.rowCount ?? 0;
}