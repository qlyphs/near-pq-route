/** Quantus addresses (SS58 prefix 189, `qz…`) over 32-byte account IDs (0x hex). */
import { asAccountId, type AccountId } from '@qlyphs/sdk';
import { ss58Decode, ss58Encode } from './ss58.ts';

const PREFIX = 189;

function toHex(b: Uint8Array): string {
  return '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
function fromHex(h: string): Uint8Array {
  return Uint8Array.from(h.slice(2).match(/../g) ?? [], (x) => parseInt(x, 16));
}

/** Addresses already shown: lists render the same few accounts on every refresh. */
const shown = new Map<string, string>();

/** The `qz…` address of a 0x account ID; falls back to the ID itself if it cannot be encoded. */
export function toAddress(accountId: string): string {
  let address = shown.get(accountId);
  if (address !== undefined) return address;
  try {
    address = ss58Encode(fromHex(accountId), PREFIX);
  } catch {
    address = accountId;
  }
  if (shown.size >= 5_000) shown.clear();
  shown.set(accountId, address);
  return address;
}

/** Accepts a `qz…` address or a 0x account ID and returns the canonical account ID. */
export function toAccountId(value: string): AccountId {
  const text = value.trim();
  if (!text) throw new Error('Enter an address');
  if (text.startsWith('0x')) return asAccountId(text.toLowerCase());
  try {
    const id = ss58Decode(text, PREFIX);
    if (ss58Encode(id, PREFIX) !== text) throw Error();
    return asAccountId(toHex(id));
  } catch {
    throw new Error('Not a Quantus address (qz…) or account ID (0x…)');
  }
}
