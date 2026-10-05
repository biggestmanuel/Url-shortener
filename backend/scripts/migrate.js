/**
 * Applies schema.sql to the configured database.
 *
 * Every statement in schema.sql is idempotent, so this is safe to re-run and
 * doubles as the upgrade path for databases created before owner tokens.
 *
 *   node scripts/migrate.js
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import 'dotenv/config';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, '..', 'schema.sql');

function normalizeConnectionString(connectionString) {
  return connectionString.replace(
    /([?&])sslmode=(prefer|require|verify-ca)(?=(&|$))/i,
    '$1sslmode=verify-full'
  );
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
    process.exit(1);
  }

  const sql = await readFile(schemaPath, 'utf8');
  const client = new pg.Client({
    connectionString: normalizeConnectionString(connectionString),
  });

  await client.connect();
  try {
    await client.query(sql);
    console.log('Schema applied.');

    const { rows } = await client.query(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'links'
        ORDER BY ordinal_position`
    );
    console.log('links columns:', rows.map((r) => r.column_name).join(', '));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});