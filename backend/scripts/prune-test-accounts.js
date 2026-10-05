/**
 * Removes test accounts and everything they own.
 *
 * Matches only obviously synthetic addresses (local test domains and the
 * throwaway prefixes used during development). Refuses to touch anything else,
 * and prints what it found before doing anything.
 *
 *   node scripts/prune-test-accounts.js            # dry run
 *   node scripts/prune-test-accounts.js --yes
 */

import 'dotenv/config';
import pg from 'pg';

function normalize(connectionString) {
  return connectionString.replace(
    /([?&])sslmode=(prefer|require|verify-ca)(?=(&|$))/i,
    '$1sslmode=verify-full'
  );
}

// Synthetic addresses only. A real customer domain must never match.
const TEST_EMAIL_PATTERNS = [
  /^probe\d+@example\.com$/i,
  /^browser\d+@example\.com$/i,
  /^test\d+@example\.com$/i,
  /@example\.(com|org|net)$/i,
  /\.test$/i,
  /^(user|admin|alice|bob)@(example\.(com|org|net)|test)$/i,
];

const isTestEmail = (email) => TEST_EMAIL_PATTERNS.some((re) => re.test(email));

async function main() {
  const yes = process.argv.includes('--yes');

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: normalize(process.env.DATABASE_URL),
  });
  await client.connect();

  try {
    const { rows } = await client.query(`
      SELECT u.id, u.email, u.created_at,
             count(l.id)::int AS links,
             count(s.id)::int AS sessions
        FROM users u
        LEFT JOIN links l    ON l.user_id = u.id
        LEFT JOIN sessions s ON s.user_id = u.id
       GROUP BY u.id, u.email, u.created_at
       ORDER BY u.created_at
    `);

    const targets = rows.filter((row) => isTestEmail(row.email));
    const keepers = rows.filter((row) => !isTestEmail(row.email));

    console.log('\n=== will be removed ===');
    if (targets.length === 0) {
      console.log('  (none)');
    }
    for (const row of targets) {
      console.log(
        `  ${row.email.padEnd(38)} ${String(row.links).padStart(3)} links  ` +
          `${String(row.sessions).padStart(2)} sessions`
      );
    }

    console.log('\n=== will be kept ===');
    if (keepers.length === 0) {
      console.log('  (none)');
    }
    for (const row of keepers) {
      console.log(`  ${row.email.padEnd(38)} ${String(row.links).padStart(3)} links`);
    }

    if (targets.length === 0) return;

    const totalLinks = targets.reduce((sum, r) => sum + r.links, 0);

    if (!yes) {
      console.log(
        `\nDry run. Would remove ${targets.length} test account(s) and ${totalLinks} link(s).`
      );
      console.log('Re-run with --yes to proceed.');
      return;
    }

    // Cascades clear sessions and detach links (links.user_id is ON DELETE
    // SET NULL), but a link left with no owner and no token becomes an
    // orphan, which is exactly what we are trying to avoid. Delete the
    // throwaway links explicitly instead.
    const ids = targets.map((r) => r.id);

    const deletedLinks = await client.query(
      `DELETE FROM links
        WHERE user_id = ANY($1::bigint[])`,
      [ids]
    );
    console.log(`\nDeleted ${deletedLinks.rowCount} link(s).`);

    const deletedSessions = await client.query(
      `DELETE FROM sessions WHERE user_id = ANY($1::bigint[])`,
      [ids]
    );
    console.log(`Deleted ${deletedSessions.rowCount} session(s).`);

    const deletedUsers = await client.query(
      `DELETE FROM users WHERE id = ANY($1::bigint[])`,
      [ids]
    );
    console.log(`Deleted ${deletedUsers.rowCount} account(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Prune failed:', err.message);
  process.exit(1);
});