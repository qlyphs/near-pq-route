// Unit checks of the demo's experiment verdicts (demo/src/verdicts.js): only the specific expected defense is
// "blocked"; timeouts, unfunded or missing senders, wrong nonces and other rejections are unverified; a success
// is reported as one. Also the exact token-unit formatting. Writes evidence/demo-unit.json.
import { writeFileSync } from 'node:fs';
import { ownerMintVerdict, deletedKeyVerdict, formatUnits, BLOCKED, SUCCEEDED, UNVERIFIED } from '../demo/src/verdicts.js';
import { followed, summarize, trackFor } from '../demo/public/follow.js';
import { Rpc } from '../demo/src/near.js';

const results = [];
let failures = 0;
const record = (name, ok, detail = '') => { results.push({ name, ok, detail }); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };
const owner = 'owner.release.testnet', token = 'token.release.testnet', key = 'ed25519:Deleted';
const ARGS = JSON.stringify({ receiver_id: owner, amount: '1000000000000000000000000000', op_id: '999999' });
const panic = (msg) => ({ Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${msg}` } } } } });
// A final owner-mint refusal shaped like the RPC answer, with knobs to break one piece of evidence at a time.
function mintTx({ status = 'FINAL', hash = 'H', txHash = 'H', signer = owner, receiver = token, method = 'mint', args = ARGS, receiptId = 'r1', link = 'r1', executor = token, failure = panic('only the Guardian can do this') } = {}) {
  const outcome = { transaction: { hash: txHash, signer_id: signer, receiver_id: receiver, actions: [{ FunctionCall: { method_name: method, args: Buffer.from(args).toString('base64') } }] },
    transaction_outcome: { outcome: { status: { SuccessReceiptId: link } } }, receipts_outcome: [{ id: receiptId, outcome: { executor_id: executor, status: failure } }] };
  if (status !== 'MISSING') outcome.final_execution_status = status;
  return { hash, ok: false, failure: 'x', outcome };
}
const typed = (account, pk) => ({ hash: 'H', ok: false, failure: 'rejected', outcome: null, rpcError: { data: { TxExecutionError: { InvalidTxError: { InvalidAccessKeyError: { AccessKeyNotFound: { account_id: account, public_key: pk } } } } } } });
const v = (r) => ownerMintVerdict(r, { owner, token, args: ARGS }).verdict;
const k = (r) => deletedKeyVerdict(r, { token, publicKey: key }).verdict;

record('owner mint refused by the token for the Guardian rule: blocked', v(mintTx()) === BLOCKED);
record('owner mint that succeeded: unexpected success', v({ ok: true, hash: 'H', outcome: {} }) === SUCCEEDED);
record('generic API failure: unverified', v(null) === UNVERIFIED);
record('timeout before any outcome: unverified', v({ ok: false, failure: 'request timed out', outcome: null }) === UNVERIFIED);
record('former owner account unfunded: unverified', v({ ok: false, failure: 'NotEnoughBalance', rpcError: { data: { TxExecutionError: { InvalidTxError: { NotEnoughBalance: {} } } } }, outcome: null }) === UNVERIFIED);
record('wrong nonce: unverified', v({ ok: false, failure: 'InvalidNonce', outcome: null }) === UNVERIFIED);
record('former owner key missing: unverified', v(typed(owner, 'ed25519:Owner')) === UNVERIFIED);
for (const [label, status] of [['missing', 'MISSING'], ['null', null], ['empty', ''], ['optimistic', 'EXECUTED_OPTIMISTIC']]) record(`final execution status ${label}: unverified`, v(mintTx({ status })) === UNVERIFIED);
record('evidence for another transaction hash: unverified', v(mintTx({ txHash: 'Other' })) === UNVERIFIED);
record('receipt without id or not linked to the transaction: unverified', v(mintTx({ receiptId: null })) === UNVERIFIED && v(mintTx({ link: 'r9' })) === UNVERIFIED);
record('untyped failure string containing the words: unverified', v(mintTx({ failure: { Failure: 'only the Guardian can do this' } })) === UNVERIFIED);
record('refusal for another reason (out of gas): unverified', v(mintTx({ failure: panic('Exceeded the prepaid gas') })) === UNVERIFIED);
record('action receipt run by another account: unverified', v(mintTx({ executor: 'someone.testnet' })) === UNVERIFIED);
record('another signer, method or arguments: unverified', v(mintTx({ signer: 'evil.testnet' })) === UNVERIFIED && v(mintTx({ method: 'handover' })) === UNVERIFIED && v(mintTx({ args: ARGS.replace('999999', '1') })) === UNVERIFIED);

record('deleted key refused with AccessKeyNotFound for this account and key: blocked', k(typed(token, key)) === BLOCKED);
record('deployment that succeeded: unexpected success', k({ ok: true, hash: 'H', outcome: {} }) === SUCCEEDED);
record('AccessKeyNotFound for another key: unverified', k(typed(token, 'ed25519:Other')) === UNVERIFIED);
record('AccessKeyNotFound for another account: unverified', k(typed('other.testnet', key)) === UNVERIFIED);
record('timeout or untyped error: unverified', k({ ok: false, failure: 'request timed out', outcome: null }) === UNVERIFIED && k(null) === UNVERIFIED);

// The followed operation keeps its identity through other visitors' operations.
const A = 'a'.repeat(64), B = 'b'.repeat(64);
record('A applied, B now active: A reported applied', JSON.stringify(followed(A, { active: { proposal_hash: B, status: 'queued' }, last: { proposal_hash: A, status: 'applied' } })) === JSON.stringify({ mode: 'terminal', status: 'applied' }));
record('A failed, B now active: A reported failed', followed(A, { active: { proposal_hash: B, status: 'queued' }, last: { proposal_hash: A, status: 'failed' } }).status === 'failed');
record('B applied after A failed: A not reported applied', followed(A, { active: null, last: { proposal_hash: B, status: 'applied' } }).status === 'unavailable');
record('A in neither active nor last: unavailable', followed(A, { active: { proposal_hash: B, status: 'queued' }, last: null }).mode === 'unavailable');
record('A still active: followed as active', followed(A, { active: { proposal_hash: A, status: 'queued' }, last: null }).mode === 'active');

// The plain summary says only what each line's checks establish; the progress track never shows stages an outcome does not prove.
const NINE = ['Guardian has no access keys', 'Target has no access keys', 'Guardian runs the reproducible build', 'Target runs a reviewed build', 'Guardian config bytes match', 'Guardian state agrees', 'Target is guarded by this Guardian, no owner', 'Creation audited on chain', 'Cutover audited on chain'];
const report = (over = {}) => NINE.map((name) => ({ name, status: over[name] ?? 'pass' }));
record('summary: all pass gives four passing lines', summarize(report()).every(([, st]) => st === 'pass'));
{
  const s = summarize(report({ 'Target has no access keys': 'fail' }));
  record('summary: a key on the token fails its line', s[0][1] === 'fail');
  record('summary: the admin line claims only the binding and the audits', /names this Guardian as admin/.test(s[3][0]) && !/only admin/.test(s[3][0]));
}
record('summary: an unreadable check is unverified, not a pass', summarize(report({ 'Creation audited on chain': 'unverified' }))[3][1] === 'unverified');
record('track: applied marks every stage done', trackFor('applied').join() === 'ok,ok,ok,ok');
record('track: canceled shows neither the delay nor the execution as done', trackFor('canceled').join() === 'ok,,,bad');
record('track: expired shows the delay elapsed but no execution', trackFor('expired').join() === 'ok,ok,,bad');
record('track: failed shows an attempted execution', trackFor('failed').join() === 'ok,ok,ok,bad');
record('track: unavailable infers no history', trackFor('unavailable').join() === ',,,bad');

record('100 GDEMO formats from base units', formatUnits(100n * 10n ** 18n, 18) === '100');
record('fractional and large amounts format exactly', formatUnits(1234500000000000000n, 18) === '1.2345' && formatUnits(10n ** 27n, 18) === '1,000,000,000' && formatUnits(100n, 18) === '0.0000000000000001');


// RPC failover: a rate limit or server error moves to the next URL whatever its body; a transaction is never resent.
{
  const realFetch = globalThis.fetch;
  const answers = (list) => { const calls = []; globalThis.fetch = async (url) => { calls.push(url); const [status, body] = list[Math.min(calls.length - 1, list.length - 1)]; return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }); }; return calls; };
  const ok = { jsonrpc: '2.0', id: 'g', result: { fine: true } };
  let calls = answers([[503, { message: 'Service unavailable' }], [200, ok]]);
  record('rpc: HTTP 503 with a JSON body moves to the next URL', (await new Rpc(['a', 'b']).call('block', {})).fine === true && calls.join() === 'a,b');
  calls = answers([[429, { message: 'Too Many Requests' }], [200, ok]]);
  record('rpc: HTTP 429 with a JSON body moves to the next URL', (await new Rpc(['a', 'b']).call('block', {})).fine === true && calls.join() === 'a,b');
  calls = answers([[200, { jsonrpc: '1.0', id: 'other', result: { fine: true } }]]);
  record('rpc: wrong version or id is an error, not a result', await new Rpc(['a']).call('block', {}).then(() => false, () => true));
  calls = answers([[200, { hello: 1 }]]);
  record('rpc: a body that is not a JSON-RPC answer is an error, not a result', await new Rpc(['a']).call('block', {}).then(() => false, () => true));
  calls = answers([[503, 'down'], [200, ok]]);
  record('rpc: send_tx is never resent after a server error', await new Rpc(['a', 'b']).call('send_tx', {}).then(() => false, () => true) && calls.length === 1);
  globalThis.fetch = realFetch;
}

writeFileSync('evidence/demo-unit.json', JSON.stringify({ suite: 'demo.unit', results }, null, 2) + '\n');
console.log(`${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
