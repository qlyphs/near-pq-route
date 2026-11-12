'use client';
/** Asking someone for QTC on the post-quantum route. The requester opens the payer's pay link, names an amount, and
 * gets a payment link to send back: the request is signed with ML-DSA-87 and encrypted with ML-KEM-1024 so that only
 * the payer can read it. The QTC arrives on NEAR in a fresh account of the requester. */
import { Button, Input, cn } from '@qotc/ui';
import * as React from 'react';
import { askState, type Ask } from '@/lib/pq-route/requests';
import { ROUTE, decodePayer, keyLabel, postRequest, rc, sponsorAccount } from '@/lib/pq-route/route';
import { BIG_INPUT, BackLink, CARD, CTA, Chip, CopyButton, ErrorNote, MINIMUM, Out, QtcChip, Row, Sealed, Steps, sealedPreview, nearAccountLink, qtc, toPlanck, when, type StepRow } from './parts';

/** The form: who pays, how much, an optional note. `payerText` is the pay link the page was opened with, if any. */
export function RequestForm({ w, payerText, onCreated }: { w: rc.RouteWallet; payerText: string; onCreated: (a: Ask) => void }) {
  const [text, setText] = React.useState(payerText);
  const [amount, setAmount] = React.useState('');
  const [memo, setMemo] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  React.useEffect(() => { if (payerText) setText(payerText); }, [payerText]);
  const payer = React.useMemo(() => { if (!text.trim()) return null; try { return decodePayer(text); } catch (e) { return (e as Error).message; } }, [text]);
  const planck = toPlanck(amount);

  async function create() {
    if (!payer || typeof payer === 'string' || !planck) return;
    setError(''); setBusy(true);
    try {
      const expiresAt = Date.now() + 24 * 3600e3;
      const { sealed, account, rid } = rc.createRequest(w, payer, { network: ROUTE.network, sponsor: ROUTE.sponsor, amountPlanck: planck, memo: memo.slice(0, 60), expiresAt });
      // The account exists, with exactly this request's ML-DSA-65 key, before the link goes out.
      const { signer } = rc.paymentKeys(w, ROUTE.network, rid);
      try {
        const made = await sponsorAccount(signer.publicKey);
        if (made.accountId !== account) throw new Error('Route service: it opened another account than this request names');
      } finally { signer.destroy(); }
      const { id } = await postRequest(sealed);
      // The fragment never reaches a server: it pins this requester's card for the payer (openRequestPinned).
      const url = `${window.location.origin}${window.location.pathname}?r=${id}#c=${rc.cardPin(rc.card(w))}`;
      onCreated({ id, url, account, amount: String(planck), memo: memo.slice(0, 60), payer: keyLabel(payer), bytes: sealed.length, preview: sealedPreview(sealed), createdAt: Date.now(), expiresAt });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  if (!payer || typeof payer === 'string') return (
    <div className="arrive mt-[clamp(0.75rem,2.4dvh,1.25rem)]">
      <p className="text-pretty text-sm leading-relaxed text-muted-foreground">Ask someone to pay you in QTC. Your request is encrypted for them alone: nobody else can read it, not even us.</p>
      <div className={`${CARD} mt-4 space-y-3`}>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium">Their pay link</span>
          <span className="text-xs text-muted-foreground">on their Pay tab</span>
        </div>
        <p className="text-xs text-muted-foreground">It holds their ML-KEM-1024 public key. Your request is encrypted with it. Open the link they sent, or paste it here.</p>
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="https://…#to=…" spellCheck={false} autoComplete="off" aria-label="Their pay link" aria-invalid={typeof payer === 'string'} />
      </div>
      {typeof payer === 'string' && <ErrorNote>{payer}</ErrorNote>}
    </div>
  );
  const cta = !amount.trim() ? 'Enter an amount' : !planck ? 'Enter a number' : planck < MINIMUM ? 'Minimum 0.01 QTC' : null;
  return (
    <form className="arrive mt-[clamp(0.75rem,2.4dvh,1.25rem)]" noValidate onSubmit={(e) => { e.preventDefault(); if (!cta && !busy) void create(); }}>
      <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>Asking the holder of key <span className="font-mono text-foreground">{keyLabel(payer)}</span></span>
        <button type="button" className="underline decoration-border underline-offset-4 hover:text-foreground" onClick={() => setText('')}>Change</button>
      </div>
      <div className={CARD}>
        <span className="text-xs font-medium text-muted-foreground">You ask for</span>
        <div className="mt-[clamp(0.25rem,0.9dvh,0.5rem)] flex items-center gap-3">
          <input value={amount} onChange={(e) => setAmount(e.target.value.replace(',', '.'))} inputMode="decimal" placeholder="0" aria-label="Amount of QTC to ask for" autoComplete="off" autoFocus disabled={busy}
            className={cn('min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/40', BIG_INPUT)} />
          <QtcChip where="near" />
        </div>
        <div className="mt-1 flex min-h-7 items-center justify-end text-xs text-muted-foreground">Arrives in a new NEAR account of yours</div>
      </div>
      <label className="mt-2 block space-y-1.5 text-xs">
        <span className="text-muted-foreground">Note for them, encrypted too (optional)</span>
        <Input value={memo} maxLength={60} onChange={(e) => setMemo(e.target.value)} placeholder="Dinner on Friday" autoComplete="off" disabled={busy} />
      </label>
      <Button type="submit" variant={cta ? 'outline' : 'primary'} className={CTA} disabled={!!cta || busy} loading={busy}>{busy ? 'Signing and encrypting…' : cta ?? `Create request for ${qtc(planck!)} QTC`}</Button>
      {error && <ErrorNote>{error}</ErrorNote>}
      <p className="mt-3 text-center text-xs text-muted-foreground">Signed with ML-DSA-87, then encrypted with ML-KEM-1024. No wallet needed.</p>
    </form>
  );
}

/** A request once made: its link to send, what protects it, and whether it was paid. */
export function RequestView({ ask, now, onBack, onBringBack, onCancel }: { ask: Ask; now: number; onBack: () => void; onBringBack: () => void; onCancel: () => void }) {
  const state = askState(ask, now);
  const rows: StepRow[] = [
    { title: 'Signed by you', scheme: 'ML-DSA-87', state: 'done', sub: 'They can check the request is yours and was not changed.' },
    { title: 'Encrypted for them alone', scheme: 'ML-KEM-1024', state: 'done', sub: `${ask.bytes.toLocaleString('en-US')} bytes that only the holder of key ${ask.payer} can open.` },
    { title: 'Your NEAR account is ready', scheme: 'ML-DSA-65', state: 'done', sub: <>One key, held by this browser. <Out href={nearAccountLink(ask.account)}>Account</Out></> },
    { title: state === 'paid' ? 'Paid' : 'They pay from their Qlyphs wallet', state: state === 'paid' ? 'done' : state === 'waiting' ? 'now' : 'paused',
      sub: state === 'paid' ? `${qtc(ask.amount)} QTC arrived on NEAR.` : state === 'expired' ? 'Not paid before it expired. Make a new request.'
        : state === 'cancelled' ? `You cancelled it. The link you sent cannot be recalled: if they still pay before ${when(ask.expiresAt)}, the QTC arrives on NEAR and shows in your balance.` : 'Send them the link. This page shows the payment when it arrives.' },
  ];
  return (
    <div className="arrive">
      <BackLink onClick={onBack} label="Request" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="pq-route" className="text-2xl font-semibold tracking-[-0.04em]">Request for {qtc(ask.amount)} QTC</h1>
        <Chip tone={state === 'paid' ? 'done' : state === 'waiting' ? 'progress' : 'quiet'}>{state === 'paid' ? 'Paid' : state === 'expired' ? 'Expired' : state === 'cancelled' ? 'Cancelled' : 'Waiting'}</Chip>
      </div>
      {state === 'waiting' && (
        <>
          <p className="mt-1.5 text-pretty text-sm leading-relaxed text-muted-foreground">Send this link to the person who pays. Only their browser can open the request.</p>
          <CopyButton primary value={ask.url} label="Copy payment link" className="mt-4" />
          {ask.preview && <div className="mt-3"><Sealed preview={ask.preview} bytes={ask.bytes} label="What the route service stores" /></div>}
        </>
      )}
      <div className="mt-5"><Steps rows={rows} /></div>
      <dl className="mt-5 space-y-2.5 border-t border-border/70 pt-4 text-sm">
        <Row label="Amount">{qtc(ask.amount)} QTC</Row>
        {ask.memo && <Row label="Note">{ask.memo}</Row>}
        <Row label="Created">{when(ask.createdAt)}</Row>
        {state === 'waiting' && <Row label="Payable until">{when(ask.expiresAt)}</Row>}
      </dl>
      <div className="mt-5 grid gap-2 sm:grid-cols-2">
        {state === 'paid' && <Button variant="primary" className="min-h-12" onClick={onBringBack}>Bring it to Quantus</Button>}
        {state === 'waiting' && <Button variant="outline" className="min-h-12" onClick={onCancel}>Cancel request</Button>}
        <Button variant="outline" className={cn('min-h-12', state !== 'paid' && state !== 'waiting' && 'sm:col-span-2')} onClick={onBack}>New request</Button>
      </div>
    </div>
  );
}
