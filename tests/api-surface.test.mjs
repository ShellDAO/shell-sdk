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
    from: '0x1111111111111111111111111111111111111111111111111111111111111111',
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
    from: '0x2222222222222222222222222222222222222222222222222222222222222222',
    to: '0x3333333333333333333333333333333333333333333333333333333333333333',
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


// ---------------------------------------------------------------------------
// validateRpcUrl — SSRF guard (IPv4 + IPv6)
// ---------------------------------------------------------------------------

test('validateRpcUrl accepts valid https URLs', () => {
  assert.doesNotThrow(() => root.validateRpcUrl('https://mainnet.shell.org'));
  assert.doesNotThrow(() => root.validateRpcUrl('https://rpc.example.com:8545'));
  assert.doesNotThrow(() => root.validateRpcUrl('wss://rpc.example.com:8547'));
});

test('validateRpcUrl accepts http/ws for localhost', () => {
  assert.doesNotThrow(() => root.validateRpcUrl('http://localhost:8545'));
  assert.doesNotThrow(() => root.validateRpcUrl('http://127.0.0.1:8545'));
  assert.doesNotThrow(() => root.validateRpcUrl('ws://localhost:8547'));
  assert.doesNotThrow(() => root.validateRpcUrl('http://[::1]:8545'));
});

test('validateRpcUrl blocks IPv4 private ranges', () => {
  assert.throws(() => root.validateRpcUrl('https://10.0.0.1:8545'),    /private IP/);
  assert.throws(() => root.validateRpcUrl('https://172.16.0.1:8545'),  /private IP/);
  assert.throws(() => root.validateRpcUrl('https://192.168.1.1:8545'), /private IP/);
  assert.throws(() => root.validateRpcUrl('https://169.254.169.254'),  /private IP/);
});

test('validateRpcUrl blocks IPv6 link-local and unique-local addresses', () => {
  // Link-local fe80::/10
  assert.throws(() => root.validateRpcUrl('https://[fe80::1]:8545'),   /private IP/);
  assert.throws(() => root.validateRpcUrl('https://[fe80::dead:beef]:8545'), /private IP/);
  // Unique-local fc00::/7
  assert.throws(() => root.validateRpcUrl('https://[fc00::1]:8545'),   /private IP/);
  assert.throws(() => root.validateRpcUrl('https://[fd00::1]:8545'),   /private IP/);
  // IPv4-mapped link-local
  assert.throws(() => root.validateRpcUrl('https://[::ffff:169.254.169.254]'), /private IP/);
});
