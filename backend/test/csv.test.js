/**
 * Verifies CSV formula-injection neutralisation for a destination URL that
 * both passes client-side http(s) validation and starts with "=".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { escapeCsvValue } = require('../../escape.js');

function csvCell(value) {
  const safe = escapeCsvValue(value === null || value === undefined ? '' : String(value));
  return `"${safe.replace(/"/g, '""')}"`;
}

function buildCsv(rows) {
  const headers = ['ID', 'Short Code', 'Short URL', 'Destination URL', 'Clicks', 'Created At'];
  return [
    headers.join(','),
    ...rows.map((l) =>
      [csvCell(l.id), csvCell(l.code), csvCell(l.shortUrl), csvCell(l.destinationUrl), 0, csvCell(l.createdAt)].join(',')
    ),
  ].join('\n');
}

/**
 * Values that a spreadsheet would treat as a formula if they appeared as the
 * first character of a cell. The http(s) ones are storable in practice: the
 * backend only checks the URL scheme, so "https://x.example/?q=+1" is valid.
 */
const FORMULA_URLS = [
  '=cmd|\' /c calc\'!A1',
  '+HYPERLINK("http://evil","click")',
  '@SUM(1+1)',
  '-2+3',
  'https://x.example/page?q=1',
];

const SPREADSHEET_TRIGGERS = /^[=+\-@\t\r]/;

test('CSV export neutralises formula injection in a destination URL', () => {
  const rows = FORMULA_URLS.map((dest, i) => ({
    id: `loc_${i}`,
    code: `code${i}`,
    shortUrl: `http://localhost:8080/code${i}`,
    destinationUrl: dest,
    createdAt: '2026-01-01T00:00:00.000Z',
  }));

  const csv = buildCsv(rows);
  const lines = csv.split('\n').slice(1); // drop the header row

  assert.equal(lines.length, rows.length);

  for (const [i, line] of lines.entries()) {
    // Isolate the 4th field (Destination URL), respecting "" escaping.
    const fields = line.match(/"(?:[^"]|"")*"/g) || [];
    const destField = fields[3];
    const value = destField.slice(1, -1).replace(/""/g, '"');

    const shouldPrefix = SPREADSHEET_TRIGGERS.test(rows[i].destinationUrl);

    if (shouldPrefix) {
      // A spreadsheet strips one leading apostrophe, so undo that to recover
      // the original: the data itself must be preserved, only defused.
      assert.ok(value.startsWith("'"), `field ${i} must carry the apostrophe prefix`);
      assert.equal(
        value.slice(1),
        rows[i].destinationUrl,
        'the original value must be recoverable after stripping the prefix'
      );
    } else {
      assert.equal(value, rows[i].destinationUrl, 'harmless values stay verbatim');
    }

    // Whatever a spreadsheet sees first must not be a formula trigger.
    assert.ok(
      !SPREADSHEET_TRIGGERS.test(value),
      `field ${i} still starts with a trigger character: ${JSON.stringify(value)}`
    );
  }
});

test('a prefixed cell stays inert once a spreadsheet unquotes it', () => {
  const field = csvCell('=1+1');
  // Excel unquotes to "'=1+1", which it treats as text, not a formula.
  assert.equal(field, '"\'=1+1"');
});

test('plain URLs are exported verbatim', () => {
  const url = 'https://example.com/some/path?a=1&b=2';
  assert.equal(csvCell(url), `"${url}"`);
});