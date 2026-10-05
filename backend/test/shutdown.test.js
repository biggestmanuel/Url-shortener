/**
 * Graceful shutdown.
 *
 * Windows terminates a process unconditionally on SIGTERM, so a real signal
 * never reaches a Node handler there. A preload therefore emits the signal
 * in-process instead: argv[1] is still server.js, so the handler really is
 * registered, and it runs exactly as it would on Linux.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const preloadPath = join(tmpdir(), 'linkly-shutdown-test.mjs');

const PRELOAD = `
process.env.PORT = process.env.LINKLY_TEST_PORT ?? '3096';
setTimeout(() => {
  console.log('LISTENERS:' + process.listenerCount('SIGTERM'));
  process.emit('SIGTERM');
  // If the drain hangs, the forced-exit path must still fire.
  setTimeout(() => { console.log('NEVER_EXITED'); process.exit(9); }, 8000);
}, 3500);
`;

const run = () =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', pathToFileURL(preloadPath).href, 'server.js'],
      {
        cwd: join(here, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, LINKLY_TEST_PORT: '3096' },
      }
    );

    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: 'TIMEOUT', out });
    }, 20000);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });

test('SIGTERM drains the server and closes the database pool', async (t) => {
  writeFileSync(preloadPath, PRELOAD);
  t.after(() => rmSync(preloadPath, { force: true }));

  const { code, out } = await run();

  assert.match(out, /LISTENERS:1/, 'a SIGTERM handler must be registered');
  assert.match(out, /SIGTERM received, closing server/, 'shutdown must be announced');
  assert.doesNotMatch(out, /Error closing the database pool/);
  assert.doesNotMatch(out, /Graceful shutdown timed out/, 'must not fall through to the hard exit');
  assert.equal(code, 0, `expected a clean exit, got ${code}`);
});

test('a second signal does not re-enter shutdown', async (t) => {
  // Two signals in quick succession must not run the drain twice, which would
  // call server.close() on an already-closing server and log a confusing error.
  writeFileSync(
    preloadPath,
    `
    process.env.PORT = process.env.LINKLY_TEST_PORT ?? '3095';
    setTimeout(() => {
      process.emit('SIGTERM');
      process.emit('SIGTERM');
      setTimeout(() => { console.log('NEVER_EXITED'); process.exit(9); }, 8000);
    }, 3500);
    `
  );
  t.after(() => rmSync(preloadPath, { force: true }));

  const { code, out } = await run();

  const shutdowns = (out.match(/SIGTERM received, closing server/g) ?? []).length;
  assert.equal(shutdowns, 1, 'shutdown must be idempotent');
  assert.doesNotMatch(out, /ERR_SERVER_NOT_RUNNING/);
  assert.equal(code, 0);
});
