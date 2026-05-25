import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MlDsa65Adapter,
  ShellSigner,
  assertSignerMatchesKeystore,
  buildBatchTransaction,
  buildTransferTransaction,
  decryptKeystore,
  exportEncryptedKeyJson,
  generateMlDsa65KeyPair,
  parseEncryptedKey,
  withDecryptedKeystoreSigner,
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

test('node integration: withDecryptedKeystoreSigner disposes the signer after use', async () => {
  const { publicKey, secretKey } = generateMlDsa65KeyPair();
  const signer = new ShellSigner('MlDsa65', MlDsa65Adapter.fromKeyPair(publicKey, secretKey));
  const keystore = await createKeystoreFixture({
    secretKey,
    publicKey,
    address: signer.getAddress(),
    keyType: 'mldsa65',
    password: 'correct horse battery',
  });

  let callbackSigner;
  await withDecryptedKeystoreSigner(keystore, 'correct horse battery', async (decryptedSigner) => {
    callbackSigner = decryptedSigner;
    const tx = buildTransferTransaction({
      chainId: 424242,
      nonce: 1,
      to: signer.getAddress(),
      value: 1n,
    });
    const signed = await decryptedSigner.buildSignedTransaction({ tx, includePublicKey: true });
    assert.equal(signed.signature.sig_type, 'ML-DSA-65');
  });

  await assert.rejects(() => callbackSigner.sign(new Uint8Array([1])), /disposed/i);
});

test('node integration: AA tx requires aaBundle when auto-computing txHash', async () => {
  const { publicKey, secretKey } = generateMlDsa65KeyPair();
  const signer = new ShellSigner('MlDsa65', MlDsa65Adapter.fromKeyPair(publicKey, secretKey));
  const { tx } = buildBatchTransaction({
    chainId: 424242,
    nonce: 0,
    innerCalls: [{ to: signer.getAddress(), value: '0x0', data: '0x', gas_limit: '0x5208' }],
  });

  await assert.rejects(
    () => signer.buildSignedTransaction({ tx, includePublicKey: true }),
    /aaBundle is required/i,
  );
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

  const addr = signer.getAddress();
  const lastChar = addr[addr.length - 1];
  const tampered = {
    ...keystore,
    address: addr.slice(0, -1) + (lastChar === '0' ? '1' : '0'),
  };
  await assert.rejects(
    () => decryptKeystore(tampered, 'correct horse battery'),
    /address mismatch/i,
  );
});
