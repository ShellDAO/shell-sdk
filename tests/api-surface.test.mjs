import assert from 'node:assert/strict';
import test from 'node:test';

import * as root from '../dist/index.js';
import * as signer from '../dist/signer.js';
import * as transactions from '../dist/transactions.js';

test('stable root exports exclude low-level internals', () => {
  const stableExports = [
    'MlDsa65Adapter',
    'ShellSigner',
    'assertSignerMatchesKeystore',
    'buildTransferTransaction',
    'createShellProvider',
    'decryptKeystore',
    'generateMlDsa65KeyPair',
    'hashTransaction',
    'normalizePqAddress',
    'parseEncryptedKey',
    'signatureTypeFromKeyType',
  ];

  for (const exportName of stableExports) {
    assert.ok(exportName in root, `expected root export ${exportName}`);
  }

  assert.equal('hexBytes' in root, false);
  assert.equal('KEY_TYPE_TO_SIGNATURE_TYPE' in root, false);
  assert.equal('SIGNATURE_TYPE_IDS' in root, false);
});

test('subpath exports retain advanced helpers', () => {
  assert.equal(typeof transactions.hexBytes, 'function');
  assert.equal(typeof signer.KEY_TYPE_TO_SIGNATURE_TYPE, 'object');
  assert.equal(typeof signer.SIGNATURE_TYPE_IDS, 'object');
});

test('formatShellRpcTxType labels starkReward correctly', () => {
  const { formatShellRpcTxType } = root;
  assert.equal(formatShellRpcTxType({ shellType: 'starkReward' }), 'STARK Reward');
  assert.equal(formatShellRpcTxType({ shellType: 'blockGasReward' }), 'Block Reward');
  assert.equal(formatShellRpcTxType({ shellType: 'transfer' }), 'Transfer');
});

test('ShellRpcTransaction accepts decodedInput field (v0.22+ fixture)', () => {
  /** @type {import('../dist/index.js').ShellRpcTransaction} */
  const settlementTx = {
    hash: '0xabcdef01',
    from: 'pq1validator',
    to: null,
    value: '0x0',
    gas: '0x0',
    gasPrice: '0x0',
    nonce: '0x0',
    input: '0x01000000',
    chainId: '0x67932',
    type: '0x80',
    shellType: 'starkReward',
    rewardKind: 'starkReward',
    rewardLayer: '0x1',
    rewardSourceHash: '0xdeadbeef',
    originalSize: '0x1000',
    compressedSize: '0x400',
    decodedInput: {
      layer: 1,
      blockNumber: 58,
      startBlock: 0,
      endBlock: 58,
      nSigs: 120,
      compressedSize: 1024,
      originalSize: 4096,
      settlementTxHash: '0xabcdef01',
    },
  };

  assert.equal(settlementTx.decodedInput?.layer, 1);
  assert.equal(settlementTx.decodedInput?.startBlock, 0);
  assert.equal(settlementTx.decodedInput?.endBlock, 58);
  assert.equal(settlementTx.decodedInput?.compressedSize, 1024);
  assert.equal(settlementTx.decodedInput?.originalSize, 4096);
});

test('ShellRpcTransaction allows null decodedInput for non-settlement txs', () => {
  /** @type {import('../dist/index.js').ShellRpcTransaction} */
  const transferTx = {
    hash: '0x1234',
    from: 'pq1alice',
    to: 'pq1bob',
    value: '0xde0b6b3a7640000',
    gas: '0x5208',
    gasPrice: '0x1',
    nonce: '0x1',
    input: '0x',
    chainId: '0x67932',
    type: '0x2',
    decodedInput: null,
  };
  assert.equal(transferTx.decodedInput, null);
});

