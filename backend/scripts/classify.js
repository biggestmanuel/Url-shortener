/**
 * Groups links by an obvious synthetic pattern so cleanup decisions are made
 * on evidence. Read-only.
 *
 * Usage:
 *   node scripts/classify.js
 */

import 'dotenv/config';
import pg from 'pg';

function normalize(connectionString) {
  return connectionString.replace(
    /([?&])sslmode=(prefer|require|verify-ca)(?=(&|$))/i,
    '$1sslmode=verify-full'
  );
}

// Each pattern maps a name to a predicate over destination_url.
const PATTERNS = [
  {
    name: 'k6-loadtest',
    test: (u) => /example\.com\/k6-vu-\d+-iter-\d+/.test(u),
  },
  {
    name: 'smoke-test',
    test: (u) => /(smoke-test|redirect-check|e2e-ui-check)/.test(u),
  },
  {
    name: 'api-probe',
    test: (u) => /(final-verify|visit-target|account-test|owned-)/.test(u),
  },
  {
    name: 'url-validation-probe',
    test: (u) => /^https:\/\/a\.co\//.test(u),
  },
  {
    name: 'example.com',
    test: (u) => /^https?:\/\/www\.example\.com(\/|$)/.test(u),
  },
];

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
    const { rows } = await client.query(
      `SELECT id, destination_url, user_id, owner_token, clicks
         FROM links
        WHERE code IS NOT NULL`
    );

    const buckets = new Map();
    const unclassified = [];

    for (const row of rows) {
      const match = PATTERNS.find((p) => p.test(row.destination_url));
      if (!match) {
        unclassified.push(row);
        continue;
      }

      const bucket = buckets.get(match.name) ?? { count: 0, clicks: 0, sample: row.destination_url, ids: [] };
      bucket.count++;
      bucket.clicks += row.clicks ?? 0;
      if (bucket.ids.length < 5) bucket.ids.push(row.id);
      buckets.set(match.name, bucket);
    }

    console.log('\n=== classified (candidates for cleanup) ===');
    for (const [name, bucket] of buckets) {
      console.log(`  ${name.padEnd(24)} ${String(bucket.count).padStart(3)} links, ${bucket.clicks} clicks`);
      console.log(`  ${' '.repeat(24)} sample: ${bucket.sample}`);
      console.log(`  ${' '.repeat(24)} ids: ${bucket.ids.join(', ')}${bucket.count > 5 ? ' ...' : ''}`);
    }

    console.log(`\n=== unclassified (DO NOT touch without asking) ===`);
    if (unclassified.length === 0) {
      console.log('  (none)');
    }
    for (const row of unclassified) {
      const owner = row.user_id ? 'account' : row.owner_token ? 'guest' : 'ORPHAN';
      console.log(
        `  id=${row.id}  ${String(owner).padEnd(8)} ${String(row.clicks).padStart(3)} clicks  ${row.destination_url.slice(0, 80)}`
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Classify failed:', err.message);
  process.exit(1);
});