// Deploys build/pq87_near.wasm on a local NEAR sandbox, checks every vector and records gas in evidence/gas.json.
import { Worker } from 'near-workspaces';
import { readFileSync, writeFileSync } from 'node:fs';

const MAX_GAS = 300n * 10n ** 12n; // the per-call prepaid gas ceiling
const tera = (g) => Number(BigInt(g) * 1000n / 10n ** 12n) / 1000;

const { vectors } = JSON.parse(readFileSync('fixtures/vectors.json', 'utf8'));
const hex = (s) => Buffer.from(s, 'hex');
const encode = (v) => {
  const ctx = hex(v.context);
  return new Uint8Array(Buffer.concat([hex(v.pk), hex(v.signature), Buffer.from([ctx.length]), ctx, hex(v.message)]));
};

// The function-call receipt is the one that runs the contract; the first outcome is the tx-to-receipt conversion.
const callGas = (r) => r.receipts_outcomes[0].outcome.gas_burnt;
const stages = (r) => r.logs.map((l) => { const [k, g] = l.split(' '); return { stage: k, gas: Number(g), tgas: tera(g) }; });

const worker = await Worker.init();
try {
  const root = worker.rootAccount;
  const contract = await root.devDeploy('build/pq87_near.wasm');
  const out = { sandbox: 'near-sandbox 2.6.2 (nearcore)', wasm_sha256: process.env.WASM_SHA256 ?? null, vectors: [], profile: null, bench: [] };
  let failures = 0;

  for (const v of vectors) {
    const r = await root.callRaw(contract, 'verify', encode(v), { gas: MAX_GAS });
    const got = r.succeeded ? Buffer.from(r.SuccessValue, 'base64').toString() === '1' : null;
    const ok = got === v.valid;
    if (!ok) failures++;
    out.vectors.push({ name: v.name, expected: v.valid, got, ok, call_gas: callGas(r), call_tgas: tera(callGas(r)), tx_tgas: tera(r.gas_burnt), failure: r.failed ? r.Failure : undefined });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${v.name.padEnd(32)} expected=${v.valid} got=${got} call=${tera(callGas(r))} Tgas`);
  }

  const valid = vectors.find((v) => v.valid);
  const p = await root.callRaw(contract, 'verify_profile', encode(valid), { gas: MAX_GAS });
  out.profile = { ok: p.succeeded && Buffer.from(p.SuccessValue, 'base64').toString() === '1', call_tgas: tera(callGas(p)), stages: stages(p) };
  if (!out.profile.ok) failures++;
  console.log('profile', out.profile.ok ? 'PASS' : 'FAIL', out.profile.stages.map((s) => `${s.stage}=${s.tgas}`).join(' '));

  const ops = ['baseline', 'keccak-f1600', 'expand-A-entry', 'ntt', 'invntt', 'shake256-2592B'];
  for (let op = 0; op < ops.length; op++) {
    const r = await root.callRaw(contract, 'bench', new Uint8Array([op]), { gas: MAX_GAS });
    const [before, after] = stages(r);
    out.bench.push({ op: ops[op], tgas: Math.round((after.gas - before.gas) / 1e6) / 1e6 });
  }
  console.log('bench', out.bench.map((b) => `${b.op}=${b.tgas}`).join(' '));

  out.max_call_tgas = Math.max(...out.vectors.map((v) => v.call_tgas));
  out.fits_one_call = out.vectors.every((v) => v.failure === undefined) && out.max_call_tgas < 300;
  writeFileSync('evidence/gas.json', JSON.stringify(out, null, 2) + '\n');
  console.log(`max call ${out.max_call_tgas} Tgas of 300; fits one call: ${out.fits_one_call}; failures: ${failures}`);
  process.exitCode = failures ? 1 : 0;
} finally {
  await worker.tearDown();
}
