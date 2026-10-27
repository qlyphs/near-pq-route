// Local ML-DSA-87 verification (Pure, FIPS 204) of a vault authorization, before any gas is spent.
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { CONTEXT, MSG_LEN, PK_LEN, SIG_LEN } from '../sdk/vault.mjs';

/** True only if `signature` is a valid ML-DSA-87 signature of `message` by `publicKey`, context qlyphs/near-vault/v1. */
export function verifyAuthorization(signature, message, publicKey) {
  if (signature.length !== SIG_LEN || message.length !== MSG_LEN || publicKey.length !== PK_LEN) return false;
  try {
    return ml_dsa87.verify(signature, message, publicKey, { context: CONTEXT }) === true;
  } catch {
    return false;
  }
}
