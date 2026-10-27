// Test helper: the 32-byte ML-DSA-87 seed inside an OpenSSL private key file, so noble can sign as the wallet does.
import { execFileSync } from 'node:child_process';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';

// PrivateKeyInfo for id-ml-dsa-87 in OpenSSL's default "seed and expanded key" form (RFC 9881).
const PREFIX = Buffer.from('3082135e020100300b0609608648016503040313048213' + '4a308213460420', 'hex');

/** Returns a noble key pair { publicKey, secretKey } derived from the seed stored in `pemPath`. */
export function nobleKeyFromPem(pemPath) {
  const der = execFileSync(process.env.OPENSSL ?? 'openssl', ['pkey', '-in', pemPath, '-outform', 'DER'], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (der.length !== 4962 || !der.subarray(0, PREFIX.length).equals(PREFIX)) throw new Error('expected an OpenSSL ML-DSA-87 key with its seed');
  const seed = der.subarray(PREFIX.length, PREFIX.length + 32);
  return ml_dsa87.keygen(seed);
}
