// Abuse limits: per-key quotas, the global gas spend cap, and a bounded work queue.
import { createHash } from 'node:crypto';

const digest = (s) => createHash('sha256').update(s).digest('hex');

/** Fixed-window counters. Keys are hashed so the relayer keeps no raw IP or account id. */
export class Quota {
  constructor({ limit, windowMs, maxKeys = 10000, now = Date.now }) {
    Object.assign(this, { limit, windowMs, maxKeys, now });
    this.counts = new Map();
  }

  /** Counts one use of `key`; false (and not counted) once the window's limit is reached. */
  take(key) {
    const k = digest(key), t = this.now();
    let c = this.counts.get(k);
    if (!c || t - c.start >= this.windowMs) c = { start: t, used: 0 };
    if (c.used >= this.limit) return false;
    c.used++;
    this.counts.delete(k);
    this.counts.set(k, c);
    // Oldest-touched first: under a flood of new keys the oldest windows are forgotten, never the cap.
    while (this.counts.size > this.maxKeys) this.counts.delete(this.counts.keys().next().value);
    return true;
  }

  /** Gives back a use taken for a request that was then not submitted. */
  untake(key) {
    const c = this.counts.get(digest(key));
    if (c && c.used > 0) c.used--;
  }
}

/**
 * Hard ceiling on the gas budget the relayer attaches, in yoctoNEAR. Every submission reserves its full
 * prepaid budget up front and is never credited back, so the real spend (most gas is refunded) stays below.
 * Once the next submission would cross the cap, the relayer pauses for good: restarting is a human decision.
 */
export class SpendCap {
  constructor(capYocto) {
    this.cap = capYocto;
    this.spent = 0n;
    this.paused = capYocto <= 0n;
  }

  reserve(yocto) {
    if (this.paused || this.spent + yocto > this.cap) {
      this.paused = true;
      return false;
    }
    this.spent += yocto;
    return true;
  }
}

export class Busy extends Error {}

/** Runs at most `concurrency` jobs at once and queues at most `queue` more; beyond that, refuses with Busy. */
export class Limiter {
  constructor({ concurrency, queue }) {
    Object.assign(this, { concurrency, queue });
    this.active = 0;
    this.waiting = [];
  }

  async run(job) {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.queue) throw new Busy('relayer is busy');
      await new Promise((go) => this.waiting.push(go));
    } else {
      this.active++;
    }
    try {
      return await job();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }
}
