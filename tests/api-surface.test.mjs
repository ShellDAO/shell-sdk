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
