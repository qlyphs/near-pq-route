// One writer per state directory: an exclusive lock file holding the owner's pid.
import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists, owned by someone else
  }
};

/**
 * Takes `<dir>/relayer.lock` (created with O_EXCL) or throws. A lock held by a running pid always refuses,
 * a reused pid included: two relayers writing one spend file would undo each other's reservations. A lock
 * left by a dead pid, or one that cannot be read, is cleared only with `clearStale` (RELAYER_CLEAR_STALE_LOCK=1),
 * a human decision taken once the other instance is known to be gone. Returns `release()`.
 */
export function acquireLock(dir, { clearStale = false } = {}) {
  const file = join(dir, 'relayer.lock');
  const mine = `${process.pid}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = openSync(file, 'wx', 0o600);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let text = '';
      try { text = readFileSync(file, 'utf8'); } catch { /* vanished or unreadable: treated as malformed */ }
      const pid = /^\d+\n?$/.test(text) ? Number(text) : null;
      if (pid !== null && alive(pid)) throw new Error(`state dir ${dir} is locked by running process ${pid}`);
      if (!clearStale) {
        throw new Error(`state dir ${dir} has a stale lock (${pid === null ? 'unreadable' : `pid ${pid} is not running`}); `
          + 'make sure no other relayer uses this directory, then start once with RELAYER_CLEAR_STALE_LOCK=1');
      }
      try { unlinkSync(file); } catch (u) { if (u.code !== 'ENOENT') throw u; }
      continue;
    }
    try {
      writeSync(fd, mine);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      try { if (readFileSync(file, 'utf8') === mine) unlinkSync(file); } catch { /* already gone */ }
    };
    process.once('exit', release);
    return () => { process.off('exit', release); release(); };
  }
  throw new Error(`state dir ${dir}: lock taken by another process while clearing a stale one`);
}
