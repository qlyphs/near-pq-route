// Unit checks of the demo's experiment verdicts (demo/src/verdicts.js): only the specific expected defense is
// "blocked"; timeouts, unfunded or missing senders, wrong nonces and other rejections are unverified; a success
// is reported as one. Also the exact token-unit formatting. Writes evidence/demo-unit.json.
import { writeFileSync } from 'node:fs';
import { ownerMintVerdict, deletedKeyVerdict, formatUnits, BLOCKED, SUCCEEDED, UNVERIFIED } from '../demo/src/verdicts.js';

const results = [];
let failures = 0;
const record = (name, ok, detail = '') => { results.push({ name, ok, detail }); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };
const owner = 'owner.release.testnet', token = 'token.release.testnet', key = 'ed25519:Deleted';
const mintTx = (receipts, signer = owner, receiver = token, method = 'mint', status = 'FINAL') => ({ hash: 'H', ok: false, failure: 'x', outcome: {
  final_execution_status: status, transaction: { signer_id: signer, receiver_id: receiver, actions: [{ FunctionCall: { method_name: method } }] }, receipts_outcome: receipts } });
const refusedBy = (executor, msg) => [{ id: 'r1', outcome: { executor_id: executor, status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${msg}` } } } } } } }];
const typed = (account, pk) => ({ hash: 'H', ok: false, failure: 'rejected', outcome: null, rpcError: { data: { TxExecutionError: { InvalidTxError: { InvalidAccessKeyError: { AccessKeyNotFound: { account_id: account, public_key: pk } } } } } } });
const v = (r) => ownerMintVerdict(r, { owner, token }).verdict;
const k = (r) => deletedKeyVerdict(r, { token, publicKey: key }).verdict;

record('owner mint refused by the token for the Guardian rule: blocked', v(mintTx(refusedBy(token, 'only the Guardian can do this'))) === BLOCKED);
record('owner mint that succeeded: unexpected success', v({ ok: true, hash: 'H', outcome: {} }) === SUCCEEDED);
record('generic API failure: unverified', v(null) === UNVERIFIED);
record('timeout before any outcome: unverified', v({ ok: false, failure: 'request timed out', outcome: null }) === UNVERIFIED);
record('former owner account unfunded: unverified', v({ ok: false, failure: '{"InvalidTxError":{"NotEnoughBalance":{}}}', rpcError: { data: { TxExecutionError: { InvalidTxError: { NotEnoughBalance: {} } } } }, outcome: null }) === UNVERIFIED);
record('wrong nonce: unverified', v({ ok: false, failure: 'InvalidNonce', outcome: null }) === UNVERIFIED);
record('former owner key missing: unverified', v(typed(owner, 'ed25519:Owner')) === UNVERIFIED);
record('mint refused for another reason (out of gas): unverified', v(mintTx(refusedBy(token, 'Exceeded the prepaid gas'))) === UNVERIFIED);
record('refusal from another account: unverified', v(mintTx(refusedBy('someone.testnet', 'only the Guardian can do this'))) === UNVERIFIED);
record('another call or signer: unverified', v(mintTx(refusedBy(token, 'only the Guardian can do this'), 'evil.testnet')) === UNVERIFIED && v(mintTx(refusedBy(token, 'only the Guardian can do this'), owner, token, 'handover')) === UNVERIFIED);
record('execution not final: unverified', v(mintTx(refusedBy(token, 'only the Guardian can do this'), owner, token, 'mint', 'EXECUTED_OPTIMISTIC')) === UNVERIFIED);

record('deleted key refused with AccessKeyNotFound for this account and key: blocked', k(typed(token, key)) === BLOCKED);
record('deployment that succeeded: unexpected success', k({ ok: true, hash: 'H', outcome: {} }) === SUCCEEDED);
record('AccessKeyNotFound for another key: unverified', k(typed(token, 'ed25519:Other')) === UNVERIFIED);
record('AccessKeyNotFound for another account: unverified', k(typed('other.testnet', key)) === UNVERIFIED);
record('timeout or untyped error: unverified', k({ ok: false, failure: 'request timed out', outcome: null }) === UNVERIFIED && k(null) === UNVERIFIED);

record('100 GDEMO formats from base units', formatUnits(100n * 10n ** 18n, 18) === '100');
record('fractional and large amounts format exactly', formatUnits(1234500000000000000n, 18) === '1.2345' && formatUnits(10n ** 27n, 18) === '1,000,000,000' && formatUnits(100n, 18) === '0.0000000000000001');

writeFileSync('evidence/demo-unit.json', JSON.stringify({ suite: 'demo.unit', results }, null, 2) + '\n');
console.log(`${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
