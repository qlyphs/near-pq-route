// Relayer settings from the environment, with the testnet-only guard.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAccountId } from '../sdk/vault.mjs';

const NEAR = 10n ** 24n;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

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
  if (env.RELAYER_GAS_PRICE_YOCTO !== undefined) throw new Error('RELAYER_GAS_PRICE_YOCTO was replaced by RELAYER_MAX_GAS_PRICE_YOCTO');
  const stateDir = env.RELAYER_STATE_DIR ?? fileURLToPath(new URL('./.state', import.meta.url));
  return {
    deployment,
    host: env.HOST ?? '127.0.0.1',
    port: int(env, 'PORT', 8787),
    rpcUrl: env.NEAR_RPC ?? 'https://test.rpc.fastnear.com',
    account: env.RELAYER_ACCOUNT,
    keyFile: env.RELAYER_KEY_FILE,
    // Highest gas price the spend bound assumes (cost.mjs). The relay refuses to sign while the current
    // price is above half of it. 1e9 yocto/gas is 10x the testnet price today and equals its receipt
    // purchase floor, so the default bound charges every gas unit at the price testnet prepays receipts at.
    maxGasPriceYocto: big(env, 'RELAYER_MAX_GAS_PRICE_YOCTO', 10n ** 9n),
    spendCapYocto: big(env, 'RELAYER_SPEND_CAP_YOCTO', 3n * NEAR / 10n),
    // The hard budget: the relayer does not start if its account could spend more than this (account.mjs).
    maxAccountSpendableYocto: big(env, 'RELAYER_MAX_ACCOUNT_SPENDABLE', 5n * NEAR / 10n),
    // Where the reserved spend survives restarts. One file per relayer account and network, one writer
    // per directory (lock.mjs).
    stateDir,
    stateFile: join(stateDir, `spend-${deployment.network}-${env.RELAYER_ACCOUNT}.json`),
    clearStaleLock: env.RELAYER_CLEAR_STALE_LOCK === '1',
    outcomeConcurrency: int(env, 'RELAYER_OUTCOME_CONCURRENCY', 4),
    outcomeQueue: int(env, 'RELAYER_OUTCOME_QUEUE', 32),
    outcomePerMinute: int(env, 'RELAYER_OUTCOME_PER_MINUTE', 60),
    outcomeGlobalPerMinute: int(env, 'RELAYER_OUTCOME_GLOBAL_PER_MINUTE', 600),
    vaultPerHour: int(env, 'RELAYER_VAULT_PER_HOUR', 10),
    ipPerHour: int(env, 'RELAYER_IP_PER_HOUR', 30),
    windowMs: HOUR,
    outcomeWindowMs: MINUTE,
    concurrency: int(env, 'RELAYER_CONCURRENCY', 4),
    queue: int(env, 'RELAYER_QUEUE', 32),
  };
}
