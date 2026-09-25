import assert from 'node:assert/strict';
import test from 'node:test';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { MlDsa65Adapter, ShellSigner, buildBatchTransaction, buildTransferTransaction, hashBatchTransaction, hashTransaction } from '../dist/index.js';

test('rotated account signs transfers and batches with its original address and new key', async () => {
  const original = new ShellSigner('MlDsa65', MlDsa65Adapter.generate());
  const adapter = MlDsa65Adapter.generate();
  const derived = new ShellSigner('MlDsa65', adapter).getAddress();
  const signer = new ShellSigner('MlDsa65', adapter, original.getAddress());
  try {
    assert.notEqual(derived, original.getAddress());
    assert.equal(signer.getAddress(), original.getAddress());
    const transfer = buildTransferTransaction({ chainId: 1337, nonce: 2, to: derived, value: 1n });
    const batch = buildBatchTransaction({ chainId: 1337, nonce: 3, innerCalls: [{ to: derived, value: '0x0', data: '0x', gas_limit: '0x5208' }] });
    for (const options of [{ tx: transfer }, { tx: batch.tx, aaBundle: batch.aa_bundle }]) {
      const signed = await signer.buildSignedTransaction({ ...options, includePublicKey: true });
      assert.equal(signed.from, original.getAddress());
      assert.deepEqual(signed.sender_pubkey, Array.from(adapter.getPublicKey()));
      const hash = options.aaBundle
        ? hashBatchTransaction(options.tx, options.aaBundle, signer.signatureType)
        : hashTransaction(options.tx, signer.signatureType);
      assert.equal(ml_dsa65.verify(Uint8Array.from(signed.signature.data), hash, adapter.getPublicKey()), true);
      assert.equal(ml_dsa65.verify(Uint8Array.from(signed.signature.data), hash, original.getPublicKey()), false);
    }
  } finally {
    original.dispose();
    signer.dispose();
  }
});

test('rotated account rejects malformed account addresses before signing', () => {
  const adapter = MlDsa65Adapter.generate();
  try {
    for (const address of ['', '0x1234', `0x${'11'.repeat(20)}`, `0x${'zz'.repeat(32)}`]) {
      assert.throws(() => new ShellSigner('MlDsa65', adapter, address), /address/i);
    }
  } finally {
    adapter.dispose();
  }
});
