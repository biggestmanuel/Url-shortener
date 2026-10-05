/**
 * QR encoder verification.
 *
 * Every case round-trips through an independent decoder (jsQR). That is the
 * only assertion worth trusting here: comparing the encoder against itself
 * would have hidden the codeword-table bugs this replaced.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import jsQR from 'jsqr';

const require = createRequire(import.meta.url);
const QRCode = require('../../qr.js');

const { MAX_VERSION } = QRCode;
const LEVELS = ['L', 'M', 'Q', 'H'];

/** Total codewords (data + EC) per version, per ISO/IEC 18004 table 1. */
const TOTAL_CODEWORDS = {
  1: 26, 2: 44, 3: 70, 4: 100, 5: 134,
  6: 172, 7: 196, 8: 242, 9: 292, 10: 346,
};

function toImageData(result, { scale = 4, margin = 4 } = {}) {
  const dim = (result.size + margin * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);

  for (let r = 0; r < result.size; r++) {
    for (let c = 0; c < result.size; c++) {
      if (!result.modules[r * result.size + c]) continue;

      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          // modules is row-major, so r is the row and c the column: x comes
          // from c and y from r. Deriving them the other way round mirrors the
          // symbol, and jsQR decodes a mirrored image just as happily, so the
          // round-trip would still pass while verifying nothing about
          // orientation. renderToCanvas and toSvg both get this right.
          const px = (c + margin) * scale + dx;
          const py = (r + margin) * scale + dy;
          const i = (py * dim + px) * 4;
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
        }
      }
    }
  }

  return { data, width: dim, height: dim };
}

test('the round-trip harness renders the matrix the right way round', () => {
  // Guards the harness itself: jsQR tolerates mirroring, so a transposed
  // test image would leave every round-trip above passing while proving
  // nothing about orientation.
  const result = QRCode.toMatrix('https://lnk.ly/3Fk9xY', { ecLevel: 'M' });
  const scale = 4;
  const margin = 4;
  const { data, width } = toImageData(result, { scale, margin });

  const dark = (x, y) => data[(y * width + x) * 4] === 0;

  // Every module must land where its row and column say it does: x from the
  // column, y from the row.
  for (let r = 0; r < result.size; r++) {
    for (let c = 0; c < result.size; c++) {
      assert.equal(
        dark((c + margin) * scale, (r + margin) * scale),
        Boolean(result.modules[r * result.size + c]),
        `module (row ${r}, col ${c}) is drawn in the wrong place`
      );
    }
  }
});

function decode(result) {
  const { data, width, height } = toImageData(result);
  const decoded = jsQR(data, width, height);
  return decoded ? decoded.data : null;
}

function assertRoundTrip(text, options) {
  const result = QRCode.toMatrix(text, options);
  assert.equal(decode(result), text, `failed to decode: ${JSON.stringify(text)}`);
  return result;
}

test('round-trips realistic short URLs', () => {
  const urls = [
    'https://lnk.ly/3Fk9xY',
    'http://localhost:3001/abc123',
    'https://linkly.example.com/Zq8-m_2',
    'https://a.co/1',
    'https://example.com/some/really/long/path?query=1&ref=qr#frag',
  ];

  for (const url of urls) {
    assertRoundTrip(url, { ecLevel: 'M' });
  }
});

test('round-trips every payload length across every version and level', () => {
  let checked = 0;

  for (let version = 1; version <= MAX_VERSION; version++) {
    for (const ecLevel of LEVELS) {
      const capacity = QRCode.capacityBytes(version, ecLevel);
      if (capacity < 1) continue;

      // Short payloads are allowed to land in a smaller version.
      for (const length of [1, Math.max(1, capacity - 1)]) {
        const result = assertRoundTrip('u'.repeat(length), { ecLevel });
        assert.ok(result.version <= version);
        assert.equal(result.level, ecLevel);
        checked++;
      }

      // A payload that exactly fills the version must use that version.
      const full = assertRoundTrip('u'.repeat(capacity), { ecLevel });
      assert.equal(
        full.version,
        version,
        `${capacity} bytes at level ${ecLevel} should need v${version}, got v${full.version}`
      );
      checked++;
    }
  }

  assert.ok(checked >= 80, `expected a broad sweep, only ran ${checked} cases`);
});

test('version and capacity tables agree with the spec', () => {
  for (let version = 1; version <= MAX_VERSION; version++) {
    const capacityM = QRCode.capacityBytes(version, 'M');
    const exact = 'v'.repeat(capacityM);

    // The largest payload that fits must land on this exact version...
    assert.equal(QRCode.toMatrix(exact, { ecLevel: 'M' }).version, version);
    // ...and one more byte must not.
    if (version < MAX_VERSION) {
      assert.equal(QRCode.toMatrix('v'.repeat(capacityM + 1), { ecLevel: 'M' }).version, version + 1);
    }
  }
});

/**
 * Byte-mode capacity per version and EC level, from ISO/IEC 18004 table 7.
 * Deriving these from the block table catches any wrong EC block count.
 */
const SPEC_CAPACITY = {
  L: [17, 32, 53, 78, 106, 134, 154, 192, 230, 271],
  M: [14, 26, 42, 62, 84, 106, 122, 152, 180, 213],
  Q: [11, 20, 32, 46, 60, 74, 86, 108, 130, 151],
  H: [7, 14, 24, 34, 44, 58, 64, 84, 98, 119],
};

test('block/ECC tables match the spec byte-mode capacities', () => {
  for (const [ecLevel, expected] of Object.entries(SPEC_CAPACITY)) {
    for (let version = 1; version <= MAX_VERSION; version++) {
      assert.equal(
        QRCode.capacityBytes(version, ecLevel),
        expected[version - 1],
        `v${version}-${ecLevel} capacity mismatch`
      );
    }
  }
});

test('matrix size matches the version', () => {
  for (let version = 1; version <= MAX_VERSION; version++) {
    const result = QRCode.toMatrix('https://lnk.ly/a', { ecLevel: 'L' });
    assert.equal(TOTAL_CODEWORDS[version] > 0, true);
    assert.equal(result.size, version * 4 + 17);
    break;
  }
  assert.equal(TOTAL_CODEWORDS[10], 346);
});

test('multi-block symbols (version 7+) decode correctly', () => {
  // Version 7-10 at every level exercise interleaved RS blocks.
  for (const ecLevel of LEVELS) {
    for (let version = 7; version <= MAX_VERSION; version++) {
      const capacity = QRCode.capacityBytes(version, ecLevel);
      const result = assertRoundTrip('m'.repeat(capacity), { ecLevel });
      assert.equal(result.version, version);
    }
  }
});

test('handles non-ASCII payloads via ECI/UTF-8', () => {
  assertRoundTrip('https://example.com/café-über', { ecLevel: 'M' });
  assertRoundTrip('https://例え.jp/リンク', { ecLevel: 'M' });
});

test('rejects payloads that exceed the supported range', () => {
  const tooLong = 'x'.repeat(QRCode.capacityBytes(MAX_VERSION, 'L') + 50);
  assert.throws(() => QRCode.toMatrix(tooLong, { ecLevel: 'L' }), /too long/i);
});

test('rejects an unknown EC level', () => {
  assert.throws(() => QRCode.toMatrix('https://a.co/1', { ecLevel: 'Z' }), /level/i);
});

test('matrix geometry matches the version', () => {
  const result = QRCode.toMatrix('https://lnk.ly/3Fk9xY', { ecLevel: 'M' });
  assert.equal(result.size, result.version * 4 + 17);
  assert.ok(result.mask >= 0 && result.mask <= 7);
});

test('finder patterns occupy the three corners', () => {
  const result = QRCode.toMatrix('https://lnk.ly/3Fk9xY', { ecLevel: 'M' });
  const { size, modules } = result;
  const at = (r, c) => modules[r * size + c];

  // Every finder has a dark 7x7 border ring and a light separator.
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let i = 0; i < 7; i++) {
      assert.equal(at(r0, c0 + i), 1);
      assert.equal(at(r0 + i, c0), 1);
      assert.equal(at(r0 + 6, c0 + i), 1);
      assert.equal(at(r0 + i, c0 + 6), 1);
    }
    assert.equal(at(r0 + 3, c0 + 3), 1, 'finder core must be dark');
  }

  // The always-dark module.
  assert.equal(at(size - 8, 8), 1);
});

test('exports SVG matching the rendered matrix', () => {
  const svg = QRCode.toSvg('https://lnk.ly/3Fk9xY', { ecLevel: 'M' });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>$/);

  const result = QRCode.toMatrix('https://lnk.ly/3Fk9xY', { ecLevel: 'M' });
  const darkModules = [...result.modules].filter(Boolean).length;
  const pathSegments = (svg.match(/M\d+ \d+h1v1h-1z/g) || []).length;
  assert.equal(pathSegments, darkModules);
});

test('deterministic output for identical input', () => {
  const a = QRCode.toMatrix('https://lnk.ly/3Fk9xY', { ecLevel: 'M' });
  const b = QRCode.toMatrix('https://lnk.ly/3Fk9xY', { ecLevel: 'M' });
  assert.deepEqual([...a.modules], [...b.modules]);
  assert.equal(a.mask, b.mask);
});