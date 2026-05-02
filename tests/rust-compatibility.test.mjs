import assert from 'node:assert/strict';
import test from 'node:test';

import { derivePqAddressFromPublicKey } from '../dist/address.js';
import { hashTransaction, hexBytes } from '../dist/transactions.js';
import { generateMlDsa65KeyPair } from '../dist/adapters.js';
import { MlDsa65Adapter } from '../dist/adapters.js';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';

import fixture from './fixtures/rust-compatibility.json' with { type: 'json' };

test('rust compatibility: address derivation vectors match shell-chain', () => {
  for (const vector of fixture.addresses) {
    const publicKey = hexToBytes(vector.public_key_hex);
    const derived = derivePqAddressFromPublicKey(publicKey, vector.algo_id);

    assert.equal(derived, vector.pq_address, `pq address mismatch for ${vector.name}`);
  }
});

test('rust compatibility: transaction hash vectors match shell-chain', () => {
  for (const vector of fixture.transactions) {
    const hash = hashTransaction(vector.tx);
    assert.equal(hexBytes(hash), vector.hash_hex, `tx hash mismatch for ${vector.name}`);
  }
});

test('signing: ML-DSA-65 key/signature sizes match pqcrypto-dilithium v0.5', () => {
  // pqcrypto-dilithium 0.5 (shell-chain) implements FIPS 204 ML-DSA-65.
  // Verify that @noble/post-quantum produces byte-identical key and signature sizes.
  const kp = generateMlDsa65KeyPair();
  assert.equal(kp.publicKey.length, 1952, 'publicKey must be 1952 bytes (ML-DSA-65 FIPS 204)');
  assert.equal(kp.secretKey.length, 4032, 'secretKey must be 4032 bytes (ML-DSA-65 FIPS 204)');

  const msg = new Uint8Array(32).fill(0xab);
  const sig = ml_dsa65.sign(msg, kp.secretKey);
  assert.equal(sig.length, 3309, 'signature must be 3309 bytes (ML-DSA-65 FIPS 204)');

  const valid = ml_dsa65.verify(sig, msg, kp.publicKey);
  assert.equal(valid, true, 'signature must verify');
});

test('signing: MlDsa65Adapter round-trip sign+verify', async () => {
  const adapter = MlDsa65Adapter.generate();
  const msg = new Uint8Array([1, 2, 3, 4, 5]);
  const sig = await adapter.sign(msg);
  assert.equal(sig.length, 3309, 'adapter signature size must be 3309');
  const valid = ml_dsa65.verify(sig, msg, adapter.getPublicKey());
  assert.equal(valid, true, 'adapter signature must verify with @noble/post-quantum');
});

function hexToBytes(hex) {
  const clean = hex.replace(/^0x/, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
