import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTransaction } from '../dist/transactions.js';

const recipient = `0x${'11'.repeat(32)}`;
const blobHash = `0x${'22'.repeat(32)}`;

function baseOptions(overrides = {}) {
  return {
    chainId: 1337,
    nonce: 0,
    to: recipient,
    ...overrides,
  };
}

test('buildTransaction rejects blob-only fields on non-blob transactions', () => {
  assert.throws(
    () => buildTransaction(baseOptions({ maxFeePerBlobGas: 1 })),
    /non-blob transactions cannot set maxFeePerBlobGas/,
  );
  assert.throws(
    () => buildTransaction(baseOptions({ blobVersionedHashes: [blobHash] })),
    /non-blob transactions cannot set blobVersionedHashes/,
  );
});

test('buildTransaction requires complete type-3 blob fields', () => {
  assert.throws(
    () => buildTransaction(baseOptions({ txType: 3, blobVersionedHashes: [blobHash] })),
    /require maxFeePerBlobGas/,
  );
  assert.throws(
    () => buildTransaction(baseOptions({ txType: 3, maxFeePerBlobGas: 1 })),
    /require at least one blobVersionedHash/,
  );
  assert.throws(
    () =>
      buildTransaction(
        baseOptions({
          txType: 3,
          maxFeePerBlobGas: 1,
          blobVersionedHashes: Array(7).fill(blobHash),
        }),
      ),
    /at most 6 blobVersionedHashes/,
  );
  assert.throws(
    () =>
      buildTransaction(
        baseOptions({
          txType: 3,
          to: null,
          maxFeePerBlobGas: 1,
          blobVersionedHashes: [blobHash],
        }),
      ),
    /cannot create contracts/,
  );
});

test('buildTransaction accepts valid type-3 blob fields', () => {
  const tx = buildTransaction(
    baseOptions({
      txType: 3,
      maxFeePerBlobGas: 1,
      blobVersionedHashes: [blobHash],
    }),
  );

  assert.equal(tx.tx_type, 3);
  assert.equal(tx.max_fee_per_blob_gas, 1);
  assert.deepEqual(tx.blob_versioned_hashes, [blobHash]);
});
