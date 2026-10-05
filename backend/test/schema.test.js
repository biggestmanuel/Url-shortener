/**
 * Schema and index hygiene.
 *
 * Both checks here are silent failures: nothing errors, the tests pass, and
 * the app just gets slower as rows accumulate. Each corresponds to a real
 * problem found by running EXPLAIN against a seeded table.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = async (rel) => (await readFile(path.join(root, rel), 'utf8')).replace(/\r\n?/g, '\n');

const schema = await read('backend/schema.sql');
const sessionsLib = await read('backend/lib/sessions.js');

/** Parses `create table if not exists <name> ( ... );` into { table: [columns] }. */
function parseTables(sql) {
  const tables = new Map();

  for (const m of sql.matchAll(
    /create table if not exists (\w+)\s*\(([\s\S]*?)\n\);/gi
  )) {
    const [, name, body] = m;

    const columns = [];
    const uniques = [];

    // Strip comments so a commented-out column is not counted.
    for (const raw of body.split('\n')) {
      const line = raw.replace(/--.*$/, '').trim();
      if (!line) continue;

      const col = /^(\w+)\s+(bigserial|bigint|integer|text|timestamptz|boolean)\b/i.exec(line);
      if (!col) continue;

      columns.push(col[1].toLowerCase());
      if (/\bunique\b/i.test(line)) uniques.push(col[1].toLowerCase());
    }

    tables.set(name, { columns, uniques });
  }

  return tables;
}

/** Parses `create [unique] index if not exists <name> on <table> (<cols>)`. */
function parseIndexes(sql) {
  const indexes = [];

  for (const m of sql.matchAll(
    /create (?:unique )?index if not exists (\w+)\s+on\s+(\w+)\s*\(([^)]*)\)/gi
  )) {
    const [, name, table, cols] = m;
    indexes.push({
      name,
      table,
      columns: cols
        .split(',')
        .map((c) => c.trim().replace(/\s+(asc|desc)$/i, '').toLowerCase()),
    });
  }

  return indexes;
}

const tables = parseTables(schema);
const indexes = parseIndexes(schema);

test('the schema parser actually found the tables', () => {
  // Guards this file against silently testing nothing: if the regexes stop
  // matching after a schema edit, every check below would pass vacuously.
  assert.ok(tables.size >= 5, `expected the main tables, parsed ${tables.size}`);
  for (const t of ['users', 'sessions', 'password_resets', 'email_verifications', 'links']) {
    assert.ok(tables.has(t), `schema.sql should define ${t}`);
  }
  assert.ok(indexes.length >= 5, `expected several indexes, parsed ${indexes.length}`);
});

test('no index merely duplicates a UNIQUE constraint', () => {
  // A `col text unique` constraint already creates a b-tree on that column.
  // Declaring a second index on the same column means every INSERT maintains
  // two identical trees for no query benefit — pure write overhead, on the
  // hottest writes in the app. sessions carried exactly this mistake: both
  // sessions_token_hash_idx and sessions_token_hash_key.
  const redundant = [];

  for (const index of indexes) {
    const table = tables.get(index.table);
    if (!table) continue;

    // A single-column index on a uniquely-constrained column is redundant.
    // Multi-column indexes can still be useful even if the leading column is
    // unique, so only flag the single-column case.
    if (index.columns.length === 1 && table.uniques.includes(index.columns[0])) {
      redundant.push(`${index.name} on ${index.table} (${index.columns[0]}) is already unique`);
    }
  }

  assert.deepEqual(
    redundant,
    [],
    `redundant indexes: ${redundant.join('; ')}. Drop them, or make the index multi-column.`
  );
});

test('no duplicate index definitions exist at all', () => {
  const seen = new Map();
  const duplicates = [];

  for (const index of indexes) {
    const key = `${index.table}(${index.columns.join(',')})`;
    if (seen.has(key)) duplicates.push(`${index.name} duplicates ${seen.get(key)}`);
    else seen.set(key, index.name);
  }

  assert.deepEqual(duplicates, []);
});

test('every predicate the maintenance sweeps use is indexed on that table', () => {
  // pruneExpiredSessions runs `DELETE FROM sessions WHERE expires_at <= now()`
  // on an interval. Unindexed, EXPLAIN over 20k sessions planned a Seq Scan
  // touching 10941 rows to find the expired ones — and the cost grows linearly
  // with retained logins, forever, in the background.
  //
  // The table matters: an index on password_resets(expires_at) says nothing
  // about sessions. An earlier version of this check collected every indexed
  // column across all tables and passed with no sessions index at all.
  const isIndexed = (table, column) =>
    indexes.some((i) => i.table === table && i.columns.includes(column));

  const swept = [
    ...sessionsLib.matchAll(/\bDELETE FROM (\w+)\s+WHERE\s+(\w+)\s*(?:<=|>=|<|>|=)/g),
  ].map((m) => ({ table: m[1].toLowerCase(), column: m[2].toLowerCase() }));

  assert.ok(swept.length > 0, 'expected a sweep predicate in lib/sessions.js to check');

  for (const { table, column } of swept) {
    assert.ok(
      isIndexed(table, column),
      `the maintenance sweep filters on ${table}.${column}, which has no index; ` +
        'it degrades into a full table scan as the table grows'
    );
  }
});

test('columns used for ordering have a usable index', () => {
  // A `ORDER BY created_at` over a table with only a user_id index forces a
  // full sort of every matching row. links_user_id_idx is declared
  // (user_id, created_at desc) precisely so the dashboard list needs no sort.
  const linkIndexes = indexes.filter((i) => i.table === 'links');

  const userIndex = linkIndexes.find((i) => i.columns[0] === 'user_id');
  assert.ok(userIndex, 'links needs a user_id index for the per-account dashboard');

  assert.ok(
    userIndex.columns.includes('created_at'),
    `links_user_id_idx should include created_at so the ORDER BY needs no sort; got (${userIndex.columns.join(', ')})`
  );
});

test('every foreign key has an index', () => {
  // Postgres does not create these for you, and the ON DELETE CASCADE from
  // users would otherwise scan the referencing table per deleted row.
  const missing = [];

  for (const m of schema.matchAll(
    /create table if not exists (\w+)\s*\(([\s\S]*?)\n\);/gi
  )) {
    const [, table, body] = m;

    for (const line of body.split('\n')) {
      const clean = line.replace(/--.*$/, '').trim();
      const fk = /^(\w+)\s+bigint\s+references\s+(\w+)/i.exec(clean);
      if (!fk) continue;

      const column = fk[1].toLowerCase();
      const covered = indexes.some(
        (i) => i.table === table && i.columns.includes(column)
      );

      if (!covered) missing.push(`${table}.${column}`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `foreign keys without an index: ${missing.join(', ')}. ` +
      'Deleting a user cascades and each delete would scan the child table.'
  );
});
