'use client';
/** The bridge form of the post-quantum route: QTC from Quantus to NEAR Intents, or what this browser holds on NEAR
 * back to Quantus. One amount, one button; the transfer is then followed on its own screen. */
import { Button, Input, cn } from '@qotc/ui';
import { ArrowsDownUpIcon, CaretDownIcon } from '@phosphor-icons/react';
import * as React from 'react';
import { toAddress } from '@/lib/address';
import { quantusAccountId } from '@/lib/intents-chains';
import { useSpendable } from '@/lib/reads';
import { BIG, BIG_INPUT, CARD, CTA, ErrorNote, MINIMUM, QtcChip, Row, qtc, short, toPlanck } from './parts';
import type { Meteor } from './meteor';
import type { Holdings, Payments, Withdrawals } from './use-route';

export type Direction = 'to' | 'back';
/** Where the QTC lands on NEAR, or comes back from: a fresh account of this browser, or the person's Meteor account. */
export type Via = 'browser' | 'meteor';
/** Kept on Quantus for the network fee when everything else is sent. */
const FEE_MARGIN = 2n * 10n ** 10n;

export function BridgeForm({ dir, setDir, via, setVia, pay, holdings, outs, meteor, notice, onPayment, onReturn, onStarting }: {
  dir: Direction; setDir: (d: Direction) => void; via: Via;
  /** Absent: the Meteor option is not offered. */
  setVia?: (v: Via) => void; pay: Payments; holdings: Holdings; outs: Withdrawals; meteor: Meteor;
  /** Why the last attempt ended without a transfer (refused in the wallet). */
  notice: string;
  onPayment: (key: string) => Promise<void> | void; onReturn: (batch: number) => void;
  /** Told while a transfer to NEAR is being prepared, before it has a screen of its own. */
  onStarting: (starting: boolean) => void;
}) {
  const [amount, setAmount] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [details, setDetails] = React.useState(false);
  const [dest, setDest] = React.useState('');
  const { spendable } = useSpendable(pay.account?.owner);
  const planck = toPlanck(amount);
  const to = dir === 'to';
  const destId = dest.trim() ? quantusAccountId(dest.trim()) : pay.account?.owner ?? null;
  const viaMeteor = via === 'meteor';
  const held = viaMeteor ? meteor.inside + meteor.direct : holdings.total;

  async function send() {
    if (!planck) return;
    setError(''); setBusy(true); onStarting(true);
    const onKey = (key: string) => { setAmount(''); void onPayment(key); };
    try {
      if (viaMeteor) { if (meteor.account && meteor.handle && meteor.block) await pay.startTo(meteor.account, meteor.handle, meteor.block, planck, onKey); }
      else await pay.startSelf(planck, onKey);
    }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); onStarting(false); }
  }
  async function bringBack() {
    if (!destId) return;
    setError('');
    const batch = Date.now();
    onReturn(batch);
    if (viaMeteor) {
      const acct = meteor.account;
      if (!acct) return;
      // Inside Intents first, then what Intents refused (on the account's own bridge-token balance): one approval each.
      if (meteor.inside > 0n) await outs.withdrawWith(acct, meteor.inside, destId, batch, () => meteor.withdraw(acct, 'inside', meteor.inside, destId.slice(2)));
      if (meteor.direct > 0n) await outs.withdrawWith(acct, meteor.direct, destId, batch, () => meteor.withdraw(acct, 'direct', meteor.direct, destId.slice(2)));
      void meteor.recheck();
    } else await outs.withdrawAll(holdings.held, destId, batch);
  }

  const cta: { label: string; run?: () => void; loading?: boolean } = to
    ? !pay.account ? { label: 'Connect Qlyphs wallet', run: () => void pay.connect(), loading: pay.connecting }
      : !pay.onRoute ? { label: 'Switch your wallet to Testnet' }
      : !amount.trim() ? { label: 'Enter an amount' }
      : !planck ? { label: 'Enter a number' }
      : planck < MINIMUM ? { label: 'Minimum 0.01 QTC' }
      : spendable !== undefined && planck > spendable ? { label: 'Not enough QTC' }
      : viaMeteor && !meteor.account ? { label: 'Connect Meteor', run: () => void meteor.connect(), loading: meteor.connecting }
      : viaMeteor && meteor.checking ? { label: 'Checking your Meteor account…', loading: true }
      : viaMeteor && !meteor.handle ? { label: 'Your Meteor account cannot receive yet' }
      : busy ? { label: viaMeteor ? 'Checking your Meteor account…' : 'Opening your NEAR account…', loading: true }
      : { label: `Bridge ${qtc(planck)} QTC to ${viaMeteor ? 'Meteor' : 'NEAR'}`, run: () => void send() }
    : viaMeteor && !meteor.account ? { label: 'Connect Meteor', run: () => void meteor.connect(), loading: meteor.connecting }
      : !viaMeteor && !holdings.ready ? { label: 'Reading NEAR…', loading: true }
      : held === 0n ? { label: viaMeteor ? 'Nothing from the route in Meteor yet' : 'Nothing on NEAR yet' }
      : dest.trim() && !destId ? { label: 'Not a Quantus address' }
      : !destId ? { label: 'Connect Qlyphs wallet', run: () => void pay.connect(), loading: pay.connecting }
      : { label: `Bring ${qtc(held)} QTC back${viaMeteor ? ' from Meteor' : ' to Quantus'}`, run: () => void bringBack() };

  const fromCard = (
    <div className={CARD}>
      <span className="text-xs font-medium text-muted-foreground">From</span>
      <div className="mt-[clamp(0.25rem,0.9dvh,0.5rem)] flex items-center gap-3">
        {to ? (
          <input value={amount} onChange={(e) => setAmount(e.target.value.replace(',', '.'))} inputMode="decimal" placeholder="0" aria-label="Amount of QTC to bridge" autoComplete="off" disabled={busy}
            className={cn('min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/40', BIG_INPUT)} />
        ) : (
          <p key={String(held)} className={cn('settle min-w-0 flex-1 truncate', BIG, held === 0n && 'text-muted-foreground/40')}>{viaMeteor || holdings.ready ? qtc(held) : '0'}</p>
        )}
        <QtcChip where={to ? 'quantus' : 'near'} />
      </div>
      <div className="mt-1 flex min-h-7 items-center justify-end gap-2 text-xs tabular-nums text-muted-foreground">
        {!to && setVia && <ViaSwitch via={via} setVia={setVia} disabled={busy} browser="This browser" />}
        {!to && setVia && <span className="flex-1" />}
        {to ? pay.account && spendable !== undefined && (
          <>
            Balance {qtc(spendable)}
            <button type="button" disabled={spendable <= FEE_MARGIN || busy} onClick={() => setAmount(qtc(spendable - FEE_MARGIN))} title="Everything spendable, minus 0.02 QTC kept for the network fee"
              className="relative min-h-7 rounded-full border border-border px-2 text-[11px] text-foreground transition-colors after:absolute after:-inset-x-1 after:-inset-y-2 after:content-[''] hover:border-foreground/40 hover:bg-muted/60 disabled:opacity-40">Max</button>
          </>
        ) : viaMeteor ? meteorLine(meteor, 'from') : holdings.ready ? (holdings.held.length > 1 ? `In ${holdings.held.length} NEAR accounts of yours, brought back together` : holdings.held.length === 1 ? 'Everything you hold on NEAR' : 'Bridge QTC to NEAR first, or get paid there')
          : 'Reading your accounts on NEAR…'}
      </div>
    </div>
  );
  const toCard = (
    <div className={CARD}>
      <span className="text-xs font-medium text-muted-foreground">To</span>
      <div className="mt-[clamp(0.25rem,0.9dvh,0.5rem)] flex items-center gap-3">
        <p className={cn('min-w-0 flex-1 truncate', BIG, !(to ? planck : held) && 'text-muted-foreground/40')}>{to ? (planck ? qtc(planck) : '0') : viaMeteor || holdings.ready ? qtc(held) : '0'}</p>
        <QtcChip where={to ? 'near' : 'quantus'} />
      </div>
      <div className="mt-1 flex min-h-7 items-center justify-end gap-2 text-xs text-muted-foreground">
        {to && setVia && <ViaSwitch via={via} setVia={setVia} disabled={busy} browser="New account" />}
        <span className="min-w-0 flex-1 truncate text-right">{to ? (viaMeteor ? meteorLine(meteor, 'to') : 'One post-quantum key, held by this browser') : destId ? `To ${short(toAddress(destId), 8, 6)}` : ''}</span>
      </div>
    </div>
  );

  return (
    <form className="arrive mt-[clamp(0.75rem,2.4dvh,1.25rem)]" noValidate onSubmit={(e) => { e.preventDefault(); cta.run?.(); }}>
      {fromCard}
      <div className="relative z-10 -my-3 flex justify-center">
        <button type="button" onClick={() => { setError(''); setDir(to ? 'back' : 'to'); }} disabled={busy} aria-label={to ? 'Switch to bringing QTC back to Quantus' : 'Switch to bridging QTC to NEAR'} title="Switch direction"
          className="grid size-10 place-items-center rounded-xl border-4 border-card bg-muted text-muted-foreground transition-[color,rotate,scale] duration-200 hover:rotate-180 hover:text-foreground active:scale-90 disabled:opacity-50 motion-reduce:hover:rotate-0 motion-reduce:active:scale-100">
          <ArrowsDownUpIcon aria-hidden="true" weight="bold" className="size-4" />
        </button>
      </div>
      {toCard}
      {viaMeteor && meteor.account && <MeteorAccount meteor={meteor} disabled={busy} />}
      <Button type="submit" variant={cta.run ? 'primary' : 'outline'} className={CTA} disabled={!cta.run || !!cta.loading} loading={cta.loading}>{cta.label}</Button>
      {viaMeteor && meteor.account && meteor.problem && (to || !meteor.inside) && (meteor.fix ? <MeteorFix meteor={meteor} /> : <ErrorNote>{meteor.problem}</ErrorNote>)}
      {(error || holdings.error || notice) && <ErrorNote>{error || (!to && !viaMeteor && holdings.error) || notice}</ErrorNote>}

      <div className="mt-3 rounded-xl border border-border bg-background/40">
        <button type="button" aria-expanded={details} onClick={() => setDetails(!details)} className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-3 text-left text-xs transition-colors hover:bg-foreground/[0.04]">
          <span className="font-medium">Details</span>
          <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <span className="truncate">{to ? 'About 2 minutes · 2 approvals in your wallet' : viaMeteor ? 'A few minutes · 1 approval in Meteor' : 'A few minutes · nothing to approve'}</span>
            <CaretDownIcon aria-hidden="true" weight="bold" className={cn('size-3.5 shrink-0 transition-transform duration-200', details && 'rotate-180')} />
          </span>
        </button>
        <div hidden={!details} className="arrive space-y-3 border-t border-border/70 px-3 pb-3.5 pt-3 text-xs">
          <dl className="space-y-2">
            {to ? (
              <>
                <Row label="Your wallet signs">the transfer, then the destination (ML-DSA-87)</Row>
                <Row label="Approved by">2 of 3 signers, checked by the NEAR contract (ML-DSA-87)</Row>
                <Row label="Lands in">{viaMeteor ? 'your Meteor account, credited in the testnet NEAR Intents verifier' : 'a new NEAR account with one ML-DSA-65 key'}</Row>
                {viaMeteor && <Row label="Your account">must have exactly one ML-DSA-65 full-access key and no other keys. Keep them unchanged until the transfer finishes.</Row>}
                {viaMeteor && <Row label="Recovery">Meteor holds the key: your Qlyphs backup does not restore this account</Row>}
                {viaMeteor && <Row label="Privacy">the payment is linked to this account's history, unlike a new account</Row>}
                <Row label="Bridge fee">none on the test network</Row>
              </>
            ) : (
              <>
                <Row label="Signed by">{viaMeteor ? 'your Meteor account, one approval in Meteor' : 'your NEAR accounts, in this browser (ML-DSA-65)'}</Row>
                <Row label="Released by">2 of 3 signers, from the Quantus safe (ML-DSA-87)</Row>
                <Row label="Bridge fee">none on the test network</Row>
              </>
            )}
          </dl>
          {!to && (
            <label className="block space-y-1.5">
              <span className="text-muted-foreground">Send to another Quantus address</span>
              <Input value={dest} onChange={(e) => setDest(e.target.value)} placeholder={pay.account ? toAddress(pay.account.owner) : 'qz…'} spellCheck={false} autoComplete="off" />
            </label>
          )}
        </div>
      </div>
    </form>
  );
}

/** New account in this browser, or Meteor. */
function ViaSwitch({ via, setVia, disabled, browser }: { via: Via; setVia: (v: Via) => void; disabled: boolean; browser: string }) {
  return (
    <span role="radiogroup" aria-label="NEAR account" className="flex shrink-0 rounded-full border border-border p-0.5">
      {(['browser', 'meteor'] as const).map((v) => (
        <button key={v} type="button" role="radio" aria-checked={via === v} disabled={disabled} onClick={() => setVia(v)}
          className={cn('min-h-6 rounded-full px-2 text-[11px] transition-colors disabled:opacity-50', via === v ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}>
          {v === 'meteor' ? 'Meteor' : browser}
        </button>
      ))}
    </span>
  );
}
/** Which Meteor account receives (or brings back): any account Meteor shared, or another one picked in Meteor. */
function MeteorAccount({ meteor: m, disabled }: { meteor: Meteor; disabled: boolean }) {
  const busy = disabled || m.checking || m.connecting || m.fixing;
  return (
    <div className="mt-2 flex min-h-11 items-center gap-2 rounded-xl border border-border bg-background/40 px-3 text-xs">
      <span className="shrink-0 text-muted-foreground">Meteor account</span>
      {m.accounts.length > 1 ? (
        <select value={m.account ?? ''} disabled={busy} onChange={(e) => void m.choose(e.target.value)} aria-label="Meteor account"
          className="min-w-0 flex-1 truncate rounded-md bg-transparent py-1 text-right font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {m.accounts.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      ) : <span className="min-w-0 flex-1 truncate text-right font-medium" title={m.account ?? ''}>{m.account}</span>}
      <button type="button" disabled={busy} onClick={() => void m.switchAccount()}
        className="relative min-h-7 shrink-0 rounded-full border border-border px-2 text-[11px] text-foreground transition-colors after:absolute after:-inset-x-1 after:-inset-y-2 after:content-[''] hover:border-foreground/40 hover:bg-muted/60 disabled:opacity-40">Change</button>
    </div>
  );
}

const METEOR_APP = 'https://wallet.meteorwallet.app';
/** What stops a Meteor account from receiving, and the way to fix it: add an ML-DSA-65 key in Meteor (only Meteor can
 * make a key it holds), or remove the classical keys left beside it (one transaction, approved in Meteor). */
function MeteorFix({ meteor: m }: { meteor: Meteor }) {
  const remove = m.fix?.kind === 'remove' ? m.fix.keys : null;
  const link = 'font-medium text-foreground underline underline-offset-2 hover:no-underline';
  return (
    <div role="status" className="arrive mt-3 space-y-2.5 rounded-xl border border-border bg-background/40 p-3 text-xs">
      <p className="font-medium">{remove ? 'One step left: remove the classical keys' : m.fix?.kind === 'add' ? 'Make this Meteor account post-quantum' : 'This Meteor account cannot receive yet'}</p>
      {m.fix?.kind === 'add' ? (
        <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
          <li>Open <a className={link} href={METEOR_APP} target="_blank" rel="noopener noreferrer">Meteor</a> on testnet, on {short(m.account ?? '', 10, 6)}.</li>
          <li>Add a post-quantum (ML-DSA) key to the account. Meteor does it in one transaction and your address stays the same.</li>
          <li>Come back and check again. Then this page offers to remove the old classical keys.</li>
        </ol>
      ) : remove ? (
        <>
          <p className="text-muted-foreground">Your ML-DSA-65 key is in place. {remove.length === 1 ? 'One classical key is' : `${remove.length} classical keys are`} still on the account, and could move the QTC. Remove {remove.length === 1 ? 'it' : 'them'} in one approval in Meteor.</p>
          <p className="text-muted-foreground">Only if Meteor shows the post-quantum key for this account: afterwards it is the only way in.</p>
        </>
      ) : <p className="text-muted-foreground">{m.problem}</p>}
      <div className="flex flex-wrap gap-2">
        {remove && <Button type="button" variant="primary" className="min-h-9" loading={m.fixing} disabled={m.fixing || m.checking} onClick={() => void m.removeClassicalKeys()}>{`Remove ${remove.length === 1 ? 'the classical key' : `${remove.length} classical keys`}`}</Button>}
        <Button type="button" variant="outline" className="min-h-9" loading={m.checking} disabled={m.fixing || m.checking} onClick={() => void m.recheck()}>Check again</Button>
      </div>
      <p className="text-muted-foreground">No Meteor account yet? <a className={link} href={METEOR_APP} target="_blank" rel="noopener noreferrer">Create one in Meteor</a>, on testnet, then connect it here.</p>
    </div>
  );
}

function meteorLine(m: Meteor, side: 'to' | 'from'): string {
  if (!m.account) return side === 'to' ? 'Your Meteor account' : 'Connect Meteor to see it';
  if (m.checking) return `Checking ${short(m.account, 10, 6)}…`;
  if (side === 'to') return m.handle && m.block ? `${short(m.account, 10, 6)} · one ML-DSA-65 key at block ${m.block.toLocaleString('en-US')}` : short(m.account, 10, 6);
  return `Credited to ${short(m.account, 10, 6)}${m.direct ? '' : ' in NEAR Intents'}`;
}
