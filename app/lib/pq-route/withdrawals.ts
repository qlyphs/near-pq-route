/**
 * Withdrawals from NEAR back to Quantus, remembered in this browser so the page can follow them after a reload.
 * Display only: the withdrawal itself is final on NEAR before it is saved here, and the release on Quantus never
 * depends on this record. Arrival is read from the destination's Quantus balance.
 */
export interface Withdrawal {
  /** The NEAR account that withdrew, and its final transaction. */
  account: string;
  tx: string;
  /** Planck. */
  amount: string;
  /** The Quantus account id (0x + 64 hex) the QTC is released to. */
  dest: string;
  at: number;
  /** Withdrawals started by one click share a batch (the time of the click). */
  batch?: number;
  /** The destination's free balance just before the withdrawal, or null when it could not be read. */
  baseline: string | null;
  arrivedAt?: number;
}

const KEY = 'qlyphs:pq-route:withdrawals';
const KEEP = 20;

export function loadWithdrawals(): Withdrawal[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((w) => w && typeof w.tx === 'string' && typeof w.amount === 'string' && typeof w.dest === 'string') : [];
  } catch { return []; }
}
export function saveWithdrawals(list: Withdrawal[]): void {
  localStorage.setItem(KEY, JSON.stringify(list.slice(-KEEP)));
}

/**
 * Marks the withdrawals to `dest` that its balance now accounts for, oldest first: one has arrived once the free
 * balance exceeds its baseline by its amount. The baseline of those still waiting moves up by what arrived, so one
 * release is never counted for two withdrawals. A withdrawal with no baseline is never marked.
 */
export function markArrivals(list: Withdrawal[], dest: string, free: bigint, now: number): Withdrawal[] {
  let floor = 0n;
  return [...list].sort((a, b) => a.at - b.at).map((w) => {
    if (w.dest !== dest || w.arrivedAt || w.baseline === null) return w;
    const base = BigInt(w.baseline) > floor ? BigInt(w.baseline) : floor;
    if (free < base + BigInt(w.amount)) return base === BigInt(w.baseline) ? w : { ...w, baseline: String(base) };
    floor = base + BigInt(w.amount);
    return { ...w, arrivedAt: now };
  });
}
