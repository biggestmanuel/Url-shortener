/**
 * Preflight check for a deployment.
 *
 *   node scripts/doctor.js            # warn only, exit 0
 *   node scripts/doctor.js --strict   # exit 1 if anything is wrong
 *   node scripts/doctor.js --strict --allow localhost
 *
 * Reports the settings that fail silently — the server starts, looks healthy,
 * and hands out links nobody can open — then confirms the database is reachable
 * and carries the expected schema.
 *
 * Exit codes are meant to be usable from a deploy script or CI:
 *   0  no problems (or not strict)
 *   1  problems found under --strict
 *   2  the database could not be reached or is missing schema
 */

import 'dotenv/config';
import pg from 'pg';

import { findConfigProblems, describeVariables, findFatalConfigProblems } from '../lib/config.js';

const strict = process.argv.includes('--strict');
const allowLoopback = process.argv.includes('--allow-localhost');

/** Tables and columns the running code depends on. */
const EXPECTED_SCHEMA = {
  users: ['id', 'email', 'password_hash', 'email_verified_at'],
  sessions: ['id', 'user_id', 'token_hash', 'expires_at'],
  password_resets: ['id', 'user_id', 'token_hash', 'purpose', 'expires_at', 'used_at'],
  email_verifications: ['id', 'user_id', 'token_hash', 'expires_at', 'used_at'],
  links: ['id', 'code', 'destination_url', 'clicks', 'user_id', 'owner_token', 'created_at'],
};

function normalize(connectionString) {
  return connectionString.replace(
    /([?&])sslmode=(prefer|require|verify-ca)(?=(&|$))/i,
    '$1sslmode=verify-full'
  );
}

const ok = (line) => console.log(`  ok       ${line}`);
const bad = (line, fatal = false) =>
  console.log(`  ${fatal ? 'FATAL  ' : 'PROBLEM'}  ${line}`);
const note = (line) => console.log(`  note     ${line}`);

function reportConfig() {
  const problems = findConfigProblems();

  console.log('\n=== configuration ===');

  // With NODE_ENV=production the server refuses to boot on some of these, so
  // doctor should say so rather than implying it is all advisory.
  const fatal = findFatalConfigProblems();
  const fatalVars = new Set(fatal.map((p) => p.variable));

  if (fatal.length > 0) {
    console.log(
      `\n  NODE_ENV=production. The server will REFUSE TO START until these are fixed:`
    );
    for (const { variable } of fatal) {
      console.log(`    - ${variable}`);
    }
    console.log('');
  }

  if (problems.length === 0) {
    ok('no configuration problems found');
    return 0;
  }

  const descriptions = describeVariables();
  const reported = new Set();

  for (const { variable, message } of problems) {
    const line = `${variable} ${message}`;

    // A localhost deployment is a legitimate choice; only insist loudly when
    // it is combined with an https origin.
    const ignorable =
      allowLoopback &&
      (message.includes('only reachable from this machine') ||
        message.includes('will only open on the machine'));

    if (ignorable) {
      note(`${line}  (allowed by --allow-localhost)`);
      continue;
    }

    bad(line, fatalVars.has(variable));
    reported.add(variable);
  }

  for (const variable of [...reported].sort()) {
    if (descriptions[variable]) console.log(`             (${variable} = ${descriptions[variable]})`);
  }

  if (fatalVars.size > 0) {
    console.log(
      '  The FATAL one(s) above stop a production boot. The rest do not stop the\n' +
        '  server: it will start, report healthy, and produce links nobody but you\n' +
        '  can open. Set them in backend/.env.'
    );
  } else {
    console.log(
      '\n  These do not stop the server. It will start, report healthy, and ' +
        'produce links\n  that nobody but you can open. Set them in backend/.env.'
    );
  }

  return reported.size;
}

async function reportDatabase() {
  console.log('\n=== database ===');

  if (!process.env.DATABASE_URL) {
    bad('DATABASE_URL is not set, so no query can run. See backend/.env.example.');
    return false;
  }

  // Never echo the connection string: it carries the password.
  const client = new pg.Client({ connectionString: normalize(process.env.DATABASE_URL) });

  try {
    await client.connect();
    ok('connected');
  } catch (err) {
    bad(`could not connect: ${err.code || err.message}`);
    console.log('             Check DATABASE_URL and that the host is reachable from here.');
    return false;
  }

  try {
    const { rows } = await client.query('select version() as v');
    // "PostgreSQL 18.6 (…)" — the banner already includes the name.
    const version = String(rows[0]?.v ?? '').split(' ')[1] || 'unknown';
    ok(`PostgreSQL ${version}`);

    let missing = 0;

    for (const [table, columns] of Object.entries(EXPECTED_SCHEMA)) {
      const { rows: cols } = await client.query(
        'select column_name from information_schema.columns where table_schema = current_schema() and table_name = $1',
        [table]
      );

      if (cols.length === 0) {
        bad(`table "${table}" does not exist`);
        console.log('             Run: npm --prefix backend run db:migrate');
        missing++;
        continue;
      }

      const present = new Set(cols.map((c) => c.column_name));
      const absent = columns.filter((c) => !present.has(c));

      if (absent.length > 0) {
        bad(`table "${table}" is missing column(s): ${absent.join(', ')}`);
        console.log('             Run: npm --prefix backend run db:migrate (it is idempotent)');
        missing++;
      } else {
        ok(`table "${table}" (${columns.length} columns)`);
      }
    }

    if (missing === 0) ok('schema matches what the running code expects');

    const { rows: counts } = await client.query(`
      SELECT
        (SELECT count(*) FROM links)                  AS links,
        (SELECT count(*) FROM users)                  AS users,
        (SELECT count(*) FROM sessions)               AS sessions,
        (SELECT count(*) FROM sessions WHERE expires_at <= now()) AS expired_sessions
    `);
    const row = counts[0];

    console.log('\n  contents:');
    console.log(`    links   : ${row.links}`);
    console.log(`    users   : ${row.users}`);
    console.log(`    sessions: ${row.sessions}  (${row.expired_sessions} expired, awaiting sweep)`);

    if (Number(row.sessions) > 0) {
      console.log(
        '    Sessions exist in the database. That is expected in normal use, ' +
          'but if you were\n    only running tests, clean up with: ' +
          'npm --prefix backend run db:prune-tests -- --yes'
      );
    }

    return missing === 0;
  } catch (err) {
    bad(`query failed: ${err.code || err.message}`);
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  console.log('Linkly deployment doctor');

  const configProblems = reportConfig();
  const fatalConfig = findFatalConfigProblems();
  const dbOk = await reportDatabase();

  console.log('\n=== summary ===');

  if (configProblems > 0) {
    console.log(`  ${configProblems} configuration problem(s).`);
  } else {
    ok('configuration looks complete');
  }

  if (!dbOk) {
    bad('database is not ready');
    process.exit(2);
  }
  ok('database is ready');

  if (fatalConfig.length > 0) {
    console.log(
      '\nRefusing to continue: NODE_ENV=production and the server would refuse to start.'
    );
    process.exit(1);
  }

  if (configProblems > 0 && strict) {
    console.log('\nRefusing to continue: --strict and configuration problems were found.');
    process.exit(1);
  }

  if (configProblems > 0) {
    console.log('\nNot fatal (no --strict). Re-run with --strict to fail on this.');
  } else {
    console.log('\nAll checks passed.');
  }
}

main().catch((err) => {
  console.error('Doctor failed:', err.message);
  process.exit(2);
});
