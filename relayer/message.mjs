// Strict parsing of an execute request (signature ‖ 256-byte message), mirroring the vault's own checks.
import { MAX_TTL_BLOCKS, MSG_LEN, SIG_LEN, isAccountId } from '../sdk/vault.mjs';

export const REQUEST_LEN = SIG_LEN + MSG_LEN;
const MAGIC = Buffer.from('QLYP87N1');
const ID_FIELD = 64;
const U64_MAX = 0xffffffffffffffffn;

/** A request the relayer refuses. `status` is the HTTP status, `reason` a short public explanation. */
export class Refusal extends Error {
  constructor(status, reason) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

const refuse = (reason) => { throw new Refusal(400, reason); };

// Same rule as the contract: valid NEAR id, ASCII, zero padding after it.
function idAt(m, lenAt, at, name) {
  const len = m[lenAt];
  const field = m.subarray(at, at + ID_FIELD);
  if (len > ID_FIELD) refuse(`${name} length out of range`);
  if (field.subarray(len).some((b) => b !== 0)) refuse(`${name} padding is not zero`);
  const id = field.subarray(0, len).toString('latin1');
  if (!isAccountId(id)) refuse(`${name} is not a NEAR account id`);
  return id;
}

/**
 * Parses and checks everything that does not need the chain. `network` and `factory` come from the pinned
 * deployment. Throws a Refusal (400) on the first problem.
 */
export function parseRequest(body, { network, factory }) {
  if (!Buffer.isBuffer(body) || body.length !== REQUEST_LEN) refuse(`body must be exactly ${REQUEST_LEN} bytes`);
  const signature = body.subarray(0, SIG_LEN);
  const m = body.subarray(SIG_LEN);
  if (!m.subarray(0, 8).equals(MAGIC)) refuse('bad magic');
  const tag = Buffer.alloc(8);
  tag.write(network, 'ascii');
  if (!m.subarray(8, 16).equals(tag)) refuse(`network tag is not ${network}`);

  const vault = idAt(m, 16, 17, 'vault');
  const label = vault.slice(0, vault.length - factory.length - 1);
  // A direct child of the pinned factory, with the 16-hex label the factory derives.
  if (!vault.endsWith(`.${factory}`) || !/^[0-9a-f]{16}$/.test(label)) refuse('vault is not a direct child of the pinned factory');

  const action = m[81];
  if (action !== 0 && action !== 1) refuse('action must be 0 (NEAR) or 1 (ft_transfer)');
  const ftGasTgas = m[252];
  let token = null;
  if (action === 0) {
    // Same rule as the wallet: a NEAR transfer names no token and no token gas, in any byte.
    if (m[82] !== 0 || m.subarray(83, 147).some((b) => b !== 0) || ftGasTgas !== 0) refuse('NEAR transfers carry no token fields');
  } else {
    token = idAt(m, 82, 83, 'token');
    if (ftGasTgas < 10 || ftGasTgas > 100) refuse('ft_transfer gas must be 10 to 100 Tgas');
  }
  const receiver = idAt(m, 147, 148, 'receiver');
  if (receiver === vault) refuse('receiver is the vault');

  const amount = m.readBigUInt64LE(212) | (m.readBigUInt64LE(220) << 64n);
  if (amount === 0n) refuse('amount must be positive');
  const nonce = m.readBigUInt64LE(228);
  if (nonce === U64_MAX) refuse('nonce is exhausted');
  const expiry = m.readBigUInt64LE(236);
  const issued = m.readBigUInt64LE(244);
  if (expiry <= issued || expiry - issued > MAX_TTL_BLOCKS) refuse(`validity window must be 1 to ${MAX_TTL_BLOCKS} blocks`);

  if (m[253] || m[254] || m[255]) refuse('reserved bytes must be zero');

  return { signature, message: m, vault, action, token, receiver, amount, nonce, expiry, issued, ftGasTgas };
}
