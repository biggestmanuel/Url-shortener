/**
 * Reports session health. Read-only.
 *
 *   node scripts/session-stats.js
 */

import 'dotenv/config';

import { getPool } from '../lib/db.js';

async function main() {
  const pool = getPool();

  try {
    const { rows } = await pool.query(`
      SELECT
        count(*)::int                                              AS total,
        count(*) FILTER (WHERE expires_at <= now())::int          AS expired,
        count(*) FILTER (WHERE expires_at > now())::int           AS active,
        count(*) FILTER (WHERE created_at < now() - interval '7 days')::int AS older_than_7d
      FROM sessions
    `);

    console.log('\n=== sessions ===');
    console.log(`  total            : ${rows[0].total}`);
    console.log(`  active           : ${rows[0].active}`);
    console.log(`  expired          : ${rows[0].expired}`);
    console.log(`  created >7d ago  : ${rows[0].older_than_7d}`);

    const orphans = await pool.query(`
      SELECT count(*)::int AS n
        FROM sessions s
        LEFT JOIN users u ON u.id = s.user_id
       WHERE u.id IS NULL
    `);
    console.log(`  without a user   : ${orphans.rows[0].n}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Session stats failed:', err.message);
  process.exit(1);
});