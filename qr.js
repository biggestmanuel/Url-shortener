/**
 * Linkly — zero-dependency QR Code generator (ISO/IEC 18004).
 *
 * Supports versions 1-10 across all four error-correction levels, byte mode
 * with UTF-8 (announced via ECI when the payload is not pure ASCII), correct
 * Reed-Solomon block interleaving, BCH format/version information, remainder
 * bits, and penalty-scored mask selection.
 *
 * Loads as a classic script (window.QRCode) so index.html keeps working from
 * file:// with no build step, and as a CommonJS module for tests.
 */
(function (root, factory) {
  'use strict';

  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.QRCode = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_VERSION = 10;

  /**
   * Per version and EC level:
   *   [ecCodewordsPerBlock, group1Blocks, group1DataCodewords,
   *    group2Blocks, group2DataCodewords]
   *
   * Source: ISO/IEC 18004 tables 13-22.
   */
  const EC_BLOCKS = {
    1: { L: [7, 1, 19, 0, 0], M: [10, 1, 16, 0, 0], Q: [13, 1, 13, 0, 0], H: [17, 1, 9, 0, 0] },
    2: { L: [10, 1, 34, 0, 0], M: [16, 1, 28, 0, 0], Q: [22, 1, 22, 0, 0], H: [28, 1, 16, 0, 0] },
    3: { L: [15, 1, 55, 0, 0], M: [26, 1, 44, 0, 0], Q: [18, 2, 17, 0, 0], H: [22, 2, 13, 0, 0] },
    4: { L: [20, 1, 80, 0, 0], M: [18, 2, 32, 0, 0], Q: [26, 2, 24, 0, 0], H: [16, 4, 9, 0, 0] },
    5: { L: [26, 1, 108, 0, 0], M: [24, 2, 43, 0, 0], Q: [18, 2, 15, 2, 16], H: [22, 2, 11, 2, 12] },
    6: { L: [18, 2, 68, 0, 0], M: [16, 4, 27, 0, 0], Q: [24, 4, 19, 0, 0], H: [28, 4, 15, 0, 0] },
    7: { L: [20, 2, 78, 0, 0], M: [18, 4, 31, 0, 0], Q: [18, 2, 14, 4, 15], H: [26, 4, 13, 1, 14] },
    8: { L: [24, 2, 97, 0, 0], M: [22, 2, 38, 2, 39], Q: [22, 4, 18, 2, 19], H: [26, 4, 14, 2, 15] },
    9: { L: [30, 2, 116, 0, 0], M: [22, 3, 36, 2, 37], Q: [20, 4, 16, 4, 17], H: [24, 4, 12, 4, 13] },
    10: { L: [18, 2, 68, 2, 69], M: [26, 4, 43, 1, 44], Q: [24, 6, 19, 2, 20], H: [28, 6, 15, 2, 16] },
  };

  const ALIGNMENT_POSITIONS = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50],
  };

  // Trailing bits that pad the data region after the last codeword.
  const REMAINDER_BITS = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 };

  const EC_LEVEL_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

  const PAD_BYTES = [0xec, 0x11];
  const FORMAT_MASK = 0b101010000010010;
  const VERSION_GENERATOR = 0b1111100100101;
  const FORMAT_GENERATOR = 0b10100110111;

  // --- Galois field GF(256), primitive polynomial 0x11d ----------------

  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);

  (function initGaloisField() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      EXP[i + 255] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /** Generator polynomial (x-a^0)(x-a^1)...(x-a^(degree-1)). */
  function rsGeneratorPoly(degree) {
    let poly = new Uint8Array([1]);

    for (let i = 0; i < degree; i++) {
      const next = new Uint8Array(poly.length + 1);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }

    return poly;
  }

  /** Reed-Solomon error-correction codewords for one block. */
  function rsEncode(data, ecCount) {
    const generator = rsGeneratorPoly(ecCount);
    const remainder = new Uint8Array(ecCount);

    for (let i = 0; i < data.length; i++) {
      const factor = data[i] ^ remainder[0];
      remainder.copyWithin(0, 1);
      remainder[ecCount - 1] = 0;
      for (let j = 0; j < ecCount; j++) {
        remainder[j] ^= gfMul(generator[j + 1], factor);
      }
    }

    return remainder;
  }

  // --- Bit buffer ------------------------------------------------------

  function BitBuffer() {
    this.bits = [];
  }

  BitBuffer.prototype.write = function write(value, length) {
    for (let i = length - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 1);
    }
  };

  BitBuffer.prototype.writeBytes = function writeBytes(bytes) {
    for (let i = 0; i < bytes.length; i++) {
      this.write(bytes[i], 8);
    }
  };

  BitBuffer.prototype.length = function length() {
    return this.bits.length;
  };

  BitBuffer.prototype.toBytes = function toBytes(byteLength) {
    const out = new Uint8Array(byteLength);
    for (let i = 0; i < byteLength; i++) {
      let byte = 0;
      for (let j = 0; j < 8; j++) {
        byte = (byte << 1) | (this.bits[i * 8 + j] || 0);
      }
      out[i] = byte;
    }
    return out;
  };

  // --- Capacity maths --------------------------------------------------

  function dataCodewords(version, level) {
    const [, g1Blocks, g1Data, g2Blocks, g2Data] = EC_BLOCKS[version][level];
    return g1Blocks * g1Data + g2Blocks * g2Data;
  }

  /** Largest byte-mode payload that fits, accounting for mode + count header. */
  function capacityBytes(version, level, byteModeCountBits) {
    const countBits = byteModeCountBits || (version <= 9 ? 8 : 16);
    const headerBits = 4 + countBits;
    const availableBits = dataCodewords(version, level) * 8 - headerBits;
    return Math.max(0, Math.floor(availableBits / 8));
  }

  function utf8Bytes(text) {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(text);
    }
    // Node fallback.
    return Uint8Array.from(Buffer.from(text, 'utf8'));
  }

  function chooseVersion(byteLength, level, needsEci) {
    for (let version = 1; version <= MAX_VERSION; version++) {
      const countBits = version <= 9 ? 8 : 16;
      const headerBits = (needsEci ? 12 : 0) + 4 + countBits;
      if (headerBits + byteLength * 8 <= dataCodewords(version, level) * 8) {
        return version;
      }
    }
    return null;
  }

  /** Builds the final interleaved codeword stream for a symbol. */
  function buildCodewords(bytes, version, level, needsEci) {
    const [ecCount, g1Blocks, g1Data, g2Blocks, g2Data] = EC_BLOCKS[version][level];
    const capacity = dataCodewords(version, level);

    const buffer = new BitBuffer();
    if (needsEci) {
      buffer.write(0b0111, 4); // ECI mode
      buffer.write(26, 8); //     assignment 26 = UTF-8
    }
    buffer.write(0b0100, 4); // byte mode
    buffer.write(bytes.length, version <= 9 ? 8 : 16);
    buffer.writeBytes(bytes);

    const capacityBits = capacity * 8;
    buffer.write(0, Math.min(4, capacityBits - buffer.length())); // terminator

    while (buffer.length() % 8 !== 0) buffer.bits.push(0);

    let toggle = 0;
    while (buffer.length() < capacityBits) {
      buffer.write(PAD_BYTES[toggle], 8);
      toggle ^= 1;
    }

    const data = buffer.toBytes(capacity);

    // Split into blocks, compute EC per block, then interleave.
    const dataBlocks = [];
    const ecBlocks = [];
    let offset = 0;

    for (let i = 0; i < g1Blocks + g2Blocks; i++) {
      const size = i < g1Blocks ? g1Data : g2Data;
      const block = data.slice(offset, offset + size);
      offset += size;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, ecCount));
    }

    const interleaved = [];
    const longestData = Math.max(g1Data, g2Data);

    for (let i = 0; i < longestData; i++) {
      for (let b = 0; b < dataBlocks.length; b++) {
        if (i < dataBlocks[b].length) interleaved.push(dataBlocks[b][i]);
      }
    }
    for (let i = 0; i < ecCount; i++) {
      for (let b = 0; b < ecBlocks.length; b++) {
        interleaved.push(ecBlocks[b][i]);
      }
    }

    return interleaved;
  }

  // --- Matrix ----------------------------------------------------------

  function createMatrix(version) {
    const size = version * 4 + 17;
    return {
      version,
      size,
      modules: new Uint8Array(size * size),
      reserved: new Uint8Array(size * size),
    };
  }

  function set(m, r, c, value) {
    m.modules[r * m.size + c] = value ? 1 : 0;
  }

  function reserve(m, r, c) {
    m.reserved[r * m.size + c] = 1;
  }

  function isReserved(m, r, c) {
    return m.reserved[r * m.size + c] === 1;
  }

  function drawFunctionPatterns(m) {
    const size = m.size;

    // Finder patterns with their separators.
    const finderOrigins = [
      [0, 0],
      [0, size - 7],
      [size - 7, 0],
    ];

    for (const [row, col] of finderOrigins) {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || r >= size || c < 0 || c >= size) continue;

          const ring =
            (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
            (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6));
          const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;

          set(m, r, c, ring || core ? 1 : 0);
          reserve(m, r, c);
        }
      }
    }

    // Timing patterns.
    for (let i = 8; i < size - 8; i++) {
      const dark = i % 2 === 0 ? 1 : 0;
      set(m, 6, i, dark);
      reserve(m, 6, i);
      set(m, i, 6, dark);
      reserve(m, i, 6);
    }

    // Alignment patterns, skipping the three that would collide with finders.
    const positions = ALIGNMENT_POSITIONS[m.version];
    for (const r of positions) {
      for (const c of positions) {
        const overlapsFinder =
          (r <= 8 && c <= 8) ||
          (r <= 8 && c >= size - 9) ||
          (r >= size - 9 && c <= 8);
        if (overlapsFinder) continue;

        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0;
            set(m, r + dr, c + dc, dark);
            reserve(m, r + dr, c + dc);
          }
        }
      }
    }

    // The always-dark module.
    set(m, size - 8, 8, 1);
    reserve(m, size - 8, 8);

    // Reserve both copies of the format information.
    for (let i = 0; i <= 8; i++) {
      if (i === 6) continue; // timing pattern
      reserve(m, 8, i);
      reserve(m, i, 8);
    }
    for (let i = 0; i < 8; i++) {
      reserve(m, 8, size - 1 - i);
      reserve(m, size - 1 - i, 8);
    }

    // Reserve version information (versions 7 and up).
    if (m.version >= 7) {
      for (let i = 0; i < 18; i++) {
        const r = Math.floor(i / 3);
        const c = i % 3;
        reserve(m, r, size - 11 + c);
        reserve(m, size - 11 + c, r);
      }
    }
  }

  function drawFormatInfo(m, level, mask) {
    const bits = formatInfoBits(level, mask);

    for (let i = 0; i < 15; i++) {
      const dark = (bits >>> i) & 1;
      const size = m.size;

      // Copy 1, around the top-left finder. Note bits 6 and 8 sit on
      // opposite axes from what the layout symmetry suggests.
      if (i < 6) set(m, 8, i, dark);
      else if (i === 6) set(m, 7, 8, dark);
      else if (i === 7) set(m, 8, 8, dark);
      else if (i === 8) set(m, 8, 7, dark);
      else set(m, 14 - i, 8, dark);

      // Copy 2: the top-right row and the bottom-left column. This run
      // stops one row short of the dark module at (size-8, 8).
      if (i < 8) set(m, 8, size - 1 - i, dark);
      else set(m, size - 15 + i, 8, dark);
    }
  }

  function drawVersionInfo(m) {
    if (m.version < 7) return;

    let rem = m.version;
    for (let i = 0; i < 12; i++) {
      rem = (rem << 1) ^ ((rem >>> 11) * VERSION_GENERATOR);
    }
    const bits = (m.version << 12) | rem;
    const size = m.size;

    for (let i = 0; i < 18; i++) {
      const dark = (bits >>> i) & 1;
      const r = Math.floor(i / 3);
      const c = i % 3;
      set(m, r, size - 11 + c, dark);
      set(m, size - 11 + c, r, dark);
    }
  }

  function formatInfoBits(level, mask) {
    const data = (EC_LEVEL_BITS[level] << 3) | mask;
    let rem = data;

    for (let i = 0; i < 10; i++) {
      rem = (rem << 1) ^ ((rem >>> 9) * FORMAT_GENERATOR);
    }

    return ((data << 10) | rem) ^ FORMAT_MASK;
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  /** Zigzag placement of codewords plus remainder bits, skipping function areas. */
  function placeCodewords(m, codewords) {
    const size = m.size;
    const totalBits = codewords.length * 8 + REMAINDER_BITS[m.version];

    let bitIndex = 0;
    let upward = true;

    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // skip the vertical timing column

      for (let step = 0; step < size; step++) {
        const row = upward ? size - 1 - step : step;

        for (let offset = 0; offset < 2; offset++) {
          const col = right - offset;
          if (isReserved(m, row, col)) continue;

          let bit = 0;
          if (bitIndex < totalBits) {
            const byte = codewords[bitIndex >> 3];
            bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex & 7))) & 1;
          }
          set(m, row, col, bit);
          bitIndex++;
        }
      }

      upward = !upward;
    }
  }

  /** Returns a copy of the matrix with one mask pattern applied to the data region. */
  function applyMask(m, maskIndex) {
    const fn = MASKS[maskIndex];
    const size = m.size;
    const clone = {
      version: m.version,
      size: m.size,
      modules: new Uint8Array(m.modules),
      reserved: m.reserved,
    };

    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!isReserved(m, r, c) && fn(r, c)) {
          clone.modules[r * size + c] ^= 1;
        }
      }
    }

    return clone;
  }

  const FINDER_LIKE_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const FINDER_LIKE_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];

  /** ISO/IEC 18004 mask penalty rules 1-4. Lower is better. */
  function penalty(modules, size) {
    let score = 0;

    // Rule 1: runs of five or more same-coloured modules.
    for (let dir = 0; dir < 2; dir++) {
      for (let a = 0; a < size; a++) {
        let runColor = dir === 0 ? modules[a * size] : modules[a];
        let runLength = 1;

        for (let b = 1; b < size; b++) {
          const value = dir === 0 ? modules[a * size + b] : modules[b * size + a];
          if (value === runColor) {
            runLength++;
          } else {
            if (runLength >= 5) score += 3 + (runLength - 5);
            runColor = value;
            runLength = 1;
          }
        }
        if (runLength >= 5) score += 3 + (runLength - 5);
      }
    }

    // Rule 2: 2x2 blocks of one colour.
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = modules[r * size + c];
        if (
          v === modules[r * size + c + 1] &&
          v === modules[(r + 1) * size + c] &&
          v === modules[(r + 1) * size + c + 1]
        ) {
          score += 3;
        }
      }
    }

    // Rule 3: finder-like 1:1:3:1:1 sequences.
    for (let dir = 0; dir < 2; dir++) {
      for (let a = 0; a < size; a++) {
        for (let b = 0; b + 11 <= size; b++) {
          let matchesA = true;
          let matchesB = true;

          for (let k = 0; k < 11; k++) {
            const value = dir === 0 ? modules[a * size + b + k] : modules[(b + k) * size + a];
            if (value !== FINDER_LIKE_A[k]) matchesA = false;
            if (value !== FINDER_LIKE_B[k]) matchesB = false;
          }

          if (matchesA) score += 40;
          if (matchesB) score += 40;
        }
      }
    }

    // Rule 4: deviation from an even balance of dark and light.
    let dark = 0;
    for (let i = 0; i < modules.length; i++) dark += modules[i];
    const percent = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;

    return score;
  }

  // --- Public API ------------------------------------------------------

  /**
   * Encodes `text` and returns the final module matrix.
   * @returns {{version:number,size:number,mask:number,level:string,modules:Uint8Array}}
   */
  function toMatrix(text, options) {
    const level = (options && options.ecLevel) || 'M';
    if (!EC_BLOCKS[1][level]) {
      throw new Error(`Unknown QR error correction level: ${level}`);
    }

    const bytes = utf8Bytes(String(text));
    const needsEci = bytes.some((b) => b > 0x7f);

    const version = chooseVersion(bytes.length, level, needsEci);
    if (version === null) {
      throw new Error(
        `Text too long for a QR code (limit ${capacityBytes(MAX_VERSION, level)} bytes at level ${level})`
      );
    }

    const codewords = buildCodewords(bytes, version, level, needsEci);
    const base = createMatrix(version);

    drawFunctionPatterns(base);
    placeCodewords(base, codewords);

    // Try all eight masks and keep the least-penalised symbol.
    let bestModules = null;
    let bestScore = Infinity;
    let bestMask = 0;

    for (let mask = 0; mask < 8; mask++) {
      const candidate = applyMask(base, mask);
      drawFormatInfo(candidate, level, mask);
      if (base.version >= 7) drawVersionInfo(candidate);

      const score = penalty(candidate.modules, candidate.size);
      if (score < bestScore) {
        bestScore = score;
        bestMask = mask;
        bestModules = candidate;
      }
    }

    return {
      version,
      size: base.size,
      mask: bestMask,
      level,
      modules: bestModules.modules,
    };
  }

  function renderToCanvas(canvas, text, options) {
    const opts = options || {};
    const result = toMatrix(text, opts);
    const size = result.size;
    const margin = opts.margin === undefined ? 4 : opts.margin;
    const totalModules = size + margin * 2;
    const targetSize = opts.size || 220;
    const scale = Math.max(1, Math.floor(targetSize / totalModules));
    const canvasSize = totalModules * scale;

    canvas.width = canvasSize;
    canvas.height = canvasSize;

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = opts.bgColor || '#ffffff';
    ctx.fillRect(0, 0, canvasSize, canvasSize);
    ctx.fillStyle = opts.fgColor || '#000000';

    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (result.modules[r * size + c]) {
          ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
        }
      }
    }

    return result;
  }

  /** Vector export, using one merged path for every dark module. */
  function toSvg(text, options) {
    const opts = options || {};
    const result = toMatrix(text, opts);
    const size = result.size;
    const margin = opts.margin === undefined ? 4 : opts.margin;
    const dim = size + margin * 2;

    let path = '';
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (result.modules[r * size + c]) {
          path += `M${c + margin} ${r + margin}h1v1h-1z`;
        }
      }
    }

    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
      `shape-rendering="crispEdges" role="img">` +
      `<rect width="${dim}" height="${dim}" fill="${opts.bgColor || '#ffffff'}"/>` +
      `<path d="${path}" fill="${opts.fgColor || '#000000'}"/>` +
      `</svg>`
    );
  }

  return {
    MAX_VERSION,
    EC_LEVELS: Object.keys(EC_LEVEL_BITS),
    toMatrix,
    renderToCanvas,
    toSvg,
    capacityBytes,
  };
});