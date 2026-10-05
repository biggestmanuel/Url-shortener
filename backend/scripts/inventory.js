/**
 * Read-only inventory of the links and users tables.
 *
 * Usage:
 *   node scripts/inventory.js
 */

import 'dotenv/config';
import pg from 'pg';

function normalize(connectionString) {
  return connectionString.replace(
    /([?&])sslmode=(prefer|require|verify-ca)(?=(&|$))/i,
    '$1sslmode=verify-full'
  );
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: normalize(process.env.DATABASE_URL),
  });
  await client.connect();

  try {
    const totals = await client.query(`
      SELECT
        count(*) FILTER (WHERE user_id IS NOT NULL)          AS account_owned,
        count(*) FILTER (WHERE owner_token IS NOT NULL)      AS guest_owned,
        count(*) FILTER (WHERE user_id IS NULL
                           AND owner_token IS NULL)           AS orphans,
        count(*)                                             AS total
      FROM links
    `);

    const counts = totals.rows[0];
    console.log('\n=== links ===');
    console.log(`  account-owned : ${counts.account_owned}`);
    console.log(`  guest-owned   : ${counts.guest_owned}`);
    console.log(`  orphans       : ${counts.orphans}   (no owner and no token)`);
    console.log(`  total         : ${counts.total}`);

    const sessions = await client.query('SELECT count(*)::int AS n FROM sessions');
    const users = await client.query('SELECT count(*)::int AS n FROM users');
    console.log('\n=== accounts ===');
    console.log(`  users    : ${users.rows[0].n}`);
    console.log(`  sessions : ${sessions.rows[0].n}`);

    const byUser = await client.query(`
      SELECT u.id, u.email, count(l.id)::int AS links
        FROM users u
        LEFT JOIN links l ON l.user_id = u.id
       GROUP BY u.id, u.email
       ORDER BY links DESC, u.email
    `);
    console.log('\n=== users (links per account) ===');
    for (const row of byUser.rows) {
      console.log(`  ${row.email}  (${row.links} links)`);
    }

    const orphans = await client.query(`
      SELECT id, code, destination_url, created_at
        FROM links
       WHERE user_id IS NULL AND owner_token IS NULL
       ORDER BY created_at DESC
       LIMIT 200
    `);
    console.log(`\n=== orphan links (up to 200) ===`);
    for (const row of orphans.rows) {
      console.log(
        `  id=${row.id}  ${String(row.code).padEnd(10)} ${new Date(row.created_at).toISOString().slice(0, 10)}  ${row.destination_url.slice(0, 70)}`
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Inventory failed:', err.message);
  process.exit(1);
});