'use client';
/** One transfer on the post-quantum route, followed step by step: QTC going to NEAR (a payment from the Qlyphs
 * wallet), or coming back to Quantus (withdrawals signed by this browser's NEAR accounts). Every step is drawn from
 * the saved payment or from a chain read, never from a timer. */
import { Button, Input } from '@qotc/ui';
import * as React from 'react';
import { toAddress } from '@/lib/address';
import { bestNumber, blockNumberOf } from '@/lib/pq-route/chain';
import { controlFor, type Payment } from '@/lib/pq-route/payment';
import { ROUTE, mintPointer } from '@/lib/pq-route/route';
import { BackLink, Chip, ErrorNote, Out, Row, Steps, nearAccountLink, nearTxLink, qtc, short, when, type StepRow } from './parts';
import { WATCH_MS, type Batch, type Leaving, type Payments } from './use-route';

/** Confirmations of the lock transfer, read from the Quantus chain while the signers wait for them. */
function useConfirmations(blockHash: string | undefined, active: boolean): number | null {
  const [n, setN] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!blockHash || !active) return;
    let stop = false;
    const read = async () => {
      try { const [at, best] = await Promise.all([blockNumberOf(blockHash), bestNumber()]); if (!stop) setN(Math.max(0, best - at)); } catch { /* keep the last value */ }
    };
    void read(); const t = setInterval(read, 4000);
    return () => { stop = true; clearInterval(t); };
  }, [blockHash, active]);
  return n;
}
/** The mint transaction of a payment, from the route service's pointer: a link for the reader to check on NEAR,
 * nothing the page relies on. */
function useMintTx(p: Payment | null): string | null {
  const [tx, setTx] = React.useState<string | null>(null);
  const dep = p?.depositId, want = !!dep && (p?.stage === 'minted' || p?.stage === 'settled');
  React.useEffect(() => {
    if (!want) return;
    let stop = false;
    void mintPointer(dep!).then((m) => { if (!stop && m) setTx(m.tx); }).catch(() => { /* no link */ });
    return () => { stop = true; };
  }, [want, dep, p?.stage]);
  return tx;
}

/** A payment's five steps from its saved stage. `running`: this page is working on it now; otherwise the open
 * step is shown as paused. */
function paymentSteps(p: Payment, conf: number | null, mintTx: string | null, running: boolean): StepRow[] {
  const s = p.stage, need = ROUTE.confirmations, order = ['new', 'sending', 'sent', 'located', 'signed', 'claimed', 'minted', 'settled'];
  const at = order.indexOf(s), past = (stage: Payment['stage']) => at > order.indexOf(stage);
  const live = (state: 'now' | 'act'): StepRow['state'] => (running ? state : 'paused');
  const final = past('claimed') || (s === 'claimed' && conf !== null && conf >= need);
  return [
    { title: 'Lock in the Quantus safe', scheme: 'ML-DSA-87',
      state: past('sent') ? 'done' : s === 'sent' ? live('now') : live('act'),
      sub: past('sent') ? `Signed by your wallet · ${short(p.txHash ?? '', 10, 6)}` : s === 'sent' ? 'Sent. Finding its block on Quantus…' : running ? 'Approve the transfer in your wallet.' : 'Not sent yet.' },
    { title: 'Sign the destination', scheme: 'ML-DSA-87',
      state: past('located') ? 'done' : s === 'located' ? live('act') : 'ahead',
      sub: past('located') ? `Signed by your wallet · ${p.signature ? `${((p.signature.replace(/^0x/, '').length) / 2).toLocaleString('en-US')} bytes` : 'signature kept'}`
        : s === 'located' ? (running ? 'Approve in your wallet: it signs where your QTC goes on NEAR.' : 'Your wallet still has to sign where the QTC goes.') : undefined },
    { title: 'Final on Quantus',
      state: final ? 'done' : s === 'signed' || s === 'claimed' ? live('now') : 'ahead',
      share: s === 'claimed' && conf !== null ? conf / need : null,
      sub: final ? `${need} blocks deep` : s === 'claimed' && conf !== null ? `Block ${conf} of ${need}. The signers wait for all of them.` : s === 'signed' ? 'Sending your signature to the signers…' : s === 'claimed' ? `The signers wait for ${need} blocks on Quantus.` : undefined },
    { title: '2 of 3 signers approve, NEAR verifies', scheme: 'ML-DSA-87 ×2',
      state: past('claimed') ? 'done' : final ? live('now') : 'ahead',
      sub: past('claimed') ? <>The contract checked both signatures and created your QTC.{mintTx && <> <Out href={nearTxLink(mintTx)}>Mint</Out></>}</>
        : final ? 'Each signer checks your transfer on Quantus, then signs. About a minute.' : undefined },
    { title: p.delivery === 'direct' ? 'Delivered to your NEAR account' : 'Delivered in NEAR Intents', scheme: 'ML-DSA-65',
      state: s === 'settled' ? 'done' : s === 'minted' ? live('now') : 'ahead',
      sub: s === 'settled' ? <>{inMeteor(p) ? `At finalized block ${(p.terms.checkedAt ?? 0).toLocaleString('en-US')}, this account had one ML-DSA-65 full-access key and no other access keys.` : 'In an account with a single key.'} <Out href={nearAccountLink(p.terms.request.account)}>{short(p.terms.request.account, 10, 8)}</Out></>
        : s === 'minted' ? 'Reading the mint on NEAR…' : undefined },
  ];
}

/** A payment from the Qlyphs wallet, followed until the QTC is delivered. */
export function PaymentView({ id, pay, onBack, onBringBack }: { id: string; pay: Payments; onBack: () => void; onBringBack: (from: 'browser' | 'meteor') => void }) {
  const entry = pay.saved.find((s) => s.key === id);
  const p = entry?.p ?? null;
  const running = pay.busy === id;
  const conf = useConfirmations(p?.blockHash, p?.stage === 'claimed' || p?.stage === 'signed');
  const mintTx = useMintTx(p);
  const [hash, setHash] = React.useState('');
  // What needs no wallet resumes on its own after a reload; a step that opens the wallet waits for a click.
  const resumed = React.useRef(false);
  React.useEffect(() => {
    if (resumed.current || running || !p || !pay.account || !pay.onRoute) return;
    if (p.stage === 'signed' || p.stage === 'claimed' || p.stage === 'minted') { resumed.current = true; void pay.run(id); }
  }, [p, running, pay, id]);

  if (entry && !p) return (
    <div className="arrive">
      <BackLink onClick={onBack} label="Bridge" />
      <ErrorNote>This browser: a saved payment cannot be read. Do not pay this request again before checking your wallet&apos;s history.</ErrorNote>
    </div>
  );
  if (!p) return (
    <div className="arrive" aria-busy="true">
      <BackLink onClick={onBack} label="Bridge" />
      <div className="h-7 w-40 animate-pulse rounded-md bg-muted/60" />
      <div className="mt-5 h-56 animate-pulse rounded-xl bg-muted/40" />
    </div>
  );
  const mine = pay.mine(p), meteor = mine && inMeteor(p), amount = qtc(p.terms.request.amount), control = controlFor(p), done = p.stage === 'settled';
  const error = pay.errors[id];
  return (
    <div className="arrive">
      <BackLink onClick={onBack} label={mine ? 'Bridge' : 'Pay'} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="pq-route" className="text-2xl font-semibold tracking-[-0.04em]">{mine ? `${amount} QTC to ${meteor ? 'Meteor' : 'NEAR'}` : `Paying ${amount} QTC`}</h1>
        <Chip tone={done ? 'done' : running ? 'progress' : 'warn'}>{done ? 'Done' : running ? 'In progress' : 'Paused'}</Chip>
      </div>
      <p className="mt-1.5 text-pretty text-sm leading-relaxed text-muted-foreground">
        {done ? (mine ? (meteor ? (p.delivery === 'intents' ? `QTC is credited to ${p.terms.request.account} in the testnet Intents verifier. Use Meteor to authorize withdrawal.`
          : `NEAR Intents refused the deposit: the QTC is on ${p.terms.request.account}'s own bridge-token balance. Use Meteor to redeem it.`) : 'Your QTC is on NEAR, in an account only this browser controls.') : 'Paid. The QTC is in the account they asked for.')
          : 'Every step below is authorized by a post-quantum signature. You can leave this page: the transfer resumes from where it stopped.'}
      </p>
      <div className="mt-5"><Steps rows={paymentSteps(p, conf, mintTx, running)} /></div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {control === 'recover' && !running && (
        <div className="settle mt-4 space-y-2 rounded-xl border border-warning/40 bg-warning/[0.06] p-3">
          <p className="text-sm">Your wallet did not answer. Check its history: did {amount} QTC leave it?</p>
          <div className="flex gap-2">
            <Input value={hash} onChange={(e) => setHash(e.target.value)} placeholder="Yes: paste the transfer's hash, 0x…" spellCheck={false} aria-label="Hash of the transfer" />
            <Button variant="outline" disabled={!hash.trim()} onClick={() => void pay.continueWith(id, hash).then(() => setHash(''))}>Continue</Button>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void pay.forget(id).then(onBack)}>No, nothing left my wallet: cancel this transfer</Button>
        </div>
      )}
      <dl className="mt-5 space-y-2.5 border-t border-border/70 pt-4 text-sm">
        <Row label="You send">{amount} QTC</Row>
        <Row label={done ? 'Delivered' : mine ? 'You receive' : 'They receive'}>{amount} QTC</Row>
        <Row label="NEAR account"><Out href={nearAccountLink(p.terms.request.account)}>{short(p.terms.request.account, 10, 8)}</Out></Row>
        {!mine && p.terms.request.memo && <Row label="Note">{p.terms.request.memo}</Row>}
      </dl>
      <div className="mt-5 grid gap-2 sm:grid-cols-2">
        {done ? (
          <>
            <Button variant="primary" className="min-h-12" onClick={onBack}>{mine ? 'Bridge again' : 'Done'}</Button>
            {mine && <Button variant="outline" className="min-h-12" onClick={() => onBringBack(meteor ? 'meteor' : 'browser')}>Bring it back</Button>}
          </>
        ) : !running && (control === 'start' || control === 'resume') && pay.account && pay.onRoute ? (
          <Button variant="primary" className="min-h-12 sm:col-span-2" onClick={() => void pay.run(id)}>{p.stage === 'located' || control === 'start' ? 'Continue in your wallet' : 'Resume'}</Button>
        ) : !running && !pay.account ? (
          <Button variant="primary" className="min-h-12 sm:col-span-2" loading={pay.connecting} onClick={() => void pay.connect()}>Connect Qlyphs wallet to continue</Button>
        ) : null}
      </div>
    </div>
  );
}

/** QTC on its way back to Quantus: the withdrawals of one click, then the release from the safe. `leaving` is set
 * while this page is still signing them. */
export function ReturnView({ batch, leaving, now, onBack }: { batch: Batch | null; leaving: Leaving | null; now: number; onBack: () => void }) {
  const total = leaving?.total ?? batch?.outs.length ?? 0, signed = leaving ? leaving.done : total;
  const amount = leaving?.amount ?? batch?.amount ?? 0n, dest = leaving?.dest ?? batch?.dest ?? '';
  const signing = !!leaving && !leaving.error && leaving.done < leaving.total;
  const arrived = !signing && !!batch?.arrived && !leaving?.error;
  const blind = !!batch && batch.outs.every((o) => o.baseline === null), late = !!batch && now - batch.at > 15 * 60_000;
  const address = dest ? toAddress(dest) : '';
  const rows: StepRow[] = [
    { title: 'Withdraw from NEAR Intents', scheme: 'ML-DSA-65',
      state: signing ? 'now' : leaving?.error && signed < total ? 'paused' : 'done',
      sub: signing ? `Signed in this browser by your NEAR account's own key${total > 1 ? ` · ${signed + 1} of ${total}` : ''}. NEAR makes it final in a few seconds.`
        : <>Signed by your NEAR account, final on NEAR.{batch?.outs.map((o, i) => <React.Fragment key={o.tx}> <Out href={nearTxLink(o.tx)}>{total > 1 ? `Withdrawal ${i + 1}` : 'Withdrawal'}</Out></React.Fragment>)}</> },
    { title: '2 of 3 signers release it on Quantus', scheme: 'ML-DSA-87 ×2',
      state: arrived ? 'done' : signing || !batch ? 'ahead' : 'now',
      sub: arrived ? 'Released by the safe.' : signing || !batch ? undefined
        : late || blind ? 'Check your wallet balance: the release does not depend on this page.' : 'Each signer reads your withdrawal on NEAR, then signs the release. A few minutes.' },
    { title: 'Back in your Quantus wallet',
      state: arrived ? 'done' : 'ahead',
      sub: arrived ? `The balance of ${short(address, 8, 6)} went up by ${qtc(amount)} QTC.` : undefined },
  ];
  return (
    <div className="arrive">
      <BackLink onClick={onBack} label="Bridge" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="pq-route" className="text-2xl font-semibold tracking-[-0.04em]">{qtc(amount)} QTC to Quantus</h1>
        <Chip tone={arrived ? 'done' : leaving?.error ? 'warn' : 'progress'}>{arrived ? 'Done' : leaving?.error ? 'Stopped' : 'In progress'}</Chip>
      </div>
      <p className="mt-1.5 text-pretty text-sm leading-relaxed text-muted-foreground">
        {arrived ? 'Your QTC is back on Quantus.' : signing ? 'Keep this page open while your NEAR accounts sign.' : 'Nothing more to sign. You can leave this page: the release arrives in your wallet on its own.'}
      </p>
      <div className="mt-5"><Steps rows={rows} /></div>
      {leaving?.error && <ErrorNote>NEAR testnet: {leaving.error.replace(/^NEAR testnet:?\s*/i, '')} {signed > 0 ? `${signed} of ${total} went through; the rest is still on NEAR.` : 'Nothing was withdrawn.'}</ErrorNote>}
      <dl className="mt-5 space-y-2.5 border-t border-border/70 pt-4 text-sm">
        <Row label={arrived ? 'Received' : 'You receive'}>{qtc(amount)} QTC</Row>
        <Row label="To"><span className="font-mono text-xs" title={address}>{short(address, 10, 8)}</span></Row>
        {batch && <Row label="Started">{when(batch.at)}</Row>}
      </dl>
      <div className="mt-5 grid">
        <Button variant={arrived ? 'primary' : 'outline'} className="min-h-12" disabled={signing} onClick={onBack}>{arrived ? 'Bridge again' : 'Back to the bridge'}</Button>
      </div>
    </div>
  );
}
export const batchWatched = (b: Batch, now: number) => !b.arrived && now - b.at < WATCH_MS;

/** Delivered to an account the person holds in Meteor, as saved when the payment began (never guessed from the name). */
export const inMeteor = (p: Payment) => p.terms.destination === 'meteor';
