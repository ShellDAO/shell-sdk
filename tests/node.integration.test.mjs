import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MlDsa65Adapter,
  ShellSigner,
  assertSignerMatchesKeystore,
  buildTransferTransaction,
  decryptKeystore,
  exportEncryptedKeyJson,
  generateMlDsa65KeyPair,
  hashTransaction,
  parseEncryptedKey,
} from '../dist/index.js';
import { createKeystoreFixture } from './helpers.mjs';

test('node integration: parse/decrypt keystore and sign transaction', async () => {
  const { publicKey, secretKey } = generateMlDsa65KeyPair();
  const signer = new ShellSigner('MlDsa65', MlDsa65Adapter.fromKeyPair(publicKey, secretKey));
  const keystore = await createKeystoreFixture({
    secretKey,
    publicKey,
    address: signer.getAddress(),
    keyType: 'mldsa65',
    password: 'correct horse battery',
  });

  const parsed = parseEncryptedKey(keystore);
  assert.equal(parsed.canonicalAddress, signer.getAddress());

  const decryptedSigner = await decryptKeystore(keystore, 'correct horse battery');
  assert.equal(decryptedSigner.getAddress(), signer.getAddress());
  assertSignerMatchesKeystore(decryptedSigner, parsed);

  const tx = buildTransferTransaction({
    chainId: 424242,
    nonce: 0,
    to: signer.getAddress(),
    value: 1_500_000_000_000_000_000n,
  });
  const signed = await decryptedSigner.buildSignedTransaction({
    tx,
    txHash: hashTransaction(tx),
    includePublicKey: true,
  });

  assert.equal(signed.from, signer.getAddress());
  assert.equal(signed.signature.sig_type, 'ML-DSA-65');
  assert.equal(signed.sender_pubkey.length, publicKey.length);
  assert.ok(Array.isArray(signed.signature.data));
  assert.ok(signed.signature.data.length > 0);

  const json = exportEncryptedKeyJson(keystore);
  assert.match(json, /"cipher": "xchacha20-poly1305"/);
});

test('node integration: tampered keystore address is rejected', async () => {
  const { publicKey, secretKey } = generateMlDsa65KeyPair();
  const signer = new ShellSigner('MlDsa65', MlDsa65Adapter.fromKeyPair(publicKey, secretKey));
  const keystore = await createKeystoreFixture({
    secretKey,
    publicKey,
    address: signer.getAddress(),
    keyType: 'mldsa65',
    password: 'correct horse battery',
  });

  const tampered = {
    ...keystore,
    address: signer.getAddress().slice(0, -2) + (signer.getAddress().endsWith('0') ? '1' : '0'),
  };
  await assert.rejects(
    () => decryptKeystore(tampered, 'correct horse battery'),
    /address mismatch|bech32m/i,
  );
});
