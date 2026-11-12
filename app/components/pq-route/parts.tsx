'use client';
/** Shared pieces of the post-quantum route screens: QTC amounts, the two sides of the bridge, a transfer's steps
 * with the scheme that signs each one, status chips, and copy buttons. */
import { Button, cn } from '@qotc/ui';
import { ArrowLeftIcon, ArrowUpRightIcon, CheckIcon, CopyIcon } from '@phosphor-icons/react';
import * as React from 'react';
import { CheckDraw } from '@/components/check-draw';
import { CopyFeedback, useCopyText } from '@/components/copy-feedback';
import { AssetMark } from '@/components/intents-parts';
import { StepBar } from '@/components/step-bar';
import { QTC_ASSET } from '@/lib/intents';
import { ROUTE } from '@/lib/pq-route/route';

const UNIT = 10n ** 12n;
/** Planck as QTC, with at most six decimals. */
export const qtc = (planck: string | bigint) => {
  const p = BigInt(planck), whole = p / UNIT, frac = (p % UNIT).toString().padStart(12, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac.slice(0, 6)}` : `${whole}`;
};
/** A typed QTC amount as planck, or null when it is not one. */
export const toPlanck = (s: string): bigint | null => {
  const m = s.trim().match(/^(\d{1,9})(?:\.(\d{1,12}))?$/);
  return m ? BigInt(m[1]!) * UNIT + BigInt((m[2] ?? '').padEnd(12, '0') || '0') : null;
};
/** The smallest transfer the bridge contract mints. */
export const MINIMUM = 10n ** 10n;
export const nearTxLink = (h: string) => `${ROUTE.nearExplorer}/txns/${h}`;
export const nearAccountLink = (a: string) => `${ROUTE.nearExplorer}/address/${a}`;
export const when = (ms: number) => new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const short = (s: string, head = 8, tail = 6) => (s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`);

/** A card of a form. Its big field draws no ring of its own, so the card carries the focus edge. */
export const CARD =
  'rounded-xl border border-border bg-background/60 p-[clamp(0.75rem,1.9dvh,1rem)] transition-colors has-[input:focus-visible]:border-foreground/60 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:-outline-offset-2 has-[input:focus-visible]:outline-foreground/60';
export const BIG = 'text-[clamp(1.5rem,4.4dvh,2rem)] font-semibold tracking-[-0.03em] tabular-nums';
/** The same figure as a field: above the 16px phone floor, so Safari does not zoom. */
export const BIG_INPUT = '!text-[clamp(1.5rem,4.4dvh,2rem)] font-semibold tracking-[-0.03em] tabular-nums';
export const CTA = 'mt-[clamp(0.75rem,1.8dvh,1rem)] min-h-[clamp(2.75rem,6dvh,3rem)] w-full text-base';

/** QTC and where it is: on Quantus, or inside NEAR Intents. */
export function QtcChip({ where }: { where: 'quantus' | 'near' }) {
  return (
    <span className="flex shrink-0 items-center gap-2 rounded-full bg-muted py-1 pl-1 pr-3">
      <AssetMark token={{ asset: QTC_ASSET, symbol: 'QTC', chain: 'qtc' }} size={26} intents={where === 'near'} />
      <span className="flex min-w-0 flex-col text-left leading-tight">
        <span className="text-sm font-medium">QTC</span>
        <span className="text-[11px] text-muted-foreground">{where === 'near' ? 'NEAR Intents' : 'Quantus'}</span>
      </span>
    </span>
  );
}
export function QtcMark({ where, size = 32 }: { where: 'quantus' | 'near'; size?: number }) {
  return <AssetMark token={{ asset: QTC_ASSET, symbol: 'QTC', chain: 'qtc' }} size={size} intents={where === 'near'} />;
}

export type Tone = 'progress' | 'done' | 'quiet' | 'warn';
/** Where something stands, in one or two words. */
export function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const tones: Record<Tone, string> = { progress: 'bg-primary/15 text-primary', done: 'bg-success/15 text-success', quiet: 'bg-muted text-muted-foreground', warn: 'bg-warning/15 text-warning' };
  return <span key={String(children)} className={cn('arrive inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-medium', tones[tone])}>{children}</span>;
}

/** One step of a transfer. `act`: waiting for the person (their wallet); `now`: under way; `paused`: next, but
 * nothing is running. `scheme` names what signs or encrypts the step. */
export interface StepRow {
  title: string;
  sub?: React.ReactNode;
  scheme?: string;
  state: 'done' | 'now' | 'act' | 'paused' | 'ahead';
  /** A counted wait, 0 to 1 (blocks towards finality). */
  share?: number | null;
}
/** A transfer's steps from top to bottom, joined by a line that fills as they complete. */
export function Steps({ rows }: { rows: StepRow[] }) {
  return (
    <ol className="px-1" aria-live="polite">
      {rows.map((r, i) => {
        const open = r.state === 'now' || r.state === 'act' || r.state === 'paused';
        return (
          <li key={r.title} className="relative flex gap-3 pb-4 last:pb-0">
            {i < rows.length - 1 && <span aria-hidden="true" className={cn('absolute bottom-0 left-[9.5px] top-6 w-px transition-colors duration-500', r.state === 'done' ? 'bg-foreground/50' : 'bg-border')} />}
            <span
              key={r.state === 'done' ? 'done' : 'open'}
              className={cn('relative mt-px grid size-5 shrink-0 place-items-center rounded-full border transition-colors',
                r.state === 'done' && 'pop border-foreground bg-foreground text-background',
                (r.state === 'now' || r.state === 'act') && 'border-primary',
                r.state === 'paused' && 'border-foreground/60',
                r.state === 'ahead' && 'border-border')}
            >
              {r.state === 'done' ? <CheckDraw className="size-3" />
                : open ? <span className={cn('size-2 rounded-full', r.state === 'paused' ? 'bg-foreground/60' : 'bg-primary motion-safe:animate-pulse')} /> : null}
            </span>
            <div className={cn('min-w-0 flex-1 transition-opacity duration-300', r.state === 'ahead' && 'opacity-50')}>
              <div className="flex items-baseline justify-between gap-3">
                <p className={cn('text-sm', open && 'font-medium')}>{r.title}</p>
                {r.scheme && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{r.scheme}</span>}
              </div>
              {r.sub && <p key={typeof r.sub === 'string' ? r.sub : undefined} className={cn('settle mt-0.5 text-xs', r.state === 'act' ? 'text-primary' : 'text-muted-foreground')}>{r.sub}</p>}
              {r.state === 'now' && r.share != null && <div className="mt-2 grid"><StepBar state="current" share={r.share} /></div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** A link out to a public record (NEAR explorer). */
export function Out({ href, children }: { href: string; children: React.ReactNode }) {
  return <a className="inline-flex items-center gap-0.5 underline decoration-border underline-offset-4 transition-colors hover:text-foreground" href={href} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRightIcon aria-hidden="true" className="size-3" /></a>;
}

export function BackLink({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} className="-ml-1 mb-3 inline-flex min-h-11 items-center gap-1 rounded-md px-1 text-xs text-muted-foreground transition-colors hover:text-foreground sm:min-h-8">
      <ArrowLeftIcon aria-hidden="true" className="size-3.5" />{label}
    </button>
  );
}

/** A button that copies a long value (a link) and says so; a failed copy shows the value to copy by hand. */
export function CopyButton({ value, label, primary = false, className }: { value: string; label: string; primary?: boolean; className?: string }) {
  const { status, copy } = useCopyText(value);
  return (
    <div className={className}>
      <Button type="button" variant={primary ? 'primary' : 'outline'} className="min-h-12 w-full gap-2 text-base" onClick={copy}>
        {status === 'copied' ? <CheckIcon aria-hidden="true" weight="bold" className="pop size-4" /> : <CopyIcon aria-hidden="true" className="size-4" />}
        {status === 'copied' ? 'Copied' : label}
      </Button>
      <CopyFeedback status={status} value={value} label={label} />
    </div>
  );
}

/** A label and its value on one line of a summary. */
export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right tabular-nums [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** A sealed request as the route service stores it: the first bytes of what only the payer's key can open. */
export function Sealed({ preview, bytes, label }: { preview: string; bytes: number; label: string }) {
  return (
    <figure className="rounded-xl border border-dashed border-border bg-background/40 px-3 py-2.5">
      <figcaption className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{bytes.toLocaleString('en-US')} bytes</span>
      </figcaption>
      <p aria-hidden="true" className="mt-1.5 flex flex-wrap gap-x-[1ch] font-mono text-[11px] leading-relaxed text-muted-foreground/70 [mask-image:linear-gradient(to_bottom,black_45%,transparent)]">
        {(preview.match(/.{1,8}/g) ?? []).map((g, i) => <span key={i}>{g}</span>)}
      </p>
    </figure>
  );
}
/** The first bytes of a sealed request, as hex, for Sealed. */
export const sealedPreview = (b: Uint8Array) => Array.from(b.subarray(0, 64), (x) => x.toString(16).padStart(2, '0')).join('');

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return <p role="alert" className="settle mt-3 text-pretty text-sm text-destructive">{children}</p>;
}
