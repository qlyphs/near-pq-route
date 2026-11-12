/**
 * Payment requests this browser created, remembered so the page can show their link again and say when they were
 * paid. Display only and nothing secret: the link holds the request's id and the hash of the requester's card; the
 * account and its key are derived again from the backup.
 */
export interface Ask {
  /** The request's id at the route service. */
  id: string;
  /** The payment link to send to the payer. */
  url: string;
  /** The NEAR account the QTC arrives in. */
  account: string;
  /** Planck. */
  amount: string;
  memo: string;
  /** A short label of the payer's key (keyLabel). */
  payer: string;
  /** Size of the sealed request, in bytes. */
  bytes: number;
  /** Its first bytes, as hex: what the route service stores, shown beside the link. */
  preview?: string;
  createdAt: number;
  expiresAt: number;
  paidAt?: number;
  /** Set when the requester gave the request up here. The link they sent still works until it expires. */
  cancelledAt?: number;
}

const KEY = 'qlyphs:pq-route:requests';
const KEEP = 20;

export function loadAsks(): Ask[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((a) => a && typeof a.id === 'string' && typeof a.url === 'string' && typeof a.amount === 'string' && typeof a.account === 'string') : [];
  } catch { return []; }
}
export function saveAsks(list: Ask[]): void {
  localStorage.setItem(KEY, JSON.stringify(list.slice(-KEEP)));
}
export type AskState = 'paid' | 'cancelled' | 'expired' | 'waiting';
/** Paid wins over cancelled: a cancelled request that is paid before it expires was still paid. */
export const askState = (a: Ask, now: number): AskState => (a.paidAt ? 'paid' : a.cancelledAt ? 'cancelled' : now > a.expiresAt ? 'expired' : 'waiting');
/** Whether a payment can still arrive for it, so the page keeps reading its account. */
export const askPayable = (a: Ask, now: number): boolean => !a.paidAt && now <= a.expiresAt;
