/**
 * Administrative commands for links that no principal can delete.
 *
 * Links created before accounts existed carry neither `user_id` nor
 * `owner_token`, so the HTTP API correctly refuses to delete them (only the
 * operator API_KEY can). This script is the operator path: it talks to the
 * database directly, so it is the right tool for the owner of the deployment
 * to take ownership of or remove legacy rows.
 *
 * Requires DATABASE_URL. Every mutating command prints what it will do and
 * needs --yes to proceed.
 *
 *   node scripts/links-admin.js list-orphans
 *   node scripts/links-admin.js claim <linkId> <email>
 *   node scripts/links-admin.js delete <linkId> --yes
 *   node scripts/links-admin.js delete-orphans --match <pattern> --yes
 */

import 'dotenv/config';
import pg from 'pg';

function normalize(connectionString) {
  return connectionString.replace(
    /([?&])sslmode=(prefer|require|verify-ca)(?=(&|$))/i,
    '$1sslmode=verify-full'
  );
}

// Flags that take a value, so `--match foo` parses the same as `--match=foo`.
const VALUE_FLAGS = new Set(['match']);

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);

    if (eq !== -1) {
      flags[name] = arg.slice(eq + 1);
      continue;
    }

    // A value flag consumes the next argument when it is not itself a flag.
    const next = argv[i + 1];
    if (VALUE_FLAGS.has(name) && next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }

  return { positional, flags };
}

async function connect() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: normalize(process.env.DATABASE_URL),
  });
  await client.connect();
  return client;
}

function confirm(flags, description) {
  if (flags.yes) return true;

  console.log(`\nAbout to ${description}`);
  console.log('Re-run with --yes to proceed.');

  // Non-interactive by design: this script must never be destructive by
  // accident just because stdin was attached to a pipe.
  return false;
}

async function listOrphans(client, match) {
  const params = [];
  let sql = `SELECT id, code, destination_url, clicks, created_at
               FROM links
              WHERE user_id IS NULL AND owner_token IS NULL`;

  if (match) {
    // Escape LIKE metacharacters so a pattern is matched literally.
    const escaped = String(match).replace(/([\\%_])/g, '\\$1');
    sql += ` AND destination_url LIKE '%' || $1 || '%' ESCAPE '\\'`;
    params.push(escaped);
  }

  sql += ' ORDER BY created_at DESC LIMIT 500';

  const { rows } = await client.query(sql, params);

  if (rows.length === 0) {
    console.log('\nNo orphan links found.');
    return;
  }

  console.log(`\n=== ${rows.length} orphan link(s) ===`);
  for (const row of rows) {
    console.log(
      `  id=${String(row.id).padEnd(7)} ${String(row.code).padEnd(10)} ` +
        `${String(row.clicks).padStart(4)} clicks  ${row.destination_url.slice(0, 70)}`
    );
  }
}

async function claim(client, linkId, email) {
  const { rows: users } = await client.query('SELECT id, email FROM users WHERE email = $1', [
    String(email).toLowerCase(),
  ]);

  if (users.length === 0) {
    console.error(`No account with email ${email}. Register it first.`);
    process.exit(1);
  }

  const user = users[0];

  // Only claim rows that are genuinely unowned, so this cannot steal a link.
  const { rows } = await client.query(
    `UPDATE links
        SET user_id = $1
      WHERE id = $2
        AND user_id IS NULL
        AND owner_token IS NULL
      RETURNING id, code, destination_url`,
    [user.id, linkId]
  );

  if (rows.length === 0) {
    console.error(`Link ${linkId} is already owned, or does not exist.`);
    process.exit(1);
  }

  console.log(`\nClaimed link ${rows[0].id} (${rows[0].code}) for ${user.email}.`);
  console.log(`  destination: ${rows[0].destination_url}`);
}

async function removeOne(client, linkId) {
  const { rows } = await client.query(
    `DELETE FROM links
      WHERE id = $1
        AND user_id IS NULL
        AND owner_token IS NULL
      RETURNING id, code, destination_url`,
    [linkId]
  );

  if (rows.length === 0) {
    console.error(
      `Link ${linkId} is owned by an account or guest token, or does not exist.`
    );
    console.error('Delete it through the API instead, so ownership is respected.');
    process.exit(1);
  }

  console.log(`\nDeleted link ${rows[0].id} (${rows[0].code}).`);
}

async function removeMatching(client, match, flags = {}) {
  const escaped = String(match).replace(/([\\%_])/g, '\\$1');

  const preview = await client.query(
    `SELECT count(*)::int AS n
       FROM links
      WHERE user_id IS NULL
        AND owner_token IS NULL
        AND destination_url LIKE '%' || $1 || '%' ESCAPE '\\'`,
    [escaped]
  );

  const count = preview.rows[0].n;
  if (count === 0) {
    console.error(`No orphan links match ${match}.`);
    process.exit(1);
  }

  const samples = await client.query(
    `SELECT id, destination_url
       FROM links
      WHERE user_id IS NULL
        AND owner_token IS NULL
        AND destination_url LIKE '%' || $1 || '%' ESCAPE '\\'
      ORDER BY id
      LIMIT 10`,
    [escaped]
  );

  console.log(`\n${count} orphan link(s) match ${match}:`);
  for (const row of samples.rows) {
    console.log(`  id=${row.id}  ${row.destination_url.slice(0, 70)}`);
  }
  if (count > samples.rows.length) {
    console.log(`  ...and ${count - samples.rows.length} more`);
  }

  if (!confirm(flags, `delete ${count} orphan link(s) matching "${match}"`)) {
    return;
  }

  const { rowCount } = await client.query(
    `DELETE FROM links
      WHERE user_id IS NULL
        AND owner_token IS NULL
        AND destination_url LIKE '%' || $1 || '%' ESCAPE '\\'`,
    [escaped]
  );

  console.log(`\nDeleted ${rowCount} link(s).`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;

  const client = await connect();

  try {
    switch (command) {
      case 'list-orphans':
        await listOrphans(client, flags.match);
        break;

      case 'claim': {
        const [linkId, email] = rest;
        if (!linkId || !email) {
          console.error('Usage: claim <linkId> <email>');
          process.exit(1);
        }
        await claim(client, linkId, email);
        break;
      }

      case 'delete': {
        const [linkId] = rest;
        if (!linkId) {
          console.error('Usage: delete <linkId> --yes');
          process.exit(1);
        }
        if (!confirm(flags, `delete orphan link ${linkId}`)) break;
        await removeOne(client, linkId);
        break;
      }

      case 'delete-orphans': {
        const pattern = flags.match;
        if (!pattern) {
          console.error('Usage: delete-orphans --match <substring> --yes');
          process.exit(1);
        }
        await removeMatching(client, pattern, flags);
        break;
      }

      default:
        console.log(
          'Usage:\n' +
            '  node scripts/links-admin.js list-orphans [--match <substring>]\n' +
            '  node scripts/links-admin.js claim <linkId> <email>\n' +
            '  node scripts/links-admin.js delete <linkId> --yes\n' +
            '  node scripts/links-admin.js delete-orphans --match <substring> --yes'
        );
        process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Command failed:', err.message);
  process.exit(1);
});