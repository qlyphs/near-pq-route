// Release gate: the exported entry points of each release Wasm must be exactly the reviewed set (docs/GUARDIAN.md).
import { readFileSync } from 'node:fs';

const allow = {
  guardian: 'cancel execute expire init on_result propose state',
  token: 'ft_balance_of ft_metadata ft_total_supply ft_transfer handover migrate mint new state upgrade',
};
const builds = [
  ...['sandbox', 'testnet', 'mainnet'].map((c) => [`build/guardian-${c}.wasm`, allow.guardian]),
  ['build/token-v1.wasm', allow.token], ['build/token-v2.wasm', allow.token],
];
let bad = 0;
for (const [file, want] of builds) {
  const exports = WebAssembly.Module.exports(new WebAssembly.Module(readFileSync(file)));
  const funcs = exports.filter((e) => e.kind === 'function').map((e) => e.name).sort().join(' ');
  const other = exports.filter((e) => e.kind !== 'function' && e.name !== 'memory').map((e) => `${e.kind}:${e.name}`);
  const ok = funcs === want && other.length === 0;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'BAD '} ${file}: ${funcs}${other.length ? ` + ${other.join(',')}` : ''}`);
}
process.exit(bad ? 1 : 0);
