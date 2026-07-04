import assert from 'node:assert/strict';
import test from 'node:test';

import { derivePqAddressFromPublicKey, deriveShellAddressFromPublicKey } from '../dist/address.js';

test('deriveShellAddressFromPublicKey rejects non-byte algorithm ids', () => {
  const publicKey = new Uint8Array([1, 2, 3]);

  assert.throws(() => deriveShellAddressFromPublicKey(publicKey, -1), /invalid algorithm id/);
  assert.throws(() => deriveShellAddressFromPublicKey(publicKey, 256), /invalid algorithm id/);
  assert.throws(() => deriveShellAddressFromPublicKey(publicKey, 1.5), /invalid algorithm id/);
  assert.throws(() => deriveShellAddressFromPublicKey(publicKey, Number.NaN), /invalid algorithm id/);
});

test('derivePqAddressFromPublicKey legacy alias keeps algorithm id validation', () => {
  const publicKey = new Uint8Array([1, 2, 3]);

  assert.throws(() => derivePqAddressFromPublicKey(publicKey, 1.5), /invalid algorithm id/);
});
