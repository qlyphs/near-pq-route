/**
 * The page's payment steps, built from a saved payment's terms only: they never fetch or reopen the request, so a
 * payment already under way finishes after the request expired or the request service went away.
 */
import { classifyMint, type Payment, type Steps } from './payment.ts';
import { sha256 } from '@noble/hashes/sha2.js';

export interface PayIO {
  /** The wallet's QTC transfer to the lock; resolves false when the wallet did not confirm it. */
  sendQtc(to: string, amount: string, onSent: (hash: string) => void): Promise<boolean>;
  findInclusion(hash: string): Promise<{ blockHash: string; index: number } | null>;
  depositId(blockHash: string, index: number): string;
  /** The 240-byte route and the site session challenge over it (route.ts), from explicit inputs. */
  routeChallenge(p: Payment, depositId: string): string;
  signSessionChallenge(challenge: string): Promise<{ signature: string; publicKey: string }>;
  postClaim(claim: unknown): Promise<unknown>;
  depositMinted(depositId: string): Promise<boolean>;
  /** The route Worker's pointer to the mint transaction, or null when none is recorded yet. */
  mintPointer(depositId: string): Promise<{ tx: string; signer: string } | null>;
  /** That transaction read from NEAR at FINAL (the page checks it itself). */
  nearTx(hash: string, signer: string): Promise<unknown>;
  sleep(ms: number): Promise<void>;
}

export function stepsFor(io: PayIO): Steps {
  return {
    async send(p, onSent) {
      const ok = await io.sendQtc(p.terms.route.lockAccountId, p.terms.request.amount, onSent);
      if (!ok) throw new Error('The wallet did not confirm the lock transfer');
    },
    async locate(hash) {
      for (let i = 0; i < 30; i++) { const at = await io.findInclusion(hash); if (at) return at; await io.sleep(4000); }
      return null;
    },
    depositId: (b, i) => io.depositId(b, i),
    challenge: (p) => io.routeChallenge(p, p.depositId!),
    // The wallet parses only canonical 0x hex; the claim and the saved payment keep the bare hex.
    sign: (c) => io.signSessionChallenge(`0x${c.replace(/^0x/, '')}`),
    async post(p) {
      const r = p.terms.request;
      await io.postClaim({ publicKey: p.publicKey!.replace(/^0x/, ''), blockHash: p.blockHash, extrinsicIndex: p.index,
        route: { receiver: r.account, intents: true, receipt: r.receipt, accountKey: r.accountKey },
        proof: { challenge: p.challenge, signature: p.signature!.replace(/^0x/, '') } });
    },
    async consumed(dep) {
      for (let i = 0; i < 60; i++) { if (await io.depositMinted(dep).catch(() => false)) return true; await io.sleep(10_000); }
      return false;
    },
    async delivery(p) {
      // The service publishes the mint's pointer just after the mint, and NEAR may not serve it at FINAL yet:
      // keep reading for a while instead of stopping on the first miss.
      let last: 'pending' | 'unknown' = 'pending';
      for (let i = 0; i < 36; i++) {
        if (i) await io.sleep(5_000);
        const ptr = await io.mintPointer(p.depositId!).catch(() => null);
        if (!ptr) { last = 'pending'; continue; }
        const tx = await io.nearTx(ptr.tx, ptr.signer).catch(() => null) as { transaction?: { hash?: string; signer_id?: string } } | null;
        // The answer must be the transaction the pointer names, from the signer it names.
        if (!tx || tx.transaction?.hash !== ptr.tx || tx.transaction?.signer_id !== ptr.signer) { last = 'unknown'; continue; }
        const d = classifyMint(tx, p, sha256);
        if (d !== 'unknown') return d;
        last = 'unknown';
      }
      return last;
    },
  };
}
