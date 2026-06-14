/**
 * Shell PQ-HD v1: Post-Quantum Hierarchical-Deterministic wallet derivation.
 *
 * Produces byte-identical keys and addresses in both this TypeScript SDK and
 * the Rust node (`shell-chain/crates/crypto/src/hd.rs`).
 *
 * ## Scheme summary
 *
 * - **Mnemonic**: BIP-39, 24 words (256-bit entropy), NFKD-normalised.
 * - **Seed**: `PBKDF2-HMAC-SHA512(mnemonic, "mnemonic"+passphrase, 2048)` → 64 bytes.
 * - **Master**: `BLAKE3_keyed(KEY_MASTER, seed512, dkLen=64)`; I[0:32]=secret, I[32:64]=chain_code.
 * - **Child** (hardened-only): `encoded_index = 0x80000000 | n`;
 *   `data = CTX_CHILD || 0x00 || parent_secret || ser32BE(encoded_index)`;
 *   `I = BLAKE3_keyed(parent_chain_code, data, dkLen=64)`.
 * - **Leaf ML-DSA-65**: `ml_seed32 = BLAKE3_keyed(KEY_MLDSA_LEAF, child_secret, dkLen=32)`.
 * - **Leaf SLH-DSA**: `slh_seed96 = BLAKE3_keyed(KEY_SLH_LEAF, child_secret, dkLen=96)`.
 * - **Address**: `BLAKE3(algo_id || raw_pk)[0:32]` → existing Shell rule.
 *
 * NORMATIVE byte formats (locked by `test-vectors/pq-hd-v1.json`):
 * - ML-DSA-65 pk: raw FIPS 204 bytes, length **1952**, `algo_id = 0x01`.
 * - SLH-DSA-SHA2-256f pk: raw FIPS 205 bytes, length **64**, `algo_id = 0x02`.
 *
 * @see ADR-011 in workspace/projects/shell-chain/adrs/ADR-011-pq-hd-wallet.md
 * @module hdwallet
 */

import { blake3 } from "@noble/hashes/blake3";
import { pbkdf2 } from "@noble/hashes/pbkdf2";
import { sha512 } from "@noble/hashes/sha2";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { slh_dsa_sha2_256f } from "@noble/post-quantum/slh-dsa.js";
import { mnemonicToEntropy, entropyToMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english";
import { deriveShellAddressFromPublicKey } from "./address.js";

// ── Domain-separation constants ──────────────────────────────────────────────

const KEY_MASTER = blake3(new TextEncoder().encode("Shell-Chain PQ-HD master key v1"));
const KEY_CHILD_CTX = new TextEncoder().encode("Shell-Chain PQ-HD child v1");
const KEY_MLDSA_LEAF = blake3(new TextEncoder().encode("Shell-Chain PQ-HD ML-DSA-65 leaf seed v1"));
const KEY_SLH_LEAF = blake3(new TextEncoder().encode("Shell-Chain PQ-HD SLH-DSA-SHA2-256f leaf seed v1"));

/** BIP-32 hardened offset — NORMATIVE: `encoded_index = HARDENED_OFFSET | raw_index`. */
export const HARDENED_OFFSET = 0x80000000;

// ── Path constants ───────────────────────────────────────────────────────────

/** Shell PQ-HD v1 purpose level (raw, applied as hardened). */
export const HD_PURPOSE = 9000;
/** Shell coin type (raw, applied as hardened; placeholder pending SLIP-0044 registration). */
export const HD_COIN_TYPE = 8888;
/** Algorithm path level value for ML-DSA-65 (raw, applied as hardened). */
export const ALGO_MLDSA65 = 1;
/** Algorithm path level value for SLH-DSA-SHA2-256f (raw, applied as hardened). */
export const ALGO_SLH_DSA = 2;

/** AA Phase 2 session-key account level index (raw, applied as hardened). Path: `m/1'/1'/k'`. */
export const HD_SESSION_ACCOUNT = 1;
/** AA Phase 2 session-key subtree level index (raw, applied as hardened). Path: `m/1'/1'/k'`. */
export const HD_SESSION_SUBTREE = 1;
// ── Expected key sizes (NORMATIVE) ───────────────────────────────────────────

/** Expected ML-DSA-65 public key length in bytes (FIPS 204). */
export const MLDSA65_PK_LENGTH = 1952;
/** Expected SLH-DSA-SHA2-256f public key length in bytes (FIPS 205). */
export const SLHDSA_PK_LENGTH = 64;

// ── Types ─────────────────────────────────────────────────────────────────────

/** A node in the HD tree: holds secret and chain code (both 32 bytes). */
export interface HdNode {
  secret: Uint8Array;    // 32 bytes — HD-internal, never store/export as account key
  chainCode: Uint8Array; // 32 bytes — HD-internal
}

/** An account derived at the leaf level. */
export interface HdAccount {
  /** BIP-44-like path string, e.g. `"m/9000'/8888'/1'/0'/0'/0'"`. */
  path: string;
  /** Raw public key bytes (1952 for ML-DSA-65; 64 for SLH-DSA-SHA2-256f). */
  publicKey: Uint8Array;
  /** Raw secret key bytes — keep in memory only, never persist directly. */
  secretKey: Uint8Array;
  /** Shell address (0x + 64 lowercase hex). */
  address: string;
  /** Algorithm identifier: 1 = ML-DSA-65, 2 = SLH-DSA-SHA2-256f. */
  algoId: 1 | 2;
}

/** Storable per-account record (no secrets). */
export interface HdAccountRecord {
  path: string;
  publicKey: string; // hex
  address: string;
  algoId: 1 | 2;
}

// ── Mnemonic helpers ─────────────────────────────────────────────────────────

/**
 * Generate a fresh BIP-39 mnemonic.
 *
 * @param strength - Entropy bits: 128 (12 words) or 256 (24 words, default).
 * @returns Space-separated mnemonic string.
 */
export function generateMnemonic(strength: 128 | 256 = 256): string {
  const entropyBytes = strength / 8;
  const entropy = new Uint8Array(entropyBytes);
  crypto.getRandomValues(entropy);
  return entropyToMnemonic(entropy, english);
}

/**
 * Validate a BIP-39 mnemonic.
 *
 * @param mnemonic - Space-separated mnemonic string.
 * @returns `true` if all words are in the BIP-39 English wordlist and checksum is valid.
 */
export function validateHdMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, english);
}

// ── Seed derivation ───────────────────────────────────────────────────────────

/**
 * Derive the 512-bit seed from a BIP-39 mnemonic (PBKDF2-HMAC-SHA512).
 *
 * Normalization: NFKD, lowercase, single-space-joined — applied before PBKDF2.
 *
 * @param mnemonic - BIP-39 mnemonic (12 or 24 words).
 * @param passphrase - Optional BIP-39 passphrase (default: empty string).
 * @returns 64-byte seed (512 bits).
 */
export function mnemonicToSeed(mnemonic: string, passphrase = ""): Uint8Array {
  const normalized = mnemonic
    .split(/\s+/)
    .map(w => w.normalize("NFKD").toLowerCase())
    .join(" ");
  const mnemonicBytes = new TextEncoder().encode(normalized);
  const saltBytes = new TextEncoder().encode("mnemonic" + passphrase);
  const seed = pbkdf2(sha512, mnemonicBytes, saltBytes, { c: 2048, dkLen: 64 });
  mnemonicBytes.fill(0);
  saltBytes.fill(0);
  return seed;
}

// ── HD tree ───────────────────────────────────────────────────────────────────

/**
 * Derive the master HD node from a 64-byte seed.
 *
 * @param seed512 - 64-byte seed (from {@link mnemonicToSeed}).
 * @returns Master {@link HdNode}.
 */
export function masterNodeFromSeed(seed512: Uint8Array): HdNode {
  if (seed512.length !== 64) {
    throw new Error(`expected 64-byte seed, got ${seed512.length}`);
  }
  const I = blake3(seed512, { key: KEY_MASTER, dkLen: 64 });
  return {
    secret: I.slice(0, 32),
    chainCode: I.slice(32, 64),
  };
}

/**
 * Derive a single hardened child node.
 *
 * @param parent - Parent {@link HdNode}.
 * @param rawIndex - Raw (un-hardened) index: 0 ≤ n < 2³¹.
 * @returns Child {@link HdNode}.
 */
export function deriveChildNode(parent: HdNode, rawIndex: number): HdNode {
  if (rawIndex < 0 || rawIndex >= HARDENED_OFFSET) {
    throw new Error(`raw index must be in [0, 2^31): got ${rawIndex}`);
  }
  const encodedIndex = (HARDENED_OFFSET | rawIndex) >>> 0; // NORMATIVE: 0x80000000 | n

  // data = CTX_CHILD || 0x00 || parent_secret(32) || ser32BE(encodedIndex)
  const data = new Uint8Array(KEY_CHILD_CTX.length + 1 + 32 + 4);
  let offset = 0;
  data.set(KEY_CHILD_CTX, offset); offset += KEY_CHILD_CTX.length;
  data[offset] = 0x00; offset += 1;
  data.set(parent.secret, offset); offset += 32;
  new DataView(data.buffer).setUint32(offset, encodedIndex, false); // big-endian

  const I = blake3(data, { key: parent.chainCode, dkLen: 64 });
  return {
    secret: I.slice(0, 32),
    chainCode: I.slice(32, 64),
  };
}

/**
 * Derive the HD node at the given path components.
 * All components are treated as raw (un-hardened) indices; hardened bit is applied automatically.
 *
 * @param master - Master {@link HdNode}.
 * @param pathComponents - Array of raw path indices, e.g. `[9000, 8888, 1, 0, 0, 0]`.
 * @returns Leaf {@link HdNode}.
 */
export function deriveAtPath(master: HdNode, pathComponents: number[]): HdNode {
  let node = master;
  for (const idx of pathComponents) {
    node = deriveChildNode(node, idx);
  }
  return node;
}

// ── Leaf keypair derivation ───────────────────────────────────────────────────

/**
 * Derive an ML-DSA-65 account at a given leaf node.
 *
 * @param leafNode - Leaf {@link HdNode} (at the full path).
 * @param path - Path string (for labeling; e.g. `"m/9000'/8888'/1'/0'/0'/0'"`).
 * @returns {@link HdAccount} with publicKey (1952 bytes), secretKey, address, algoId=1.
 */
export function deriveMlDsa65Account(leafNode: HdNode, path: string): HdAccount {
  const ml_seed32 = blake3(leafNode.secret, { key: KEY_MLDSA_LEAF, dkLen: 32 });
  const { publicKey, secretKey } = ml_dsa65.keygen(ml_seed32);
  if (publicKey.length !== MLDSA65_PK_LENGTH) {
    throw new Error(`unexpected ML-DSA-65 pk length: ${publicKey.length}`);
  }
  const address = deriveShellAddressFromPublicKey(publicKey, 1);
  return { path, publicKey, secretKey, address, algoId: 1 };
}

/**
 * Derive an SLH-DSA-SHA2-256f account at a given leaf node.
 *
 * The 96-byte seed layout is: `SK.seed(32) || SK.prf(32) || PK.seed(32)`.
 *
 * @param leafNode - Leaf {@link HdNode} (at the full path).
 * @param path - Path string (for labeling).
 * @returns {@link HdAccount} with publicKey (64 bytes), secretKey, address, algoId=2.
 */
export function deriveSlhDsaAccount(leafNode: HdNode, path: string): HdAccount {
  const slh_seed96 = blake3(leafNode.secret, { key: KEY_SLH_LEAF, dkLen: 96 });
  const { publicKey, secretKey } = slh_dsa_sha2_256f.keygen(slh_seed96);
  if (publicKey.length !== SLHDSA_PK_LENGTH) {
    throw new Error(`unexpected SLH-DSA pk length: ${publicKey.length}`);
  }
  const address = deriveShellAddressFromPublicKey(publicKey, 2);
  return { path, publicKey, secretKey, address, algoId: 2 };
}

// ── High-level API ────────────────────────────────────────────────────────────

/** Supported algorithm names for HD derivation. */
export type HdAlgo = "ml-dsa-65" | "slh-dsa-sha2-256f";

/**
 * Derive a Shell HD account from a seed.
 *
 * @param seed512 - 64-byte seed (from {@link mnemonicToSeed}).
 * @param algo - Target algorithm.
 * @param accountIndex - Account index (raw, 0-based).
 * @param changeIndex - Change level: 0 = external, 1 = internal.
 * @param addressIndex - Address index within the account (raw, 0-based).
 * @returns {@link HdAccount}.
 *
 * @example
 * ```typescript
 * const mnemonic = generateMnemonic();
 * const seed = mnemonicToSeed(mnemonic);
 * const account = deriveAccount(seed, "ml-dsa-65", 0, 0, 0);
 * // account.path === "m/9000'/8888'/1'/0'/0'/0'"
 * ```
 */
export function deriveAccount(
  seed512: Uint8Array,
  algo: HdAlgo,
  accountIndex = 0,
  changeIndex = 0,
  addressIndex = 0,
): HdAccount {
  const algoPathValue = algo === "ml-dsa-65" ? ALGO_MLDSA65 : ALGO_SLH_DSA;
  const pathComponents = [HD_PURPOSE, HD_COIN_TYPE, algoPathValue, accountIndex, changeIndex, addressIndex];
  const path = formatPath(pathComponents);

  const master = masterNodeFromSeed(seed512);
  const leaf = deriveAtPath(master, pathComponents);

  if (algo === "ml-dsa-65") {
    return deriveMlDsa65Account(leaf, path);
  } else {
    return deriveSlhDsaAccount(leaf, path);
  }
}

/**
 * Derive an AA Phase 2 session key from a BIP-39 seed.
 *
 * Path: `m/1'/1'/k'` (all hardened), where k = `sessionIndex`.
 *
 * Session keys are time-bounded delegated signing keys used in AA bundles.
 * They are intentionally separated from the primary account key tree
 * (`m/9000'/8888'/...`) to prevent namespace collisions.
 *
 * ## Key Space
 * - `m/1'/1'/0'` — first session key
 * - `m/1'/1'/1'` — second session key
 * - Up to 2^31 session keys per seed
 *
 * ## Guarantees
 * - **Deterministic**: same `(seed512, algo, sessionIndex)` always yields the same key pair
 * - **Isolated**: cannot be confused with primary account keys
 * - **Cross-algorithm safe**: different `algo` values produce different keys at the same index
 *
 * @param seed512 - 64-byte seed (from {@link mnemonicToSeed}).
 * @param algo - Key algorithm: `"ml-dsa-65"` or `"slh-dsa-sha2-256f"`.
 * @param sessionIndex - Session key index (0-based; up to 2^31-1).
 * @returns {@link HdAccount} for the session key.
 *
 * @example
 * ```typescript
 * const seed = mnemonicToSeed(mnemonic);
 * const session0 = deriveSessionKey(seed, "ml-dsa-65", 0);
 * // session0.path === "m/1'/1'/0'"
 * const session1 = deriveSessionKey(seed, "ml-dsa-65", 1);
 * // session0.publicKey !== session1.publicKey
 * ```
 */
export function deriveSessionKey(
  seed512: Uint8Array,
  algo: HdAlgo,
  sessionIndex: number,
): HdAccount {
  if (!Number.isInteger(sessionIndex) || sessionIndex < 0 || sessionIndex >= HARDENED_OFFSET) {
    throw new Error(`sessionIndex must be a non-negative integer < 2^31, got ${sessionIndex}`);
  }
  const pathComponents = [HD_SESSION_ACCOUNT, HD_SESSION_SUBTREE, sessionIndex];
  const path = formatPath(pathComponents);

  const master = masterNodeFromSeed(seed512);
  const leaf = deriveAtPath(master, pathComponents);

  if (algo === "ml-dsa-65") {
    return deriveMlDsa65Account(leaf, path);
  } else {
    return deriveSlhDsaAccount(leaf, path);
  }
}

/**
 * Convert an {@link HdAccount} to a storable record (removes secret key).
 *
 * @param account - Full HD account with secrets.
 * @returns {@link HdAccountRecord} safe to persist.
 */
export function accountToRecord(account: HdAccount): HdAccountRecord {
  return {
    path: account.path,
    publicKey: Buffer.from(account.publicKey).toString("hex"),
    address: account.address,
    algoId: account.algoId,
  };
}

// ── Path formatting ───────────────────────────────────────────────────────────

/**
 * Format a path components array as a BIP-44-like path string.
 * All levels are hardened.
 *
 * @param components - Raw (un-hardened) path indices.
 * @returns Path string, e.g. `"m/9000'/8888'/1'/0'/0'/0'"`.
 */
export function formatPath(components: number[]): string {
  return "m/" + components.map(c => `${c}'`).join("/");
}

/**
 * Parse a hardened-only path string to raw component indices.
 *
 * @param path - Path string, e.g. `"m/9000'/8888'/1'/0'/0'/0'"`.
 * @returns Array of raw (un-hardened) indices.
 * @throws {Error} If any component is not hardened or the path is malformed.
 */
export function parsePath(path: string): number[] {
  if (!path.startsWith("m/")) {
    throw new Error(`path must start with "m/": ${path}`);
  }
  return path.slice(2).split("/").map(part => {
    if (!part.endsWith("'")) {
      throw new Error(`all path components must be hardened (end with '): ${part}`);
    }
    const n = parseInt(part.slice(0, -1), 10);
    if (isNaN(n) || n < 0 || n >= HARDENED_OFFSET) {
      throw new Error(`invalid path component: ${part}`);
    }
    return n;
  });
}
