// Abuse limits: per-key quotas, the global gas spend cap, and a bounded work queue.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';

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
 * Hard ceiling on what the relayer may spend, in yoctoNEAR. Every submission reserves a conservative bound
 * of its charge (cost.mjs) up front and is never credited back, so the real spend (most gas is refunded)
 * stays below. Once the next reservation would cross the cap, the relayer pauses for good.
 *
 * With `file`, the reserved total and the pause are written there (atomically, before the reservation
 * counts) and read back at start, so a restart does not reset an exhausted budget. Resuming is a human
 * decision: delete the file, or start with a cap above the one recorded. A file that cannot be read or
 * written keeps the relayer paused.
 */
export class SpendCap {
  constructor(capYocto, { file = null } = {}) {
    this.cap = capYocto;
    this.file = file;
    this.spent = 0n;
    this.paused = capYocto <= 0n;
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved?.version !== 1 || !/^\d+$/.test(saved.reserved_yocto ?? '') || !/^\d+$/.test(saved.cap_yocto ?? '')) {
        throw new Error(`spend state ${file} is malformed; inspect it, then delete it to reset`);
      }
      this.spent = BigInt(saved.reserved_yocto);
      // A recorded pause holds until a human raises the cap above the one it was reached under.
      if (saved.paused === true && capYocto <= BigInt(saved.cap_yocto)) this.paused = true;
      if (this.spent >= capYocto) this.paused = true;
    }
    if (file) this.#save();
  }

  #save() {
    const tmp = `${this.file}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify({ version: 1, cap_yocto: this.cap.toString(), reserved_yocto: this.spent.toString(), paused: this.paused }) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
  }

  reserve(yocto) {
    if (this.paused || this.spent + yocto > this.cap) {
      this.paused = true;
      if (this.file) { try { this.#save(); } catch { /* already paused in memory */ } }
      return false;
    }
    this.spent += yocto;
    if (this.file) {
      try {
        this.#save();
      } catch {
        // Not recorded, not spent: fail closed.
        this.spent -= yocto;
        this.paused = true;
        return false;
      }
    }
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
