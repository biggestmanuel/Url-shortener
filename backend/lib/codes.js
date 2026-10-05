import crypto from 'node:crypto';

const BASE62_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

const CODE_REJECTION_SAMPLE_SIZE = 64;

/**
 * Rejection sampling avoids the modulo bias you get from
 * `byte % 62`, which would make the first few characters of a generated
 * code measurably more likely than the rest.
 */
export function randomBase62(length) {
  if (!Number.isInteger(length) || length <= 0) {
    throw new Error('length must be a positive integer');
  }

  const limit = 256 - (256 % BASE62_ALPHABET.length); // 248
  let out = '';

  while (out.length < length) {
    const bytes = crypto.randomBytes(CODE_REJECTION_SAMPLE_SIZE);
    for (let i = 0; i < bytes.length && out.length < length; i++) {
      if (bytes[i] < limit) {
        out += BASE62_ALPHABET[bytes[i] % BASE62_ALPHABET.length];
      }
    }
  }

  return out;
}

export function generateShortCode(length = 7) {
  return randomBase62(length);
}

export function isValidCode(value) {
  return typeof value === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(value);
}

export const ALIAS_PATTERN = /^[a-zA-Z0-9_-]{3,30}$/;