'use client';
/** A moving picture of the post-quantum route, beside the form: who signs, with what, and where the QTC is at each
 * moment. On a form it plays as an explanation; while a transfer is followed it stops playing and shows that
 * transfer's real step. */
import { cn } from '@qotc/ui';
import { ArrowUpRightIcon, CheckIcon, EnvelopeSimpleIcon, KeyIcon, LockSimpleIcon, LockSimpleOpenIcon, SealCheckIcon, UserIcon } from '@phosphor-icons/react';
import * as React from 'react';
import { NetworkMark } from '@/components/network-mark';
import { QUANTUS_LOGO } from '@/lib/bridge';
import { chainLogo } from '@/lib/intents-logos';

export type Scene = 'to' | 'back' | 'request' | 'pay';
type Mark = 'wallet' | 'safe' | 'signers' | 'contract' | 'account' | 'you' | 'them';
type Item = 'coin' | 'key' | 'letter' | 'sealed';
interface Stop { mark: Mark; title: string; note: string }
/** One moment of the story: the stop it happens at, the sentence, the scheme at work, and where each item is. Stops
 * are listed in the order the story visits them, so `at` never goes back up: the picture always reads downwards. */
interface Beat { at: number; text: string; scheme?: string; signers?: number; open?: boolean; items: { id: string; kind: Item; row: number; faded?: boolean }[] }
interface Story { title: string; stops: Stop[]; beats: Beat[] }

const ROUTE_STOPS: Stop[] = [
  { mark: 'wallet', title: 'Your Qlyphs wallet', note: 'Quantus' },
  { mark: 'safe', title: 'The safe', note: 'Quantus · needs 2 of 3 keys' },
  { mark: 'signers', title: 'Three signers', note: 'two must agree' },
  { mark: 'contract', title: 'The bridge contract', note: 'NEAR · nobody holds its key' },
  { mark: 'account', title: 'Your NEAR account', note: 'inside NEAR Intents' },
];
/** The same route walked the other way: from the NEAR account back to the wallet. */
const BACK_STOPS: Stop[] = [
  { mark: 'account', title: 'Your NEAR account', note: 'inside NEAR Intents' },
  { mark: 'contract', title: 'The bridge contract', note: 'NEAR · nobody holds its key' },
  { mark: 'signers', title: 'Three signers', note: 'two must agree' },
  { mark: 'safe', title: 'The safe', note: 'Quantus · needs 2 of 3 keys' },
  { mark: 'wallet', title: 'Your Qlyphs wallet', note: 'Quantus' },
];
const people = (first: string, second: string): Stop[] => [
  { mark: 'them', title: first === 'you' ? 'You' : 'They', note: 'the one who pays' },
  { mark: 'you', title: second === 'you' ? 'You' : 'They', note: 'the one who asks' },
  { mark: 'them', title: first === 'you' ? 'Your browser' : 'Their browser', note: 'opens the request' },
  { mark: 'wallet', title: first === 'you' ? 'Your Qlyphs wallet' : 'Their Qlyphs wallet', note: 'pays through the bridge' },
  { mark: 'account', title: second === 'you' ? 'Your NEAR account' : 'Their NEAR account', note: 'inside NEAR Intents' },
];

const STORIES: Record<Scene, Story> = {
  to: {
    title: 'Quantus to NEAR', stops: ROUTE_STOPS,
    beats: [
      { at: 0, scheme: 'ML-DSA-87', text: 'Your wallet signs the transfer with a post-quantum signature.', items: [{ id: 'q', kind: 'coin', row: 0 }] },
      { at: 1, text: 'Your QTC is locked in a safe on Quantus. It opens only with 2 of its 3 keys.', items: [{ id: 'q', kind: 'coin', row: 1 }] },
      { at: 2, scheme: 'ML-DSA-87 ×2', signers: 2, text: 'Two of the three signers see your QTC in the safe, and each signs.', items: [{ id: 'q', kind: 'coin', row: 1, faded: true }] },
      { at: 3, scheme: 'checks both', signers: 2, text: 'The contract on NEAR checks both signatures itself, then creates the same amount.', items: [{ id: 'q', kind: 'coin', row: 1, faded: true }, { id: 'n', kind: 'coin', row: 3 }] },
      { at: 4, scheme: 'ML-DSA-65', signers: 2, text: 'It lands in a new NEAR account. Its only key is post-quantum, and only your browser has it.', items: [{ id: 'q', kind: 'coin', row: 1, faded: true }, { id: 'n', kind: 'coin', row: 4 }] },
    ],
  },
  back: {
    title: 'NEAR back to Quantus', stops: BACK_STOPS,
    beats: [
      { at: 0, scheme: 'ML-DSA-65', text: 'Your NEAR account signs the withdrawal with its own post-quantum key.', items: [{ id: 'n', kind: 'coin', row: 0 }] },
      { at: 1, text: 'The contract destroys the QTC on NEAR and records where to send it on Quantus.', items: [{ id: 'n', kind: 'coin', row: 1, faded: true }] },
      { at: 2, scheme: 'ML-DSA-87 ×2', signers: 2, text: 'Two of the three signers read that record on NEAR, and each signs the release.', items: [{ id: 'n', kind: 'coin', row: 1, faded: true }] },
      { at: 3, signers: 2, open: true, text: 'With two keys the safe opens, once, for exactly that amount.', items: [{ id: 'n', kind: 'coin', row: 1, faded: true }, { id: 'q', kind: 'coin', row: 3 }] },
      { at: 4, signers: 2, open: true, text: 'Your QTC is back in your wallet on Quantus.', items: [{ id: 'n', kind: 'coin', row: 1, faded: true }, { id: 'q', kind: 'coin', row: 4 }] },
    ],
  },
  request: {
    title: 'Asking for QTC', stops: people('they', 'you'),
    beats: [
      { at: 0, scheme: 'ML-KEM-1024 key', text: 'They send you their pay link. It holds their public encryption key.', items: [{ id: 'k', kind: 'key', row: 0 }] },
      { at: 1, scheme: 'ML-DSA-87', text: 'You write the request and sign it, so they know it is yours.', items: [{ id: 'l', kind: 'letter', row: 1 }] },
      { at: 1, scheme: 'ML-KEM-1024', text: 'It is locked with their key. From here on, only they can read it.', items: [{ id: 'l', kind: 'sealed', row: 1 }] },
      { at: 2, scheme: 'ML-KEM-1024', text: 'You send them the link. Their browser opens the request and checks your signature.', items: [{ id: 'l', kind: 'letter', row: 2 }] },
      { at: 3, scheme: 'ML-DSA-87', text: 'They pay from their wallet, through the same bridge.', items: [{ id: 'c', kind: 'coin', row: 3 }] },
      { at: 4, scheme: 'ML-DSA-65', text: 'The QTC arrives in a new NEAR account that only you control.', items: [{ id: 'c', kind: 'coin', row: 4 }] },
    ],
  },
  pay: {
    title: 'Paying a request', stops: people('you', 'they'),
    beats: [
      { at: 0, scheme: 'ML-KEM-1024 key', text: 'You send them your pay link. It holds your public encryption key.', items: [{ id: 'k', kind: 'key', row: 0 }] },
      { at: 1, scheme: 'ML-DSA-87', text: 'They write a request and sign it.', items: [{ id: 'l', kind: 'letter', row: 1 }] },
      { at: 1, scheme: 'ML-KEM-1024', text: 'They lock it with your key. From here on, only you can read it.', items: [{ id: 'l', kind: 'sealed', row: 1 }] },
      { at: 2, scheme: 'ML-KEM-1024', text: 'You open their link. Your browser opens the request and checks their signature.', items: [{ id: 'l', kind: 'letter', row: 2 }] },
      { at: 3, scheme: 'ML-DSA-87', text: 'You pay from your wallet, through the same bridge.', items: [{ id: 'c', kind: 'coin', row: 3 }] },
      { at: 4, scheme: 'ML-DSA-65', text: 'The QTC arrives in a NEAR account that only they control.', items: [{ id: 'c', kind: 'coin', row: 4 }] },
    ],
  },
};
export const beatsIn = (scene: Scene) => STORIES[scene].beats.length;

/** Any two of the three signers are enough: the explanation takes each pair in turn. */
const PAIRS: [number, number][] = [[0, 1], [0, 2], [1, 2]];
const ROW = 68, TILE = 44, LANE = 36, ITEM = 24, BEAT_MS = 3400;

function StopMark({ mark, lit, open }: { mark: Mark; lit: number[]; open: boolean }) {
  const icon = 'size-5';
  switch (mark) {
    case 'wallet': return <NetworkMark src={QUANTUS_LOGO} size={24} className="rounded-full" />;
    case 'account': return <img src={chainLogo('intents') ?? ''} alt="" width={22} height={22} draggable={false} className="rounded-[5px]" />;
    case 'safe': return open ? <LockSimpleOpenIcon key="open" weight="fill" className={cn(icon, 'pop text-primary')} /> : <LockSimpleIcon weight="fill" className={icon} />;
    case 'contract': return <SealCheckIcon weight="fill" className={icon} />;
    case 'signers': return (
      <span className="flex gap-1" aria-hidden="true">
        {[0, 1, 2].map((i) => <span key={i} style={{ transitionDelay: `${i * 160}ms` }} className={cn('size-2.5 rounded-full border transition-colors duration-300', lit.includes(i) ? 'border-primary bg-primary' : 'border-muted-foreground/50')} />)}
      </span>
    );
    case 'you': return <UserIcon weight="fill" className={icon} />;
    case 'them': return <UserIcon weight="regular" className={icon} />;
  }
}
function ItemMark({ kind }: { kind: Item }) {
  if (kind === 'coin') return <NetworkMark src={QUANTUS_LOGO} size={ITEM} className="rounded-full" />;
  const box = 'grid size-6 place-items-center rounded-full bg-foreground text-background';
  if (kind === 'key') return <span className={box}><KeyIcon weight="fill" className="size-3.5" /></span>;
  return (
    <span className={cn(box, 'relative')}>
      <EnvelopeSimpleIcon weight="fill" className="size-3.5" />
      {kind === 'sealed' && <span className="pop absolute -right-1.5 -top-1.5 grid size-3.5 place-items-center rounded-full bg-primary text-primary-foreground"><LockSimpleIcon weight="fill" className="size-2" /></span>}
    </span>
  );
}

/** `live`: the beat a followed transfer is really at; the picture then holds still on it. `pair`: the two signers
 * (0 to 2) that really signed that transfer, when known; without it a followed transfer lights none in particular. */
/** What a followed transfer left at a stop (by its row): a transaction or an account, with a link where one exists. */
export type Records = Partial<Record<number, { label: string; href?: string; title?: string }>>;

export function RouteDiagram({ scene, live, liveLabel = 'Your transfer', pair, records, className }: { scene: Scene; live?: number | null; liveLabel?: string; pair?: [number, number] | null; records?: Records; className?: string }) {
  const story = STORIES[scene];
  const n = story.beats.length;
  // One counter for the explanation: the beat is tick mod n, each pass a new round (and a new pair of signers).
  // The counter belongs to the story it was counted for: a new story starts at its first beat in the very first render,
  // never showing the old story's position for a frame.
  const [count, setCount] = React.useState({ scene, tick: 0 });
  const tick = count.scene === scene ? count.tick : 0;
  const setTick = (k: number) => setCount({ scene, tick: k });
  const [held, setHeld] = React.useState(false);
  const following = live != null;
  React.useEffect(() => { setHeld(false); }, [scene]);
  React.useEffect(() => {
    if (following || held) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t = setInterval(() => setCount((c) => ({ scene, tick: c.scene === scene ? c.tick + 1 : 1 })), BEAT_MS);
    return () => clearInterval(t);
  }, [following, held, scene]);
  const round = Math.floor(tick / n);
  const index = Math.min(following ? live! : tick % n, n - 1);
  const beat = story.beats[index]!;
  const lit = !beat.signers ? [] : following ? pair ?? [] : PAIRS[round % PAIRS.length]!;
  const done = (i: number) => i < beat.at || (following && index === n - 1 && i === beat.at);
  // A new story, a new pass of the explanation, or the switch to a real transfer starts on a fresh stage that fades
  // in, rather than items flying back up across it.
  const stage = `${scene}:${following ? 'live' : round}`;
  const ids = [...new Set(story.beats.flatMap((b) => b.items.map((i) => i.id)))];

  return (
    <section aria-label={`How it works: ${story.title}`} className={cn('settle w-full rounded-2xl border border-border bg-card/40 p-4 sm:p-5', className)}
      onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">{story.title}</h2>
        {following
          ? <span className="inline-flex items-center gap-1.5 text-xs text-primary"><span className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse" />{liveLabel}</span>
          : <span className="text-xs text-muted-foreground">How it works</span>}
      </div>

      <div key={stage} className="step-in relative mt-4" style={{ height: ROW * (story.stops.length - 1) + TILE }}>
        {/* The track the items ride, filled down to where the story is, with a station at each stop. */}
        <span aria-hidden="true" className="absolute w-px bg-border" style={{ left: ITEM / 2, top: TILE / 2, height: ROW * (story.stops.length - 1) }} />
        <span aria-hidden="true" className="absolute w-px origin-top bg-primary/70 transition-transform duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none"
          style={{ left: ITEM / 2, top: TILE / 2, height: ROW * (story.stops.length - 1), transform: `scaleY(${beat.at / (story.stops.length - 1)})` }} />
        {story.stops.map((_, i) => <span key={i} aria-hidden="true" className={cn('absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border transition-colors duration-300', beat.at === i ? 'border-primary bg-primary' : done(i) ? 'border-primary/70 bg-card' : 'border-border bg-card')} style={{ left: ITEM / 2, top: i * ROW + TILE / 2 }} />)}
        {story.stops.map((s, i) => {
          const on = beat.at === i, seen = done(i);
          return (
            <div key={i} className="absolute right-0 flex items-center gap-3" style={{ left: LANE, top: i * ROW, height: TILE }}>
              <span className={cn('relative grid shrink-0 place-items-center rounded-xl border bg-card transition-[border-color,background-color,color,scale] duration-300',
                on ? 'scale-105 border-primary/70 bg-primary/10 text-foreground' : seen ? 'border-foreground/30 text-foreground' : 'border-border text-muted-foreground')} style={{ width: TILE, height: TILE }}>
                <StopMark mark={s.mark} lit={lit} open={!!beat.open} />
                {seen && <span key="done" className="pop absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full bg-foreground text-background ring-2 ring-card"><CheckIcon weight="bold" className="size-2.5" /></span>}
              </span>
              <span className={cn('min-w-0 flex-1 leading-tight transition-opacity duration-300', !on && !seen && 'opacity-55')}>
                <span className={cn('block truncate text-sm', on && 'font-medium')}>{s.title}</span>
                {following && records?.[i] ? (
                  records[i]!.href
                    ? <a key="record" href={records[i]!.href} target="_blank" rel="noopener noreferrer" title={records[i]!.title} className="settle inline-flex max-w-full items-center gap-0.5 text-[11px] text-foreground/90 underline decoration-border underline-offset-4 hover:text-foreground"><span className="truncate">{records[i]!.label}</span><ArrowUpRightIcon aria-hidden="true" className="size-3 shrink-0" /></a>
                    : <span key="record" title={records[i]!.title} className="settle block truncate font-mono text-[11px] text-foreground/80">{records[i]!.label}</span>
                ) : <span className="block truncate text-[11px] text-muted-foreground">{s.note}</span>}
              </span>
              {on && beat.scheme && <span key={`${index}`} className="arrive shrink-0 rounded-full bg-primary/15 px-2 py-0.5 font-mono text-[10px] text-primary">{beat.scheme}</span>}
            </div>
          );
        })}
        {ids.map((id) => {
          const here = beat.items.find((i) => i.id === id);
          // An item not in this beat stays where it was last (or will first be), invisible, so it never flies in. Items
          // only ever move down, the way the story goes.
          const last = [...story.beats.slice(0, index)].reverse().flatMap((b) => b.items).find((i) => i.id === id) ?? story.beats.flatMap((b) => b.items).find((i) => i.id === id)!;
          const at = here ?? last;
          return (
            <span key={id} aria-hidden="true" className="absolute left-0 top-0 transition-[transform,opacity] duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none"
              style={{ transform: `translate(0px, ${at.row * ROW + (TILE - ITEM) / 2}px)`, opacity: here ? 1 : 0 }}>
              <span className={cn('block rounded-full ring-4 ring-card transition-[filter,opacity] duration-500', here?.faded && 'opacity-40 grayscale')}><ItemMark kind={at.kind} /></span>
            </span>
          );
        })}
      </div>

      <p key={`${stage}:${index}`} aria-live={following ? 'polite' : 'off'} className="step-in mt-4 min-h-[3.75rem] text-pretty text-sm leading-relaxed">{beat.text}</p>
      <div key={scene} className="mt-2 flex items-center gap-1.5" role="group" aria-label="Steps of the explanation">
        {story.beats.map((_, i) => (
          <button key={i} type="button" disabled={following} aria-label={`Step ${i + 1} of ${story.beats.length}`} aria-current={i === index ? 'step' : undefined} onClick={() => { setTick(round * n + i); setHeld(true); }}
            className="group grid h-6 flex-1 place-items-center disabled:cursor-default">
            <span className={cn('h-1 w-full rounded-full transition-colors duration-300', i === index ? 'bg-primary' : i < index ? 'bg-foreground/40' : 'bg-muted group-enabled:group-hover:bg-foreground/25')} />
          </button>
        ))}
      </div>
    </section>
  );
}
