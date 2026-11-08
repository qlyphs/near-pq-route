// Which state the page shows for the operation it follows. The followed proposal never changes on its own: another
// visitor's operation becoming active does not replace it, and a result that is no longer readable is reported as
// unavailable rather than borrowed from another operation.
export function followed(hash, guardian) {
  if (!hash) return { mode: 'none' };
  if (guardian?.active?.proposal_hash === hash) return { mode: 'active', op: guardian.active, status: guardian.active.status };
  if (guardian?.last?.proposal_hash === hash) return { mode: 'terminal', status: guardian.last.status };
  return { mode: 'unavailable', status: 'unavailable' };
}

// The plain summary of the report: a line passes only if all its checks pass, fails if any fails, else unverified.
// Each line says only what its own checks establish; the overall answer is the report's ok.
export const PLAIN = [
  ['No keys on the token', ['Target has no access keys']],
  ['No keys on the Guardian', ['Guardian has no access keys']],
  ['Both run the reviewed, reproducible code', ['Guardian runs the reproducible build', 'Target runs a reviewed build', 'Guardian config bytes match']],
  ['The token names this Guardian as admin; creation and cutover check out on chain', ['Guardian state agrees', 'Target is guarded by this Guardian, no owner', 'Creation audited on chain', 'Cutover audited on chain']],
];
export function summarize(checks) {
  const by = Object.fromEntries(checks.map((c) => [c.name, c.status]));
  return PLAIN.map(([label, names]) => [label, names.every((n) => by[n] === 'pass') ? 'pass' : names.some((n) => by[n] === 'fail') ? 'fail' : 'unverified']);
}

// The progress track for a terminal outcome: only stages the outcome establishes are marked done.
// Stages: approved, delay, executed, settled. '' means not shown as done.
export function trackFor(status) {
  switch (status) {
    case 'applied': return ['ok', 'ok', 'ok', 'ok'];
    case 'failed': return ['ok', 'ok', 'ok', 'bad'];
    case 'expired': return ['ok', 'ok', '', 'bad'];
    case 'canceled': return ['ok', '', '', 'bad'];
    default: return ['', '', '', 'bad']; // unavailable: no history is inferred
  }
}
