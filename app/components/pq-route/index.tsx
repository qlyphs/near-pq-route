'use client';
/** The post-quantum QTC route on test networks, as three things to do: bridge your own QTC between Quantus and NEAR
 * Intents, ask someone for QTC with a request encrypted for them, or pay such a request from the Qlyphs wallet.
 * Every signature on the way is ML-DSA; requests are encrypted with ML-KEM-1024. Formats: qlyphs-pq87-near
 * docs/ROUTE.md. */
import { Button, Input, cn } from '@qotc/ui';
import { CaretDownIcon } from '@phosphor-icons/react';
import * as React from 'react';
import { askState } from '@/lib/pq-route/requests';
import { ROUTE, bridgeState, mintPointer, nearTx, seedHex, type BridgeState } from '@/lib/pq-route/route';
import { BridgeForm, type Direction, type Via } from './bridge';
import { useMeteor } from './meteor';
import { RouteDiagram, type Records, type Scene } from './diagram';
import { Chip, CopyButton, ErrorNote, Out, QtcMark, Row, nearAccountLink, nearTxLink, qtc, short, when, type Tone } from './parts';
import { PayForm } from './pay';
import { RequestForm, RequestView } from './request';
import { PaymentView, ReturnView, inMeteor } from './transfer';
import { batchesOf, useAsks, useHoldings, usePayments, useRouteWallet, useWithdrawals, WATCH_MS } from './use-route';

type Tab = 'bridge' | 'request' | 'pay';
type View = { kind: 'form' } | { kind: 'payment'; id: string } | { kind: 'return'; batch: number } | { kind: 'request'; id: string };
const TABS: { id: Tab; label: string }[] = [{ id: 'bridge', label: 'Bridge' }, { id: 'request', label: 'Request' }, { id: 'pay', label: 'Pay' }];

export function PqRoute() {
  const { w, seed, restore } = useRouteWallet();
  const [tab, setTab] = React.useState<Tab>('bridge');
  const [view, setView] = React.useState<View>({ kind: 'form' });
  const [dir, setDir] = React.useState<Direction>('to');
  const [via, setVia] = React.useState<Via>('browser');
  const [payLink, setPayLink] = React.useState('');
  const [payerText, setPayerText] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [reviewing, setReviewing] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const pay = usePayments(w);
  // Meteor is always offered beside the new browser account.
  const meteorOn = true;
  const meteor = useMeteor(meteorOn);
  const holdings = useHoldings(w);
  const outs = useWithdrawals(w, () => void holdings.scan());
  const asks = useAsks();

  // A payment link opens on Pay, a pay link on Request.
  React.useEffect(() => {
    const read = () => {
      if (/[?&]r=[0-9a-f]{32}/.test(window.location.search)) { setPayLink(window.location.href); setTab('pay'); setView({ kind: 'form' }); }
      else if (/[#&]to=[A-Za-z0-9_-]+/.test(window.location.hash)) { setPayerText(window.location.href); setTab('request'); setView({ kind: 'form' }); }
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  // A request that gets paid changes what this browser holds on NEAR.
  const paid = asks.asks.filter((a) => a.paidAt).length;
  React.useEffect(() => { if (paid) void holdings.scan(); }, [paid]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (t: Tab) => { setTab(t); setView({ kind: 'form' }); setNotice(''); };
  const toBack = (from: Via = 'browser') => { setDir('back'); setVia(from); go('bridge'); void holdings.scan(); if (from === 'meteor') void meteor.recheck(); };
  /** Follows a payment on its own screen; when the wallet refuses before anything is sent, comes back to the form. */
  const follow = (key: string) => { setNotice(''); setView({ kind: 'payment', id: key }); };
  const payment = view.kind === 'payment' ? pay.saved.find((s) => s.key === view.id) : undefined;
  React.useEffect(() => {
    if (view.kind !== 'payment' || payment || pay.busy === view.id) return;
    // Give the saved list one turn to catch up before deciding the payment is gone.
    const t = setTimeout(() => { setView((v) => (v.kind === 'payment' && v.id === view.id ? { kind: 'form' } : v)); setNotice('Qlyphs wallet: the request was closed or refused. Nothing was sent.'); }, 400);
    return () => clearTimeout(t);
  }, [view, payment, pay.busy]);
  React.useEffect(() => { if (payment?.p?.stage === 'settled') void holdings.scan(); }, [payment?.p?.stage]); // eslint-disable-line react-hooks/exhaustive-deps

  const batches = batchesOf(outs.outs);
  const ask = view.kind === 'request' ? asks.asks.find((a) => a.id === view.id) : undefined;

  const mint = useMint(view.kind === 'payment' && (payment?.p?.stage === 'minted' || payment?.p?.stage === 'settled') ? payment.p.depositId : undefined);
  // The picture beside the form. Once something real is under way (a transfer being prepared or followed, a
  // withdrawal, a request) it never plays on its own: it holds on that thing's real step, with its records.
  const picture: { scene: Scene; live: number | null; label?: string; pair?: [number, number] | null; records?: Records } = (() => {
    if (view.kind === 'payment' && payment?.p) {
      const p = payment.p, s = p.stage, mine = pay.mine(p);
      const account = { label: short(p.terms.request.account, 10, 8), href: nearAccountLink(p.terms.request.account), title: 'The NEAR account, on the explorer' };
      const lock = p.txHash ? { label: `Transfer ${short(p.txHash, 8, 6)}`, title: p.txHash } : undefined;
      const minted = mint.tx ? { label: 'Mint transaction', href: nearTxLink(mint.tx), title: 'The mint, on the NEAR explorer' } : undefined;
      if (mine) return { scene: 'to', pair: mint.pair, records: { ...(lock && { 0: lock }), ...(minted && { 3: minted }), 4: account },
        live: s === 'new' || s === 'sending' ? 0 : s === 'sent' || s === 'located' ? 1 : s === 'signed' || s === 'claimed' ? 2 : s === 'minted' ? 3 : 4 };
      return { scene: 'pay', live: s === 'settled' ? 5 : 4, records: { ...(lock && { 3: lock }), 4: account } };
    }
    if (view.kind === 'payment') return tab === 'pay' ? { scene: 'pay', live: 4 } : { scene: 'to', live: 0 };
    if (view.kind === 'return') {
      const b = batches.find((x) => x.id === view.batch), signing = outs.leaving?.batch === view.batch && !outs.leaving.error && outs.leaving.done < outs.leaving.total;
      // A release is always proposed by the first signer and approved by the second.
      const first = b?.outs[0];
      return { scene: 'back', pair: b?.arrived ? [0, 1] : null, live: signing ? 0 : b?.arrived ? 4 : 2,
        records: first ? { 0: { label: b!.outs.length > 1 ? `Withdrawal 1 of ${b!.outs.length}` : 'Withdrawal transaction', href: nearTxLink(first.tx), title: 'The withdrawal, on the NEAR explorer' } } : undefined };
    }
    if (view.kind === 'request' && ask && !ask.paidAt && (ask.cancelledAt || outs.now > ask.expiresAt)) return { scene: 'request', live: null };
    if (view.kind === 'request' && ask) return { scene: 'request', live: ask.paidAt ? 5 : 3, label: 'Your request', records: { 4: { label: short(ask.account, 10, 8), href: nearAccountLink(ask.account), title: 'Your NEAR account, on the explorer' } } };
    if (tab === 'bridge' && starting) return { scene: 'to', live: 0 };
    if (tab === 'pay' && reviewing) return { scene: 'pay', live: 3, label: 'This request' };
    return { scene: tab === 'bridge' ? dir : tab, live: null };
  })();

  return (
    <div className="grid w-full max-w-[30rem] grid-cols-[minmax(0,1fr)] gap-4 lg:max-w-[54rem] lg:grid-cols-[30rem_minmax(0,1fr)] lg:items-start">
      <section aria-labelledby="pq-route" className="settle relative w-full rounded-2xl border border-border bg-card/60 p-4 sm:p-[clamp(1rem,2.8dvh,1.5rem)]">
        {!w ? <div aria-busy="true" className="h-[26rem] animate-pulse rounded-xl bg-muted/40" />
          : view.kind === 'payment' ? <PaymentView id={view.id} pay={pay} onBack={() => setView({ kind: 'form' })} onBringBack={toBack} />
          : view.kind === 'return' ? <ReturnView batch={batches.find((b) => b.id === view.batch) ?? null} leaving={outs.leaving?.batch === view.batch ? outs.leaving : null} now={outs.now} onBack={() => { outs.dismiss(); setView({ kind: 'form' }); }} />
          : view.kind === 'request' && ask ? <RequestView ask={ask} now={asks.now} onBack={() => setView({ kind: 'form' })} onBringBack={() => toBack()} onCancel={() => asks.cancel(ask.id)} />
          : (
            <>
              <div className="flex items-center justify-between gap-3">
                <div role="tablist" aria-label="What to do" className="flex min-w-0 items-baseline gap-4">
                  {TABS.map((t) => (
                    <button key={t.id} role="tab" id={tab === t.id ? 'pq-route' : undefined} aria-selected={tab === t.id} onClick={() => go(t.id)}
                      className={cn('text-2xl font-semibold tracking-[-0.04em] transition-colors', tab === t.id ? 'text-foreground' : 'text-muted-foreground/50 hover:text-muted-foreground')}>{t.label}</button>
                  ))}
                </div>
                <span className="hidden shrink-0 rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground sm:inline">Post-quantum · Testnet</span>
              </div>
              <TabBody>
              {tab === 'bridge' ? <BridgeForm dir={dir} setDir={setDir} via={meteorOn ? via : 'browser'} setVia={meteorOn ? setVia : undefined} pay={pay} holdings={holdings} outs={outs} meteor={meteor} notice={notice} onPayment={follow} onReturn={(batch) => setView({ kind: 'return', batch })} onStarting={setStarting} />
                : tab === 'request' ? <RequestForm w={w} payerText={payerText} onCreated={(a) => { asks.add(a); setView({ kind: 'request', id: a.id }); }} />
                : <><PayForm w={w} pay={pay} link={payLink} setLink={setPayLink} onPayment={follow} onReview={setReviewing} />{notice && <ErrorNote>{notice}</ErrorNote>}</>}
              </TabBody>
            </>
          )}
      </section>

      <RouteDiagram scene={picture.scene} live={picture.live} liveLabel={picture.label} pair={picture.pair} records={picture.records} className="lg:sticky lg:top-4 lg:row-span-2" />
      <div className="flex min-w-0 flex-col gap-4">
      <Recent pay={pay} batches={batches} asks={asks.asks} now={outs.now} open={(v) => { setNotice(''); setView(v); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
      <About seed={seed} restore={(hex) => { restore(hex); setView({ kind: 'form' }); }} />
      </div>
    </div>
  );
}

/** Holds the tab content at the height of the tallest tab seen at this window size, so switching between Bridge,
 * Request and Pay never makes the card jump. */
function TabBody({ children }: { children: React.ReactNode }) {
  const inner = React.useRef<HTMLDivElement>(null);
  const [min, setMin] = React.useState(0);
  React.useEffect(() => {
    const el = inner.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setMin((m) => Math.max(m, el.offsetHeight)));
    ro.observe(el);
    // A smaller window lays the forms out shorter: forget the old height and measure again.
    const reset = () => setMin(el.offsetHeight);
    window.addEventListener('resize', reset);
    return () => { ro.disconnect(); window.removeEventListener('resize', reset); };
  }, []);
  return <div style={{ minHeight: min || undefined }}><div ref={inner}>{children}</div></div>;
}

/** The two signers of a mint, read from its transaction on NEAR: the mint input carries each signer's index before
 * its signature. Null until read, or when the input has another shape. */
function useMint(depositId: string | undefined): { tx: string | null; pair: [number, number] | null } {
  const [tx, setTx] = React.useState<string | null>(null);
  const [pair, setPair] = React.useState<[number, number] | null>(null);
  React.useEffect(() => {
    setPair(null); setTx(null);
    if (!depositId) return;
    let stop = false;
    void (async () => {
      const ptr = await mintPointer(depositId);
      if (!ptr) return;
      if (!stop) setTx(ptr.tx);
      const tx = await nearTx(ptr.tx, ptr.signer) as { transaction?: { actions?: { FunctionCall?: { method_name?: string; args?: string } }[] } };
      const call = tx.transaction?.actions?.[0]?.FunctionCall;
      if (call?.method_name !== 'mint' || !call.args) return;
      const input = Uint8Array.from(atob(call.args), (c) => c.charCodeAt(0));
      // attestation (288) | index | signature (4,627) | index | signature | …
      const a = input[288], b = input[288 + 1 + 4627];
      if (!stop && a !== undefined && b !== undefined && a < 3 && b < 3 && a !== b) setPair([a, b]);
    })().catch(() => { /* the picture lights no signer in particular */ });
    return () => { stop = true; };
  }, [depositId]);
  return { tx, pair };
}

/** Everything this browser did on the route, newest first: transfers either way and requests. */
function Recent({ pay, batches, asks, now, open }: { pay: ReturnType<typeof usePayments>; batches: ReturnType<typeof batchesOf>; asks: ReturnType<typeof useAsks>['asks']; now: number; open: (v: View) => void }) {
  const items: { key: string; at: number; where: 'near' | 'quantus'; title: string; sub: string; chip: [Tone, string]; view: View }[] = [
    ...pay.saved.filter((s) => s.p).map(({ key, p }) => ({
      key, at: p!.updatedAt, where: 'near' as const, view: { kind: 'payment', id: key } as View,
      title: pay.mine(p!) ? `${qtc(p!.terms.request.amount)} QTC → ${inMeteor(p!) ? 'Meteor' : 'NEAR Intents'}` : `Paid ${qtc(p!.terms.request.amount)} QTC`,
      sub: `${pay.mine(p!) ? 'Bridge' : `to ${short(p!.terms.request.account, 8, 0)}`} · ${when(p!.updatedAt)}`,
      chip: (p!.stage === 'settled' ? ['done', 'Done'] : pay.busy === key ? ['progress', 'In progress'] : ['warn', 'Paused']) as [Tone, string],
    })),
    ...batches.map((b) => ({
      key: `b${b.id}`, at: b.at, where: 'quantus' as const, view: { kind: 'return', batch: b.id } as View,
      title: `${qtc(b.amount)} QTC → Quantus`, sub: `Bridge back · ${when(b.at)}`,
      chip: (b.arrived ? ['done', 'Done'] : now - b.at < WATCH_MS ? ['progress', 'In progress'] : ['quiet', 'Sent']) as [Tone, string],
    })),
    ...asks.map((a) => ({
      key: `a${a.id}`, at: a.createdAt, where: 'near' as const, view: { kind: 'request', id: a.id } as View,
      title: `Request for ${qtc(a.amount)} QTC`, sub: `${a.memo || `from key ${a.payer}`} · ${when(a.createdAt)}`,
      chip: ({ paid: ['done', 'Paid'], cancelled: ['quiet', 'Cancelled'], expired: ['quiet', 'Expired'], waiting: ['progress', 'Waiting'] } as const)[askState(a, now)] as unknown as [Tone, string],
    })),
  ].sort((a, b) => b.at - a.at).slice(0, 8);
  if (!items.length) return null;
  return (
    <section aria-labelledby="pq-recent" className="settle w-full rounded-2xl border border-border bg-card/40 p-4 sm:p-5">
      <h2 id="pq-recent" className="text-base font-semibold tracking-[-0.02em]">Recent</h2>
      <ul className="mt-3 space-y-1">
        {items.map((i) => (
          <li key={i.key}>
            <button type="button" onClick={() => open(i.view)} className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.06]">
              <QtcMark where={i.where} />
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-sm">{i.title}</span>
                <span className="truncate text-xs text-muted-foreground">{i.sub}</span>
              </span>
              <Chip tone={i.chip[0]}>{i.chip[1]}</Chip>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What the route is and what it is not, in plain words, with the contracts to check and this browser's backup. */
function About({ seed, restore }: { seed: Uint8Array | null; restore: (hex: string) => void }) {
  const [state, setState] = React.useState<BridgeState | null>(null);
  const [backup, setBackup] = React.useState('');
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    const read = () => void bridgeState().then(setState).catch(() => setState(null));
    read();
    const t = setInterval(read, 30_000);
    return () => clearInterval(t);
  }, []);
  const item = 'smooth group border-t border-border/70 first:border-t-0';
  const head = 'flex min-h-11 cursor-pointer select-none list-none items-center justify-between gap-3 text-sm';
  const caret = <CaretDownIcon aria-hidden="true" weight="bold" className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />;
  return (
    <section aria-label="About this route" className="w-full px-1 text-xs text-muted-foreground">
      <p className="text-pretty leading-relaxed">Every approval on this route is a post-quantum signature. Qlyphs runs all three signers, in one service: this shows 2-of-3 post-quantum authorization, not independent operators. Test networks only.</p>
      <div className="mt-3 rounded-xl border border-border bg-card/40 px-3">
        <details className={item}>
          <summary className={head}><span className="text-foreground/90">How it works</span>{caret}</summary>
          <div className="space-y-3 pb-3.5 leading-relaxed">
            <Qa q="What does post-quantum mean?">Future quantum computers could break the keys most chains use today. ML-DSA (signatures) and ML-KEM (encryption) are the NIST standards built to resist them.</Qa>
            <Qa q="Who approves a transfer?">Your Qlyphs wallet signs it with ML-DSA-87. Then 2 of 3 signers approve it with ML-DSA-87, and a contract on NEAR checks their signatures before any QTC is created. No single key can create QTC.</Qa>
            <Qa q="What is encrypted?">A request for QTC is encrypted with ML-KEM-1024, so only the person asked can read it. Your receipts on NEAR are encrypted with a key from your backup, so only you can find your transfers. Amounts and accounts stay public.</Qa>
            <Qa q="How does QTC come back?">Each NEAR account has a single key, an ML-DSA-65 one, kept by this browser. It signs the withdrawal, and the 2-of-3 safe on Quantus releases your QTC, once.</Qa>
          </div>
        </details>
        <details className={item}>
          <summary className={head}><span className="text-foreground/90">Contracts on NEAR testnet</span>{caret}</summary>
          <dl className="space-y-2 pb-3.5">
            <Row label="Bridge"><Out href={nearAccountLink(ROUTE.bridge)}>{ROUTE.bridge}</Out></Row>
            <Row label="Intents verifier"><Out href={nearAccountLink(ROUTE.verifier)}>{ROUTE.verifier}</Out></Row>
            <Row label="Their access keys">none: nobody can change them</Row>
            {state && <Row label="On NEAR now">{qtc(state.supply)} QTC · {state.redemptions} {state.redemptions === 1 ? 'withdrawal' : 'withdrawals'}</Row>}
          </dl>
        </details>
        <details className={item}>
          <summary className={head}><span className="text-foreground/90">Backup of this browser</span>{caret}</summary>
          <div className="space-y-3 pb-3.5">
            <p className="leading-relaxed">Your NEAR accounts and their keys come from one backup kept in this browser. With it, any browser finds your QTC on NEAR again; without it, nobody can. Keep it secret.</p>
            {seed && <CopyButton value={seedHex(seed)} label="Copy backup" />}
            <div className="flex gap-2">
              <Input value={backup} onChange={(e) => setBackup(e.target.value)} placeholder="Restore: 64 hex characters" spellCheck={false} autoComplete="off" aria-label="Backup to restore" />
              <Button variant="outline" disabled={!backup.trim()} onClick={() => { try { restore(backup); setBackup(''); setError(''); } catch (e) { setError((e as Error).message); } }}>Restore</Button>
            </div>
            {error && <ErrorNote>{error}</ErrorNote>}
          </div>
        </details>
      </div>
    </section>
  );
}
function Qa({ q, children }: { q: string; children: React.ReactNode }) {
  return <div className="space-y-0.5"><p className="font-medium text-foreground/90">{q}</p><p>{children}</p></div>;
}
