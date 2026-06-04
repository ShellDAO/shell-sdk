/**
 * Tests for Shell PQ-HD v1 (hdwallet.ts).
 *
 * Includes cross-implementation vector tests that verify byte-exact parity
 * with the Rust implementation (shell-chain/crates/crypto/src/hd.rs).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  generateMnemonic,
  validateHdMnemonic,
  mnemonicToSeed,
  masterNodeFromSeed,
  deriveChildNode,
  deriveAtPath,
  deriveMlDsa65Account,
  deriveSlhDsaAccount,
  deriveAccount,
  accountToRecord,
  formatPath,
  parsePath,
  HARDENED_OFFSET,
  HD_PURPOSE,
  HD_COIN_TYPE,
  ALGO_MLDSA65,
  ALGO_SLH_DSA,
  MLDSA65_PK_LENGTH,
  SLHDSA_PK_LENGTH,
} from "../dist/hdwallet.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── Load canonical test vectors ───────────────────────────────────────────────

const vectorsPath = join(__dirname, "../test-vectors/pq-hd-v1.json");
const vectors = JSON.parse(readFileSync(vectorsPath, "utf-8"));

// ── Mnemonic helpers ──────────────────────────────────────────────────────────

test("generateMnemonic: returns 24-word mnemonic by default", () => {
  const m = generateMnemonic();
  assert.equal(m.split(" ").length, 24);
});

test("generateMnemonic: returns 12-word mnemonic with strength=128", () => {
  const m = generateMnemonic(128);
  assert.equal(m.split(" ").length, 12);
});

test("validateHdMnemonic: accepts valid BIP-39 mnemonic", () => {
  const m = generateMnemonic();
  assert.equal(validateHdMnemonic(m), true);
});

test("validateHdMnemonic: rejects invalid mnemonic", () => {
  assert.equal(validateHdMnemonic("not a valid mnemonic at all"), false);
});

test("validateHdMnemonic: accepts vector mnemonic", () => {
  assert.equal(validateHdMnemonic(vectors.mnemonic), true);
});

// ── Seed derivation ───────────────────────────────────────────────────────────

test("mnemonicToSeed: matches canonical vector seed_512", () => {
  const seed = mnemonicToSeed(vectors.mnemonic, vectors.passphrase);
  assert.equal(seed.length, 64);
  assert.equal(bytesToHex(seed), vectors.seed_512);
});

test("mnemonicToSeed: different passphrases produce different seeds", () => {
  const m = generateMnemonic();
  const s1 = mnemonicToSeed(m, "");
  const s2 = mnemonicToSeed(m, "passphrase");
  assert.notEqual(bytesToHex(s1), bytesToHex(s2));
});

// ── Master node ───────────────────────────────────────────────────────────────

test("masterNodeFromSeed: matches canonical vector master node", () => {
  const seed = hexToBytes(vectors.seed_512);
  const master = masterNodeFromSeed(seed);
  assert.equal(bytesToHex(master.secret), vectors.master.secret);
  assert.equal(bytesToHex(master.chainCode), vectors.master.chain_code);
});

test("masterNodeFromSeed: rejects wrong-length seed", () => {
  assert.throws(() => masterNodeFromSeed(new Uint8Array(32)), /64-byte/);
});

// ── Child derivation ──────────────────────────────────────────────────────────

test("deriveChildNode: hardened index encoding (0x80000000 | n)", () => {
  const seed = hexToBytes(vectors.seed_512);
  const master = masterNodeFromSeed(seed);

  // Check first level derivation against vector (purpose 9000)
  const mlv = vectors.ml_dsa_65;
  const firstLevelExpected = mlv.intermediate_nodes[0];
  const child0 = deriveChildNode(master, firstLevelExpected.raw_index);

  assert.equal(bytesToHex(child0.secret), firstLevelExpected.secret,
    "first child secret should match vector");
  assert.equal(bytesToHex(child0.chainCode), firstLevelExpected.chain_code,
    "first child chain_code should match vector");
});

test("deriveChildNode: rejects out-of-range index", () => {
  const seed = hexToBytes(vectors.seed_512);
  const master = masterNodeFromSeed(seed);
  assert.throws(() => deriveChildNode(master, HARDENED_OFFSET), /\[0, 2\^31\)/);
  assert.throws(() => deriveChildNode(master, -1), /\[0, 2\^31\)/);
});

// ── Full path derivation against vectors ──────────────────────────────────────

test("deriveAtPath (ML-DSA-65): all intermediate nodes match canonical vectors", () => {
  const seed = hexToBytes(vectors.seed_512);
  const master = masterNodeFromSeed(seed);
  const mlv = vectors.ml_dsa_65;

  let node = master;
  for (let i = 0; i < mlv.intermediate_nodes.length; i++) {
    const expected = mlv.intermediate_nodes[i];
    node = deriveChildNode(node, expected.raw_index);
    assert.equal(bytesToHex(node.secret), expected.secret,
      `ML-DSA intermediate node[${i}] secret mismatch`);
    assert.equal(bytesToHex(node.chainCode), expected.chain_code,
      `ML-DSA intermediate node[${i}] chain_code mismatch`);
  }
});

test("deriveAtPath (SLH-DSA): all intermediate nodes match canonical vectors", () => {
  const seed = hexToBytes(vectors.seed_512);
  const master = masterNodeFromSeed(seed);
  const slhv = vectors.slh_dsa_sha2_256f;

  let node = master;
  for (let i = 0; i < slhv.intermediate_nodes.length; i++) {
    const expected = slhv.intermediate_nodes[i];
    node = deriveChildNode(node, expected.raw_index);
    assert.equal(bytesToHex(node.secret), expected.secret,
      `SLH-DSA intermediate node[${i}] secret mismatch`);
    assert.equal(bytesToHex(node.chainCode), expected.chain_code,
      `SLH-DSA intermediate node[${i}] chain_code mismatch`);
  }
});

// ── Leaf key derivation against vectors ───────────────────────────────────────

test("deriveMlDsa65Account: public key length is 1952 (FIPS 204 NORMATIVE)", () => {
  const seed = hexToBytes(vectors.seed_512);
  const master = masterNodeFromSeed(seed);
  const mlv = vectors.ml_dsa_65;
  const leafNode = deriveAtPath(master, mlv.path_components_raw);
  const account = deriveMlDsa65Account(leafNode, mlv.path);
  assert.equal(account.publicKey.length, MLDSA65_PK_LENGTH);
});

test("deriveMlDsa65Account: public key matches canonical vector", () => {
  const seed = hexToBytes(vectors.seed_512);
  const master = masterNodeFromSeed(seed);
  const mlv = vectors.ml_dsa_65;
  const leafNode = deriveAtPath(master, mlv.path_components_raw);
  const account = deriveMlDsa65Account(leafNode, mlv.path);
  assert.equal(bytesToHex(account.publicKey), mlv.public_key_hex);
});

test("deriveMlDsa65Account: address matches canonical vector", () => {
  const seed = hexToBytes(vectors.seed_512);
  const master = masterNodeFromSeed(seed);
  const mlv = vectors.ml_dsa_65;
  const leafNode = deriveAtPath(master, mlv.path_components_raw);
  const account = deriveMlDsa65Account(leafNode, mlv.path);
  assert.equal(account.address, mlv.address);
  assert.equal(account.algoId, 1);
});

test("deriveSlhDsaAccount: public key length is 64 (FIPS 205 NORMATIVE)", () => {
  const seed = hexToBytes(vectors.seed_512);
  const master = masterNodeFromSeed(seed);
  const slhv = vectors.slh_dsa_sha2_256f;
  const leafNode = deriveAtPath(master, slhv.path_components_raw);
  const account = deriveSlhDsaAccount(leafNode, slhv.path);
  assert.equal(account.publicKey.length, SLHDSA_PK_LENGTH);
});

test("deriveSlhDsaAccount: public key matches canonical vector", () => {
  const seed = hexToBytes(vectors.seed_512);
  const master = masterNodeFromSeed(seed);
  const slhv = vectors.slh_dsa_sha2_256f;
  const leafNode = deriveAtPath(master, slhv.path_components_raw);
  const account = deriveSlhDsaAccount(leafNode, slhv.path);
  assert.equal(bytesToHex(account.publicKey), slhv.public_key_hex);
});

test("deriveSlhDsaAccount: address matches canonical vector", () => {
  const seed = hexToBytes(vectors.seed_512);
  const master = masterNodeFromSeed(seed);
  const slhv = vectors.slh_dsa_sha2_256f;
  const leafNode = deriveAtPath(master, slhv.path_components_raw);
  const account = deriveSlhDsaAccount(leafNode, slhv.path);
  assert.equal(account.address, slhv.address);
  assert.equal(account.algoId, 2);
});

// ── High-level deriveAccount API ─────────────────────────────────────────────

test("deriveAccount: ml-dsa-65 path and address match vector", () => {
  const seed = hexToBytes(vectors.seed_512);
  const account = deriveAccount(seed, "ml-dsa-65", 0, 0, 0);
  assert.equal(account.path, vectors.ml_dsa_65.path);
  assert.equal(account.address, vectors.ml_dsa_65.address);
  assert.equal(account.algoId, 1);
});

test("deriveAccount: slh-dsa-sha2-256f path and address match vector", () => {
  const seed = hexToBytes(vectors.seed_512);
  const account = deriveAccount(seed, "slh-dsa-sha2-256f", 0, 0, 0);
  assert.equal(account.path, vectors.slh_dsa_sha2_256f.path);
  assert.equal(account.address, vectors.slh_dsa_sha2_256f.address);
  assert.equal(account.algoId, 2);
});

test("deriveAccount: different account indices produce different keys", () => {
  const seed = mnemonicToSeed(generateMnemonic());
  const a0 = deriveAccount(seed, "ml-dsa-65", 0, 0, 0);
  const a1 = deriveAccount(seed, "ml-dsa-65", 1, 0, 0);
  assert.notEqual(a0.address, a1.address);
  assert.equal(a1.path, "m/9000'/8888'/1'/1'/0'/0'");
});

test("accountToRecord: strips secretKey, preserves publicKey hex and address", () => {
  const seed = hexToBytes(vectors.seed_512);
  const account = deriveAccount(seed, "ml-dsa-65", 0, 0, 0);
  const record = accountToRecord(account);
  assert.equal(typeof record.publicKey, "string");
  assert.equal(record.publicKey.length, MLDSA65_PK_LENGTH * 2);
  assert.equal(record.address, account.address);
  assert.equal("secretKey" in record, false);
});

// ── Path utilities ────────────────────────────────────────────────────────────

test("formatPath: formats components as hardened path string", () => {
  assert.equal(formatPath([9000, 8888, 1, 0, 0, 0]), "m/9000'/8888'/1'/0'/0'/0'");
});

test("parsePath: parses hardened path to raw components", () => {
  const components = parsePath("m/9000'/8888'/1'/0'/0'/0'");
  assert.deepEqual(components, [9000, 8888, 1, 0, 0, 0]);
});

test("parsePath: rejects non-hardened component", () => {
  assert.throws(() => parsePath("m/9000'/8888'/1'/0/0'/0'"), /hardened/);
});

test("parsePath: rejects path without m/ prefix", () => {
  assert.throws(() => parsePath("9000'/8888'/1'/0'/0'/0'"), /must start with/);
});

test("formatPath/parsePath: roundtrip", () => {
  const original = [9000, 8888, 2, 3, 0, 7];
  assert.deepEqual(parsePath(formatPath(original)), original);
});

// ── Constants ─────────────────────────────────────────────────────────────────

test("constants: HARDENED_OFFSET is 0x80000000", () => {
  assert.equal(HARDENED_OFFSET, 0x80000000);
});

test("constants: HD_PURPOSE is 9000", () => {
  assert.equal(HD_PURPOSE, 9000);
});

test("constants: HD_COIN_TYPE is 8888", () => {
  assert.equal(HD_COIN_TYPE, 8888);
});

test("constants: ALGO_MLDSA65 is 1", () => {
  assert.equal(ALGO_MLDSA65, 1);
});

test("constants: ALGO_SLH_DSA is 2", () => {
  assert.equal(ALGO_SLH_DSA, 2);
});
