/** SS58 addresses in plain TypeScript: BLAKE2b-512 (RFC 7693) and base58, nothing else.
 * @polkadot/util-crypto does the same but ships its WebAssembly build (about 170 KB compressed)
 * into every page that shows an address; these few functions are all the app needs. */

// BLAKE2b over 32-bit halves: each 64-bit word is two entries, low half first.
const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);
// Message word order per round (rounds 10 and 11 repeat 0 and 1), doubled into half-word indexes.
const SIGMA = Uint8Array.from(
  [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
    11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
    7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
    9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
    2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
    12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
    13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
    6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
    10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
  ],
  (x) => x * 2,
);

const v = new Uint32Array(32);
const m = new Uint32Array(32);

/** v[a] += v[b], over 64 bits. */
function add(a: number, b: number) {
  const lo = v[a]! + v[b]!;
  v[a + 1] = v[a + 1]! + v[b + 1]! + (lo >= 0x1_0000_0000 ? 1 : 0);
  v[a] = lo;
}
/** v[a] += m[x], over 64 bits. */
function addWord(a: number, x: number) {
  const lo = v[a]! + m[x]!;
  v[a + 1] = v[a + 1]! + m[x + 1]! + (lo >= 0x1_0000_0000 ? 1 : 0);
  v[a] = lo;
}

function mix(a: number, b: number, c: number, d: number, x: number, y: number) {
  add(a, b);
  addWord(a, x);
  // d = (d ^ a) >>> 32
  let lo = v[d]! ^ v[a]!;
  let hi = v[d + 1]! ^ v[a + 1]!;
  v[d] = hi;
  v[d + 1] = lo;
  add(c, d);
  // b = (b ^ c) >>> 24
  lo = v[b]! ^ v[c]!;
  hi = v[b + 1]! ^ v[c + 1]!;
  v[b] = (lo >>> 24) ^ (hi << 8);
  v[b + 1] = (hi >>> 24) ^ (lo << 8);
  add(a, b);
  addWord(a, y);
  // d = (d ^ a) >>> 16
  lo = v[d]! ^ v[a]!;
  hi = v[d + 1]! ^ v[a + 1]!;
  v[d] = (lo >>> 16) ^ (hi << 16);
  v[d + 1] = (hi >>> 16) ^ (lo << 16);
  add(c, d);
  // b = (b ^ c) >>> 63
  lo = v[b]! ^ v[c]!;
  hi = v[b + 1]! ^ v[c + 1]!;
  v[b] = (hi >>> 31) ^ (lo << 1);
  v[b + 1] = (lo >>> 31) ^ (hi << 1);
}

function compress(h: Uint32Array, block: Uint8Array, length: number, last: boolean) {
  for (let i = 0; i < 16; i++) {
    v[i] = h[i]!;
    v[i + 16] = IV[i]!;
  }
  v[24] = v[24]! ^ (length >>> 0);
  v[25] = v[25]! ^ Math.floor(length / 0x1_0000_0000);
  if (last) {
    v[28] = ~v[28]!;
    v[29] = ~v[29]!;
  }
  for (let i = 0; i < 32; i++)
    m[i] = block[4 * i]! | (block[4 * i + 1]! << 8) | (block[4 * i + 2]! << 16) | (block[4 * i + 3]! << 24);
  for (let r = 0; r < 12; r++) {
    const s = r * 16;
    mix(0, 8, 16, 24, SIGMA[s]!, SIGMA[s + 1]!);
    mix(2, 10, 18, 26, SIGMA[s + 2]!, SIGMA[s + 3]!);
    mix(4, 12, 20, 28, SIGMA[s + 4]!, SIGMA[s + 5]!);
    mix(6, 14, 22, 30, SIGMA[s + 6]!, SIGMA[s + 7]!);
    mix(0, 10, 20, 30, SIGMA[s + 8]!, SIGMA[s + 9]!);
    mix(2, 12, 22, 24, SIGMA[s + 10]!, SIGMA[s + 11]!);
    mix(4, 14, 16, 26, SIGMA[s + 12]!, SIGMA[s + 13]!);
    mix(6, 8, 18, 28, SIGMA[s + 14]!, SIGMA[s + 15]!);
  }
  for (let i = 0; i < 16; i++) h[i] = h[i]! ^ v[i]! ^ v[i + 16]!;
}

/** BLAKE2b with a 64-byte digest and no key. */
export function blake2b512(data: Uint8Array): Uint8Array {
  const h = IV.slice();
  h[0] = h[0]! ^ 0x01010040;
  const block = new Uint8Array(128);
  let offset = 0;
  // The last block is compressed with the final flag, even when it is full or the input is empty.
  while (data.length - offset > 128) {
    block.set(data.subarray(offset, offset + 128));
    offset += 128;
    compress(h, block, offset, false);
  }
  block.fill(0);
  block.set(data.subarray(offset));
  compress(h, block, data.length, true);
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i++) out[i] = h[i >> 2]! >>> (8 * (i & 3));
  return out;
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}

export function base58Decode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    let carry = ALPHABET.indexOf(char);
    if (carry < 0) throw new Error('Not base58');
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes.reverse()]);
}

const SS58PRE = new TextEncoder().encode('SS58PRE');

function prefixBytes(format: number): number[] {
  return format < 64 ? [format] : [((format & 0b1111_1100) >> 2) | 0b0100_0000, (format >> 8) | ((format & 0b11) << 6)];
}
function checksum(payload: Uint8Array): Uint8Array {
  const input = new Uint8Array(SS58PRE.length + payload.length);
  input.set(SS58PRE);
  input.set(payload, SS58PRE.length);
  return blake2b512(input).subarray(0, 2);
}

/** The SS58 address of a 32-byte account ID under network `format`. */
export function ss58Encode(id: Uint8Array, format: number): string {
  if (id.length !== 32) throw new Error('An account ID has 32 bytes');
  const payload = Uint8Array.from([...prefixBytes(format), ...id]);
  const sum = checksum(payload);
  return base58Encode(Uint8Array.from([...payload, ...sum]));
}

/** The 32-byte account ID of an SS58 address of network `format`; throws on any other address. */
export function ss58Decode(address: string, format: number): Uint8Array {
  const bytes = base58Decode(address);
  const prefix = prefixBytes(format);
  if (bytes.length !== prefix.length + 32 + 2 || prefix.some((b, i) => bytes[i] !== b)) throw new Error('Not an address of this network');
  const payload = bytes.subarray(0, prefix.length + 32);
  const sum = checksum(payload);
  if (sum[0] !== bytes[payload.length] || sum[1] !== bytes[payload.length + 1]) throw new Error('Bad address checksum');
  return bytes.slice(prefix.length, prefix.length + 32);
}
