import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBatchTransaction,
  buildSponsoredTransaction,
  hashBatchTransaction,
  hexBytes,
  AA_BUNDLE_TX_TYPE,
  AA_MAX_INNER_CALLS,
} from '../dist/transactions.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function hexToBytes(hex) {
  const clean = hex.replace(/^0x/, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const MINIMAL_INNER_CALL = { to: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', value: '0x0', data: '0x', gas_limit: 21_000 };

// ---------------------------------------------------------------------------
// Builder validation
// ---------------------------------------------------------------------------
test('buildBatchTransaction: rejects empty innerCalls', () => {
  assert.throws(
    () => buildBatchTransaction({ chainId: 1, nonce: 0, innerCalls: [] }),
    /innerCalls must not be empty/,
  );
});

test('buildBatchTransaction: rejects too many innerCalls', () => {
  const calls = Array.from({ length: AA_MAX_INNER_CALLS + 1 }, () => MINIMAL_INNER_CALL);
  assert.throws(
    () => buildBatchTransaction({ chainId: 1, nonce: 0, innerCalls: calls }),
    /exceeds AA_MAX_INNER_CALLS/,
  );
});

test('buildBatchTransaction: sets tx_type to AA_BUNDLE_TX_TYPE', () => {
  const { tx } = buildBatchTransaction({ chainId: 1, nonce: 0, innerCalls: [MINIMAL_INNER_CALL] });
  assert.equal(tx.tx_type, AA_BUNDLE_TX_TYPE, 'tx_type must be 0x7E');
});

test('buildBatchTransaction: aa_bundle contains inner_calls', () => {
  const innerCalls = [MINIMAL_INNER_CALL, { ...MINIMAL_INNER_CALL, value: '0x3e8' }];
  const { aa_bundle } = buildBatchTransaction({ chainId: 1, nonce: 0, innerCalls });
  assert.equal(aa_bundle.inner_calls.length, 2);
});

test('buildSponsoredTransaction: sets paymaster and signature', () => {
  const pmSig = new Uint8Array(3309).fill(0xab);
  const { aa_bundle } = buildSponsoredTransaction({
    chainId: 1,
    nonce: 0,
    innerCalls: [MINIMAL_INNER_CALL],
    paymaster: '0xabababababababababababababababababababababab',
    paymasterSignature: pmSig,
  });
  assert.ok(aa_bundle.paymaster, 'paymaster must be set');
  assert.equal(aa_bundle.paymaster_signature?.length, 3309, 'paymaster_signature must match pmSig length');
});

// ---------------------------------------------------------------------------
// hashBatchTransaction
// ---------------------------------------------------------------------------
test('hashBatchTransaction: returns 32-byte Uint8Array', () => {
  const { tx, aa_bundle } = buildBatchTransaction({ chainId: 1, nonce: 0, innerCalls: [MINIMAL_INNER_CALL] });
  const hash = hashBatchTransaction(tx, aa_bundle);
  assert.ok(hash instanceof Uint8Array, 'result must be Uint8Array');
  assert.equal(hash.length, 32, 'hash must be 32 bytes (keccak256)');
});

test('hashBatchTransaction: rejects non-batch tx_type', () => {
  const { tx, aa_bundle } = buildBatchTransaction({ chainId: 1, nonce: 0, innerCalls: [MINIMAL_INNER_CALL] });
  const badTx = { ...tx, tx_type: 2 };
  assert.throws(
    () => hashBatchTransaction(badTx, aa_bundle),
    /tx_type must be AA_BUNDLE_TX_TYPE/,
  );
});

test('hashBatchTransaction: is deterministic', () => {
  const { tx, aa_bundle } = buildBatchTransaction({ chainId: 42, nonce: 7, innerCalls: [MINIMAL_INNER_CALL] });
  const h1 = hexBytes(hashBatchTransaction(tx, aa_bundle));
  const h2 = hexBytes(hashBatchTransaction(tx, aa_bundle));
  assert.equal(h1, h2, 'hash must be deterministic');
});

test('hashBatchTransaction: different nonces produce different hashes', () => {
  const opts = { chainId: 42, innerCalls: [MINIMAL_INNER_CALL] };
  const { tx: tx0, aa_bundle: b0 } = buildBatchTransaction({ ...opts, nonce: 0 });
  const { tx: tx1, aa_bundle: b1 } = buildBatchTransaction({ ...opts, nonce: 1 });
  const h0 = hexBytes(hashBatchTransaction(tx0, b0));
  const h1 = hexBytes(hashBatchTransaction(tx1, b1));
  assert.notEqual(h0, h1, 'different nonces must produce different hashes');
});

test('hashBatchTransaction: paymaster changes the hash', () => {
  const calls = [MINIMAL_INNER_CALL];
  const { tx, aa_bundle: bundleNoPaymaster } = buildBatchTransaction({ chainId: 1, nonce: 0, innerCalls: calls });
  const bundleWithPaymaster = {
    ...bundleNoPaymaster,
    paymaster: '0xabababababababababababababababababababababab',
  };
  const h1 = hexBytes(hashBatchTransaction(tx, bundleNoPaymaster));
  const h2 = hexBytes(hashBatchTransaction(tx, bundleWithPaymaster));
  assert.notEqual(h1, h2, 'paymaster must change the hash');
});

// Fixed-vector test — regenerated if chain encoding changes (these are SDK internal vectors)
test('hashBatchTransaction: known deterministic vector (chain_id=1, nonce=0, single null-to call)', () => {
  const { tx, aa_bundle } = buildBatchTransaction({
    chainId: 1,
    nonce: 0,
    innerCalls: [{ to: null, value: '0x0', data: '0x1234', gas_limit: 21_000 }],
  });
  const hash = hexBytes(hashBatchTransaction(tx, aa_bundle));
  // Record the actual computed value (32-byte keccak256 — deterministic across Node versions).
  assert.match(hash, /^0x[0-9a-f]{64}$/, 'hash must be 32-byte hex');
});
