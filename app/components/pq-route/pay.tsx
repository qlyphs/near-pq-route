'use client';
/** Paying a request on the post-quantum route. The payer shares a pay link (their ML-KEM-1024 key) so requests can
 * be encrypted for them, then opens the payment link they get back: the request is decrypted here, its ML-DSA-87
 * signature and its NEAR account are checked, and the Qlyphs wallet pays it. */
import { Button, Input } from '@qotc/ui';
import * as React from 'react';
import { toAddress } from '@/lib/address';
import { ROUTE, decodeCard, getRequest, keyLabel, payerFragment, rc, receiverProblem } from '@/lib/pq-route/route';
import { BIG, CARD, CTA, CopyButton, ErrorNote, Out, QtcChip, Row, Sealed, Steps, sealedPreview, nearAccountLink, qtc, short, type StepRow } from './parts';
import type { Payments } from './use-route';

/** The request id and the requester's pin carried by a payment link (or a bare id). */
function parseLink(text: string): { id: string | null; pin: string | null } {
  const t = text.trim();
  return { id: t.match(/[?&]r=([0-9a-f]{32})/)?.[1] ?? t.match(/^[0-9a-f]{32}$/)?.[0] ?? null, pin: t.match(/#c=([0-9a-f]{64})/)?.[1] ?? null };
}

export function PayForm({ w, pay, link, setLink, onPayment, onReview }: { w: rc.RouteWallet; pay: Payments; link: string; setLink: (s: string) => void; onPayment: (key: string) => void;
  /** Told when a request is open for review, and when it no longer is. */
  onReview: (open: boolean) => void }) {
  const [request, setRequest] = React.useState<rc.PaymentRequest | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [error, setError] = React.useState('');
  const { id, pin } = parseLink(link);
  const [loading, setLoading] = React.useState(!!id && !!pin);
  const [card, setCard] = React.useState('');
  const [sealed, setSealed] = React.useState<{ preview: string; bytes: number } | null>(null);
  // Only the latest link may set the request: an older lookup that finishes late is dropped.
  const generation = React.useRef(0);
  React.useEffect(() => {
    const mine = ++generation.current;
    setRequest(null); setError(''); setProblem(null); setSealed(null);
    if (!id) { if (link.trim()) setError('This is not a payment link. It looks like https://…?r=…'); return; }
    if (!pin && !card.trim()) return;
    let recipient: rc.Card | null = null;
    if (!pin) { try { recipient = decodeCard(card); } catch (e) { setError((e as Error).message); return; } }
    setLoading(true);
    void getRequest(id)
      .then((sealed) => { if (generation.current === mine) setSealed({ preview: sealedPreview(sealed), bytes: sealed.length }); return sealed; })
      .then((sealed) => recipient ? rc.openRequest(w, sealed, { recipient, network: ROUTE.network, sponsor: ROUTE.sponsor })
        : rc.openRequestPinned(w, sealed, { pin: pin!, network: ROUTE.network, sponsor: ROUTE.sponsor }))
      .then(async (r) => { const why = await receiverProblem(r.account, r.accountKey); if (generation.current === mine) { setRequest(r); setProblem(why); } })
      .catch((e) => { if (generation.current === mine) setError(/decrypt|tag|invalid/i.test(String(e)) ? 'This request was encrypted for someone else: it cannot be opened with your key.' : (e as Error).message); })
      .finally(() => { if (generation.current === mine) setLoading(false); });
  }, [id, pin, card, link, w]);

  const reviewing = !!request;
  React.useEffect(() => { onReview(reviewing); return () => onReview(false); }, [reviewing]); // eslint-disable-line react-hooks/exhaustive-deps

  const myLink = typeof window === 'undefined' ? '' : `${window.location.origin}${window.location.pathname}#to=${payerFragment(rc.card(w))}`;
  const existing = id ? pay.saved.find((s) => s.key === pay.keyFor(id)) : undefined;

  if (!id || (!request && !loading && !(!pin && id))) return (
    <div className="arrive mt-[clamp(0.75rem,2.4dvh,1.25rem)]">
      <p className="text-pretty text-sm leading-relaxed text-muted-foreground">Pay someone who asks you for QTC. They need your pay link to write a request only you can read.</p>
      <div className={`${CARD} mt-4 space-y-3`}>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium">Your pay link</span>
          <span className="text-xs text-muted-foreground">key <span className="font-mono text-foreground">{keyLabel(rc.card(w))}</span></span>
        </div>
        <p className="text-xs text-muted-foreground">It holds your ML-KEM-1024 public key and nothing secret. Send it to whoever wants to ask you for QTC.</p>
        <CopyButton primary value={myLink} label="Copy my pay link" />
      </div>
      <label className="mt-4 block space-y-1.5 text-sm">
        <span className="text-muted-foreground">Got a payment link back? Open it, or paste it here.</span>
        <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…?r=…" spellCheck={false} autoComplete="off" />
      </label>
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );

  if (!request) return (
    <div className="arrive mt-[clamp(0.75rem,2.4dvh,1.25rem)]">
      {!pin && (
        <label className="block space-y-1.5 text-sm">
          <span className="text-muted-foreground">This link does not say who asks. Paste their route card to check the request against it.</span>
          <Input value={card} onChange={(e) => setCard(e.target.value)} placeholder="qpq1:…" spellCheck={false} autoComplete="off" />
        </label>
      )}
      {loading && <div aria-busy="true" className="mt-3 h-44 animate-pulse rounded-xl bg-muted/40" />}
      {error && <ErrorNote>{error}</ErrorNote>}
      <button type="button" className="mt-4 text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground" onClick={() => { setLink(''); setCard(''); }}>Use another link</button>
    </div>
  );

  const checks: StepRow[] = [
    { title: 'Opened with your key', scheme: 'ML-KEM-1024', state: 'done', sub: 'Nobody else could read this request.' },
    { title: 'Their signature is valid', scheme: 'ML-DSA-87', state: 'done', sub: `Signed by the person who sent you the link (${rc.cardFingerprint(request.recipient).slice(0, 8)}).` },
    problem ? { title: 'Their NEAR account is not safe to pay', state: 'paused', sub: `NEAR testnet: ${problem}.` }
      : { title: 'Their NEAR account has one key, nothing else', scheme: 'ML-DSA-65', state: 'done', sub: <>No contract and no other key can move the QTC. <Out href={nearAccountLink(request.account)}>{short(request.account, 10, 8)}</Out></> },
  ];
  const account = pay.account;
  return (
    <div className="arrive mt-[clamp(0.75rem,2.4dvh,1.25rem)]">
      {sealed && <>
        <Sealed preview={sealed.preview} bytes={sealed.bytes} label="What the route service sent you" />
        <p className="my-2 text-center text-xs text-muted-foreground">Opened in this browser, with your key</p>
      </>}
      <div className={`${CARD} settle`}>
        <span className="text-xs font-medium text-muted-foreground">They ask you for</span>
        <div className="mt-[clamp(0.25rem,0.9dvh,0.5rem)] flex items-center gap-3">
          <p className={`min-w-0 flex-1 truncate ${BIG}`}>{qtc(request.amount)}</p>
          <QtcChip where="near" />
        </div>
        <div className="mt-1 flex min-h-7 items-center text-xs text-muted-foreground">{request.memo ? <span className="truncate">“{request.memo}”</span> : 'No note'}</div>
      </div>
      <div className="mt-4"><Steps rows={checks} /></div>
      {existing ? (
        <Button variant="primary" className={CTA} onClick={() => onPayment(existing.key)}>{existing.p?.stage === 'settled' ? 'Already paid: see it' : 'Payment in progress: open it'}</Button>
      ) : !account ? (
        <Button variant="primary" className={CTA} loading={pay.connecting} onClick={() => void pay.connect()}>Connect Qlyphs wallet</Button>
      ) : !pay.onRoute ? (
        <Button variant="outline" className={CTA} disabled>Switch your wallet to Testnet</Button>
      ) : problem ? (
        <Button variant="outline" className={CTA} disabled>Not payable</Button>
      ) : (
        <Button variant="primary" className={CTA} disabled={!!pay.busy} onClick={() => void pay.startPay(id, request, pin ? request.recipient : decodeCard(card), onPayment)}>Pay {qtc(request.amount)} QTC</Button>
      )}
      <dl className="mt-4 space-y-2 text-xs text-muted-foreground">
        {account && <Row label="From">{short(toAddress(account.owner), 8, 6)}</Row>}
        <Row label="Your wallet asks twice">send, then confirm the destination</Row>
      </dl>
      <button type="button" className="mt-3 text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground" onClick={() => { setLink(''); setCard(''); }}>Use another link</button>
    </div>
  );
}
