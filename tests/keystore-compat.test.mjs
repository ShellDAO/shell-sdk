/**
 * Keystore cross-format compatibility tests (ks-3).
 *
 * Verifies that `shell-sdk` `decryptKeystore` can decrypt keystores produced
 * by `shell-node key generate` (the Rust CLI), confirming that the sk-only
 * v1 format is interoperable between SDK and node.
 *
 * Fixtures:
 *   tests/fixtures/cli-keystore-mldsa65.json    — ML-DSA-65 keystore from CLI
 *   tests/fixtures/cli-keystore-dilithium3.json — Dilithium3 keystore from CLI
 *
 * Password used to generate all CLI fixtures: "fixture-password-42"
 * Generated with: echo "fixture-password-42" | shell-node --password-stdin key generate ...
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';

import { decryptKeystore, parseEncryptedKey } from '../dist/keystore.js';

import cliMlDsa65 from './fixtures/cli-keystore-mldsa65.json' with { type: 'json' };
import cliDilithium3 from './fixtures/cli-keystore-dilithium3.json' with { type: 'json' };

const CLI_PASSWORD = 'fixture-password-42';

// ── ML-DSA-65 CLI keystore ────────────────────────────────────────────────────

test('ks-3: parseEncryptedKey reads CLI ML-DSA-65 keystore metadata', () => {
  const parsed = parseEncryptedKey(cliMlDsa65);

  assert.equal(cliMlDsa65.version, 1, 'keystore version must be 1');
  assert.equal(cliMlDsa65.key_type, 'mldsa65', 'key_type must be mldsa65');
  assert.equal(cliMlDsa65.kdf, 'argon2id', 'kdf must be argon2id');
  assert.equal(cliMlDsa65.cipher, 'xchacha20-poly1305', 'cipher must be xchacha20-poly1305');

  // Address stored by CLI must be pq1… bech32m format (F-PQ1-ONLY)
  assert.ok(
    cliMlDsa65.address.startsWith('pq1'),
    'CLI keystore address must be pq1 bech32m format',
  );

  assert.equal(parsed.signatureType, 'ML-DSA-65');
  assert.equal(parsed.algorithmId, 1, 'ML-DSA-65 algo_id must be 1');
  assert.equal(parsed.publicKey.length, 1952, 'ML-DSA-65 public key must be 1952 bytes');
  assert.ok(parsed.canonicalAddress.startsWith('pq1'), 'canonical address must be pq1 bech32');
});

test('ks-3: decryptKeystore decrypts CLI ML-DSA-65 keystore', async () => {
  const signer = await decryptKeystore(cliMlDsa65, CLI_PASSWORD);

  assert.ok(signer.getAddress().startsWith('pq1'), 'decrypted address must be pq1 bech32');
  assert.equal(signer.algorithmId, 1, 'algorithm id must be 1 (ML-DSA-65)');
  const parsed = parseEncryptedKey(cliMlDsa65);
  assert.equal(signer.getAddress(), parsed.canonicalAddress, 'address must match keystore metadata');
});

test('ks-3: decrypted CLI ML-DSA-65 key can sign and Noble verifies', async () => {
  const signer = await decryptKeystore(cliMlDsa65, CLI_PASSWORD);

  const message = new TextEncoder().encode('cross-format test');
  const sig = await signer.sign(message);

  assert.equal(sig.length, 3309, 'ML-DSA-65 signature must be 3309 bytes');

  const parsed = parseEncryptedKey(cliMlDsa65);
  const ok = ml_dsa65.verify(sig, message, parsed.publicKey);
  assert.equal(ok, true, 'Noble must verify signature from decrypted CLI keystore key');
});

test('ks-3: wrong password for CLI ML-DSA-65 keystore throws', async () => {
  await assert.rejects(
    () => decryptKeystore(cliMlDsa65, 'wrong-password'),
    /decrypt|cipher|invalid|tag/i,
  );
});

// ── Dilithium3 CLI keystore ───────────────────────────────────────────────────

test('ks-3: parseEncryptedKey reads CLI Dilithium3 keystore metadata', () => {
  const parsed = parseEncryptedKey(cliDilithium3);

  assert.equal(cliDilithium3.key_type, 'dilithium3', 'key_type must be dilithium3');
  assert.ok(
    cliDilithium3.address.startsWith('pq1'),
    'CLI Dilithium3 keystore address must be pq1 bech32m format',
  );

  assert.equal(parsed.signatureType, 'Dilithium3');
  assert.equal(parsed.algorithmId, 0, 'Dilithium3 algo_id must be 0');
  assert.equal(parsed.publicKey.length, 1952, 'Dilithium3 public key must be 1952 bytes');
});

test('ks-3: decryptKeystore decrypts CLI Dilithium3 keystore', async () => {
  const signer = await decryptKeystore(cliDilithium3, CLI_PASSWORD);

  assert.ok(signer.getAddress().startsWith('pq1'), 'Dilithium3 address must be pq1 bech32');
  assert.equal(signer.algorithmId, 0, 'algorithm id must be 0 (Dilithium3)');

  const parsed = parseEncryptedKey(cliDilithium3);
  assert.equal(signer.getAddress(), parsed.canonicalAddress, 'address must match keystore metadata');
});

test('ks-3: decryptKeystore rejects wrong algo password for Dilithium3', async () => {
  await assert.rejects(
    () => decryptKeystore(cliDilithium3, 'wrong-password'),
    /decrypt|cipher|invalid|tag/i,
  );
});

// ── Schema invariants ─────────────────────────────────────────────────────────

test('ks-3: CLI keystore uses sk-only ciphertext (v1 format)', () => {
  // ML-DSA-65: sk=4032 + 16-byte AEAD tag = 4048 bytes
  const ct = Buffer.from(cliMlDsa65.ciphertext, 'hex');
  assert.equal(ct.length, 4032 + 16, 'ML-DSA-65 ciphertext must be sk(4032) + tag(16) bytes');

  // Dilithium3: sk bytes + 16-byte AEAD tag
  const ct2 = Buffer.from(cliDilithium3.ciphertext, 'hex');
  assert.ok(ct2.length > 16, 'Dilithium3 ciphertext must be non-empty');
  // The public key must NOT be embedded in ciphertext (sk-only invariant).
  // If pk were included: ct.length == sk+pk+16 (too large). Test that it's ≤ sk+tag.
  assert.ok(ct.length <= 4032 + 16, 'ML-DSA-65 ciphertext must not contain pk (sk-only)');
});
