// Compares the freshly built release Wasm with the hashes pinned for the testnet release. Run after build.sh.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const d = JSON.parse(readFileSync('deployments/guardian-qlyphs-guardian.json', 'utf8'));
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const pairs = [['build/guardian-testnet.wasm', d.guardian_sha256], ['build/token-v1.wasm', d.reviewed_target_sha256.v1], ['build/token-v2.wasm', d.reviewed_target_sha256.v2]];
let bad = 0;
for (const [f, want] of pairs) {
  const got = sha(f), ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'match' : 'DIFFERS'}  ${f}  ${got}${ok ? '' : `  (release: ${want})`}`);
}
if (bad) console.log('A different LLVM version builds working contracts but different bytes; the release was built with LLVM 23.1.4.');
process.exit(bad ? 1 : 0);
