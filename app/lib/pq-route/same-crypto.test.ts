// The page's route cryptography is the repository's SDK, byte for byte below the first (header) line.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const body = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').split('\n').slice(1).join('\n');

test('app/lib/pq-route/crypto.js is sdk/route-crypto.mjs', () => {
  assert.equal(body('./crypto.js'), body('../../../sdk/route-crypto.mjs'));
});
