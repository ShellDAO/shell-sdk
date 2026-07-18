import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBatchTransaction,
  buildTransaction,
  buildSponsoredTransaction,
  buildContractPaymasterTransaction,
  buildSessionKeyTransaction,
  buildSignedTransaction,
  buildInnerTransfer,
  buildInnerCall,
  hashBatchTransaction,
  hashPaymasterTransaction,
  hexBytes,
  AA_BUNDLE_TX_TYPE,
  AA_MAX_INNER_CALLS,
} from '../dist/transactions.js';
import { AA_MAX_PAYMASTER_CONTEXT } from '../dist/types.js';

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

// gas_limit must be a hex quantity string per JSON-RPC wire format
const MINIMAL_INNER_CALL = { to: '0x0000000000000000000000000000000000000000000000000000000000000042', value: '0x0', data: '0x', gas_limit: '0x5208' };

// ---------------------------------------------------------------------------
// Builder validation
// ---------------------------------------------------------------------------
test('buildTransaction: rejects priority fee above max fee', () => {
  assert.throws(
    () =>
      buildTransaction({
        chainId: 1,
        nonce: 0,
        to: null,
        maxFeePerGas: 100,
        maxPriorityFeePerGas: 101,
      }),
    /maxPriorityFeePerGas must not exceed maxFeePerGas/,
  );
});

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

test('buildBatchTransaction: validates raw inner call fields', () => {
  const invalidCalls = [
    [{ ...MINIMAL_INNER_CALL, to: '0x1234' }, /innerCalls\[0\]\.to must be .*valid Shell address/],
    [{ ...MINIMAL_INNER_CALL, data: '0x0' }, /innerCalls\[0\]\.data must be .*byte-aligned hex data/],
    [{ ...MINIMAL_INNER_CALL, data: '0x' + '00'.repeat(128 * 1024 + 1) }, /innerCalls\[0\]\.data exceeds maximum size of 131072 bytes/],
    [{ ...MINIMAL_INNER_CALL, value: '0x00' }, /innerCalls\[0\]\.value must be a canonical .*hex quantity/],
    [{ ...MINIMAL_INNER_CALL, value: '0x1' + '0'.repeat(64) }, /innerCalls\[0\]\.value must fit in u256/],
    [{ ...MINIMAL_INNER_CALL, gas_limit: '12' }, /innerCalls\[0\]\.gas_limit must be a canonical .*hex quantity/],
    [{ ...MINIMAL_INNER_CALL, gas_limit: '0x10000000000000000' }, /innerCalls\[0\]\.gas_limit must fit in u64/],
  ];

  for (const [innerCall, expectedError] of invalidCalls) {
    assert.throws(
      () => buildBatchTransaction({ chainId: 1, nonce: 0, innerCalls: [innerCall] }),
      expectedError,
    );
  }
});

test('buildBatchTransaction: derives the outer value budget from inner calls', () => {
  const calls = [
    { ...MINIMAL_INNER_CALL, value: '0x2' },
    { ...MINIMAL_INNER_CALL, value: '0x3' },
  ];
  const { tx } = buildBatchTransaction({ chainId: 1, nonce: 0, innerCalls: calls });
  assert.equal(tx.value, '0x5');
});

test('buildBatchTransaction: rejects aggregate value and gas overflow boundaries', () => {
  assert.throws(
    () => buildBatchTransaction({
      chainId: 1,
      nonce: 0,
      innerCalls: [
        { ...MINIMAL_INNER_CALL, value: '0x' + 'f'.repeat(64) },
        { ...MINIMAL_INNER_CALL, value: '0x1' },
      ],
    }),
    /sum\(innerCalls\[\]\.value\) must fit in u256/,
  );
  assert.throws(
    () => buildBatchTransaction({
      chainId: 1,
      nonce: 0,
      innerCalls: [MINIMAL_INNER_CALL],
      gasLimit: 73_999,
    }),
    /gasLimit must cover AA intrinsic gas \(74000\)/,
  );
});

test('buildSessionKeyTransaction: includes the session verification gas surcharge', () => {
  assert.throws(
    () => buildSessionKeyTransaction({
      chainId: 1,
      nonce: 0,
      innerCalls: [MINIMAL_INNER_CALL],
      gasLimit: 93_999,
      sessionAuth: {
        session_pubkey: [1],
        session_algo: 1,
        target: null,
        value_cap: '0x0',
        expiry_block: 1,
        root_signature: [1],
        session_signature: [1],
      },
    }),
    /gasLimit must cover AA intrinsic gas \(94000\)/,
  );
});

test('buildBatchTransaction: sets tx_type to AA_BUNDLE_TX_TYPE', () => {
  const { tx } = buildBatchTransaction({ chainId: 1, nonce: 0, innerCalls: [MINIMAL_INNER_CALL] });
  assert.equal(tx.tx_type, AA_BUNDLE_TX_TYPE, 'tx_type must be 0x7E');
});

test('AA constants: paymaster context cap matches shell-chain', () => {
  assert.equal(AA_MAX_PAYMASTER_CONTEXT, 4096);
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
    paymaster: '0x0000000000000000000000000000000000000000000000000000000000000099',
    paymasterSignature: pmSig,
  });
  assert.ok(aa_bundle.paymaster, 'paymaster must be set');
  assert.equal(aa_bundle.paymaster_signature?.length, 3309, 'paymaster_signature must match pmSig length');
});

test('paymaster builders reject inputs that nodes cannot decode', () => {
  const common = { chainId: 1, nonce: 0, innerCalls: [MINIMAL_INNER_CALL] };

  assert.throws(
    () => buildSponsoredTransaction({
      ...common,
      paymaster: '0x1234',
      paymasterSignature: new Uint8Array([1]),
    }),
    /paymaster must be .*valid Shell address/,
  );
  assert.throws(
    () => buildSponsoredTransaction({
      ...common,
      paymaster: '0x' + '99'.repeat(32),
      paymasterSignature: [],
    }),
    /paymasterSignature must not be empty/,
  );
  assert.throws(
    () => buildContractPaymasterTransaction({
      ...common,
      paymaster: '0x' + '99'.repeat(32),
      paymasterContext: new Uint8Array(AA_MAX_PAYMASTER_CONTEXT + 1),
    }),
    /paymasterContext exceeds maximum size/,
  );
  assert.throws(
    () => buildContractPaymasterTransaction({
      ...common,
      paymaster: '0x' + '99'.repeat(32),
      paymasterContext: [256],
    }),
    /paymasterContext must contain only byte values/,
  );
});

test('buildSessionKeyTransaction rejects incomplete session authorization', () => {
  assert.throws(
    () => buildSessionKeyTransaction({
      chainId: 1,
      nonce: 0,
      innerCalls: [MINIMAL_INNER_CALL],
      sessionAuth: {
        session_pubkey: [1],
        session_algo: 1,
        target: null,
        value_cap: '0x0',
        expiry_block: 1,
        root_signature: [1],
        session_signature: [],
      },
    }),
    /session_signature is empty/,
  );
});

// ---------------------------------------------------------------------------
// hashBatchTransaction
// ---------------------------------------------------------------------------
test('hashBatchTransaction: returns 32-byte Uint8Array', () => {
  const { tx, aa_bundle } = buildBatchTransaction({ chainId: 1, nonce: 0, innerCalls: [MINIMAL_INNER_CALL] });
  const hash = hashBatchTransaction(tx, aa_bundle);
  assert.ok(hash instanceof Uint8Array, 'result must be Uint8Array');
  assert.equal(hash.length, 32, 'hash must be 32 bytes (BLAKE3-256)');
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
    paymaster: '0x0000000000000000000000000000000000000000000000000000000000000099',
  };
  const h1 = hexBytes(hashBatchTransaction(tx, bundleNoPaymaster));
  const h2 = hexBytes(hashBatchTransaction(tx, bundleWithPaymaster));
  assert.notEqual(h1, h2, 'paymaster must change the hash');
});

test('hashBatchTransaction: known Shell-chain vector (chain_id=1, nonce=0, single null-to call)', () => {
  const { tx, aa_bundle } = buildBatchTransaction({
    chainId: 1,
    nonce: 0,
    innerCalls: [{ to: null, value: '0x0', data: '0x1234', gas_limit: '0x5208' }],
  });
  const hash = hexBytes(hashBatchTransaction(tx, aa_bundle));
  assert.equal(hash, '0xd2c415a571c60e84907b09cbda157298edb2387331e3d2db40caab7a277a9a59');
});

test('hashBatchTransaction: session authorization metadata matches Shell-chain vector', () => {
  const { tx, aa_bundle } = buildSessionKeyTransaction({
    chainId: 1,
    nonce: 0,
    innerCalls: [{
      to: `0x${'42'.repeat(32)}`,
      value: '0x0',
      data: '0x',
      gas_limit: '0x5208',
    }],
    sessionAuth: {
      session_pubkey: Array(32).fill(0xA5),
      session_algo: 0,
      target: `0x${'11'.repeat(32)}`,
      value_cap: '0x3e8',
      expiry_block: 42,
      root_signature: Array(96).fill(0x01),
      session_signature: Array(96).fill(0x02),
    },
  });

  assert.equal(
    hexBytes(hashBatchTransaction(tx, aa_bundle)),
    '0x4083d5079c9381bae7e2846173559bf6a35f430297c8f46b0f798cabb96ada3d',
  );

  const changed = structuredClone(aa_bundle);
  changed.session_auth.expiry_block += 1;
  assert.notEqual(
    hexBytes(hashBatchTransaction(tx, aa_bundle)),
    hexBytes(hashBatchTransaction(tx, changed)),
  );
});

test('hashPaymasterTransaction: known Shell-chain vector', () => {
  const { tx, aa_bundle } = buildSponsoredTransaction({
    chainId: 1,
    nonce: 0,
    innerCalls: [MINIMAL_INNER_CALL],
    paymaster: '0x0000000000000000000000000000000000000000000000000000000000000099',
    paymasterSignature: new Uint8Array([1]),
  });
  const hash = hexBytes(hashPaymasterTransaction(
    '0x0000000000000000000000000000000000000000000000000000000000000042',
    tx,
    aa_bundle,
  ));
  assert.equal(hash, '0xd5016bf694426c4ef74e7b06f27062db79acb9050923793278ea7ffd6ab9ee75');
});

// ---------------------------------------------------------------------------
// buildInnerTransfer / buildInnerCall — hex encoding and validation
// ---------------------------------------------------------------------------
test('buildInnerTransfer: encodes gas_limit as hex quantity', () => {
  const call = buildInnerTransfer('0x0000000000000000000000000000000000000000000000000000000000000042', 0n, 21_000);
  assert.equal(call.gas_limit, '0x5208', 'gas_limit must be hex-encoded');
  assert.match(call.gas_limit, /^0x[0-9a-f]+$/, 'gas_limit must be a valid hex quantity');
});

test('buildInnerCall: encodes gas_limit as hex quantity', () => {
  const call = buildInnerCall('0x0000000000000000000000000000000000000000000000000000000000000042', '0x', 50_000);
  assert.equal(call.gas_limit, '0xc350', 'gas_limit must be hex-encoded');
});

test('buildInnerTransfer: rejects negative gasLimit', () => {
  assert.throws(() => buildInnerTransfer('0x0000000000000000000000000000000000000000000000000000000000000042', 0n, -1), /non-negative safe integer/);
});

test('buildInnerTransfer: rejects invalid recipient and value', () => {
  assert.throws(() => buildInnerTransfer('0x1234', 0n, 21_000), /valid Shell address/);
  assert.throws(() => buildInnerTransfer('0x0000000000000000000000000000000000000000000000000000000000000042', -1n, 21_000), /non-negative bigint/);
  assert.throws(
    () => buildInnerTransfer('0x0000000000000000000000000000000000000000000000000000000000000042', 1n << 256n, 21_000),
    /fit in u256/,
  );
});

test('buildInnerCall: rejects non-integer gasLimit', () => {
  assert.throws(() => buildInnerCall('0x0000000000000000000000000000000000000000000000000000000000000042', '0x', 21_000.5), /non-negative safe integer/);
});

test('buildInnerCall: rejects invalid calldata and value', () => {
  assert.throws(() => buildInnerCall('0x0000000000000000000000000000000000000000000000000000000000000042', '0xabc', 21_000), /byte-aligned hex data/);
  assert.throws(() => buildInnerCall('0x0000000000000000000000000000000000000000000000000000000000000042', 'not-hex', 21_000), /byte-aligned hex data/);
  assert.throws(() => buildInnerCall('0x0000000000000000000000000000000000000000000000000000000000000042', '0x', 21_000, -1n), /non-negative bigint/);
});

// ---------------------------------------------------------------------------
// aaBundle / aaBbundle option naming and precedence
// ---------------------------------------------------------------------------
const DUMMY_BUNDLE = { inner_calls: [MINIMAL_INNER_CALL], paymaster: null, paymaster_data: null };
const DUMMY_SIG = new Uint8Array(64);
const DUMMY_TX = { tx_type: '0x0', chain_id: 1, nonce: 0, gas_price: '0x0', gas_limit: '0x0', to: null, value: '0x0', data: '0x', access_list: [] };

test('buildSignedTransaction: aaBundle canonical option sets aa_bundle', () => {
  const signed = buildSignedTransaction({
    from: '0x0000000000000000000000000000000000000000000000000000000000000042',
    tx: DUMMY_TX,
    signatureType: 'falcon512',
    signature: DUMMY_SIG,
    aaBundle: DUMMY_BUNDLE,
  });
  assert.deepEqual(signed.aa_bundle, DUMMY_BUNDLE, 'aaBundle should populate aa_bundle');
});

test('buildSignedTransaction: aaBbundle deprecated alias still works', () => {
  const signed = buildSignedTransaction({
    from: '0x0000000000000000000000000000000000000000000000000000000000000042',
    tx: DUMMY_TX,
    signatureType: 'falcon512',
    signature: DUMMY_SIG,
    aaBbundle: DUMMY_BUNDLE,
  });
  assert.deepEqual(signed.aa_bundle, DUMMY_BUNDLE, 'aaBbundle alias should populate aa_bundle');
});

test('buildSignedTransaction: aaBundle takes precedence over aaBbundle', () => {
  const OTHER_BUNDLE = { inner_calls: [], paymaster: null, paymaster_data: null };
  const signed = buildSignedTransaction({
    from: '0x0000000000000000000000000000000000000000000000000000000000000042',
    tx: DUMMY_TX,
    signatureType: 'falcon512',
    signature: DUMMY_SIG,
    aaBundle: DUMMY_BUNDLE,
    aaBbundle: OTHER_BUNDLE,
  });
  assert.deepEqual(signed.aa_bundle, DUMMY_BUNDLE, 'aaBundle must take precedence over aaBbundle');
});
