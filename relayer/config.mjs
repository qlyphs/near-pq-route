// Relayer settings from the environment, with the testnet-only guard.
import { readFileSync } from 'node:fs';
import { isAccountId } from '../sdk/vault.mjs';

const NEAR = 10n ** 24n;
const HOUR = 3600 * 1000;

const int = (env, name, fallback) => {
  const v = env[name] ?? String(fallback);
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a non-negative integer`);
  return Number(v);
};
const big = (env, name, fallback) => {
  const v = env[name] ?? String(fallback);
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a non-negative integer`);
  return BigInt(v);
};

/**
 * Reads the configuration. The pinned deployment must be testnet: anything else needs
 * RELAYER_ALLOW_NETWORK set to that exact network name, a deliberate step this code does not take for you.
 */
export function loadConfig(env = process.env) {
  const deployment = JSON.parse(readFileSync(env.RELAYER_DEPLOYMENT ?? new URL('../deployments/testnet.json', import.meta.url), 'utf8'));
  if (!isAccountId(deployment.factory) || !/^[a-z]{1,8}$/.test(deployment.network)) throw new Error('deployment manifest is malformed');
  if (deployment.network !== 'testnet' && env.RELAYER_ALLOW_NETWORK !== deployment.network) {
    throw new Error(`pinned deployment is ${deployment.network}; this relayer runs on testnet only`);
  }
  if (!isAccountId(env.RELAYER_ACCOUNT ?? '')) throw new Error('RELAYER_ACCOUNT must be a NEAR account id');
  if (!env.RELAYER_KEY_FILE) throw new Error('RELAYER_KEY_FILE is required');
  return {
    deployment,
    host: env.HOST ?? '127.0.0.1',
    port: int(env, 'PORT', 8787),
    rpcUrl: env.NEAR_RPC ?? 'https://test.rpc.fastnear.com',
    account: env.RELAYER_ACCOUNT,
    keyFile: env.RELAYER_KEY_FILE,
    // Prepaid price per gas unit counted against the cap. Testnet prepays receipts at 1e9 yocto/gas
    // (pessimistic price) even though it burns at 1e8, so this counts what is locked, not what is burnt.
    gasPriceYocto: big(env, 'RELAYER_GAS_PRICE_YOCTO', 10n ** 9n),
    spendCapYocto: big(env, 'RELAYER_SPEND_CAP_YOCTO', 3n * NEAR / 10n),
    vaultPerHour: int(env, 'RELAYER_VAULT_PER_HOUR', 10),
    ipPerHour: int(env, 'RELAYER_IP_PER_HOUR', 30),
    windowMs: HOUR,
    concurrency: int(env, 'RELAYER_CONCURRENCY', 4),
    queue: int(env, 'RELAYER_QUEUE', 32),
  };
}
