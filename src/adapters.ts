/**
 * Concrete SignerAdapter implementations for each PQ algorithm.
 *
 * `@noble/post-quantum` provides ML-DSA-65 and SLH-DSA-SHA2-256f via
 * WebAssembly-accelerated pure-JS implementations.
 *
 * **Dilithium3 compatibility note**: `pqcrypto-dilithium` v0.5 (used by
 * shell-chain) implements ML-DSA-65 (FIPS 204) under the `dilithium3` name.
 * `@noble/post-quantum` `ml_dsa65` produces byte-identical keys and
 * signatures (pk=1952, sk=4032, sig=3309), so `MlDsa65Adapter` is fully
 * wire-compatible with the chain's Dilithium3 verifier. Both `"Dilithium3"`
 * and `"MlDsa65"` algorithm names route to the same adapter.
 *
 * @module adapters
 */

import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { slh_dsa_sha2_256f } from "@noble/post-quantum/slh-dsa.js";

import type { SignerAdapter } from "./signer.js";
import type { SignatureTypeName } from "./types.js";

/** Key pair produced by {@link generateMlDsa65KeyPair}. */
export interface MlDsa65KeyPair { publicKey: Uint8Array; secretKey: Uint8Array; }

/** Key pair produced by {@link generateSlhDsaKeyPair}. */
export interface SlhDsaKeyPair { publicKey: Uint8Array; secretKey: Uint8Array; }

/**
 * Generate a fresh ML-DSA-65 key pair.
 *
 * @param seed - Optional 32-byte deterministic seed. A random seed is used when omitted.
 * @returns `{ publicKey, secretKey }` — public key is 1952 bytes, secret key is 4032 bytes.
 *
 * @example
 * ```typescript
 * const { publicKey, secretKey } = generateMlDsa65KeyPair();
 * ```
 */
export function generateMlDsa65KeyPair(seed?: Uint8Array): MlDsa65KeyPair {
  const s = seed ?? crypto.getRandomValues(new Uint8Array(32));
  return ml_dsa65.keygen(s);
}

/**
 * Generate a fresh SLH-DSA-SHA2-256f key pair.
 *
 * @param seed - Optional 96-byte deterministic seed. A random seed is used when omitted.
 * @returns `{ publicKey, secretKey }` — public key is 64 bytes, secret key is 128 bytes.
 *
 * @example
 * ```typescript
 * const { publicKey, secretKey } = generateSlhDsaKeyPair();
 * ```
 */
export function generateSlhDsaKeyPair(seed?: Uint8Array): SlhDsaKeyPair {
  const s = seed ?? crypto.getRandomValues(new Uint8Array(96));
  return slh_dsa_sha2_256f.keygen(s);
}

/**
 * {@link SignerAdapter} for ML-DSA-65 (NIST FIPS 204).
 *
 * This is the primary signing adapter for Shell Chain. It is also used for
 * `"Dilithium3"` keys since `pqcrypto-dilithium` v0.5 (the Rust crate used
 * by shell-chain) implements FIPS 204 ML-DSA-65 — producing byte-identical
 * keys and signatures (pk=1952 bytes, sk=4032 bytes, sig=3309 bytes).
 *
 * @example
 * ```typescript
 * // Generate a fresh key pair
 * const adapter = MlDsa65Adapter.generate();
 *
 * // Load an existing key pair (e.g. from a keystore)
 * const adapter = MlDsa65Adapter.fromKeyPair(publicKey, secretKey);
 * ```
 */
export class MlDsa65Adapter implements SignerAdapter {
  constructor(
    private readonly _publicKey: Uint8Array,
    private readonly _secretKey: Uint8Array,
  ) {}

  /**
   * Generate a fresh ML-DSA-65 key pair and wrap it in an adapter.
   *
   * @param seed - Optional 32-byte deterministic seed.
   */
  static generate(seed?: Uint8Array): MlDsa65Adapter {
    const kp = generateMlDsa65KeyPair(seed);
    return new MlDsa65Adapter(kp.publicKey, kp.secretKey);
  }

  /**
   * Wrap an existing ML-DSA-65 key pair in an adapter.
   *
   * @param pk - Raw public key bytes (1952 bytes).
   * @param sk - Raw secret key bytes (4032 bytes).
   */
  static fromKeyPair(pk: Uint8Array, sk: Uint8Array): MlDsa65Adapter {
    return new MlDsa65Adapter(pk, sk);
  }

  /** Return the raw ML-DSA-65 public key bytes (1952 bytes). */
  getPublicKey(): Uint8Array { return this._publicKey; }

  /**
   * Sign `message` with ML-DSA-65 and return the raw signature bytes.
   *
   * @param message - The bytes to sign (typically an RLP-encoded tx hash).
   */
  async sign(message: Uint8Array): Promise<Uint8Array> {
    return ml_dsa65.sign(message, this._secretKey);
  }
}

/**
 * {@link SignerAdapter} for SLH-DSA-SHA2-256f (NIST FIPS 205).
 *
 * Corresponds to the `"SphincsSha2256f"` signature type. Produces much larger
 * signatures (~49 KB) than ML-DSA-65 but offers stronger security assumptions.
 *
 * @example
 * ```typescript
 * const adapter = SlhDsaAdapter.generate();
 * const adapter = SlhDsaAdapter.fromKeyPair(publicKey, secretKey);
 * ```
 */
export class SlhDsaAdapter implements SignerAdapter {
  constructor(
    private readonly _publicKey: Uint8Array,
    private readonly _secretKey: Uint8Array,
  ) {}

  /**
   * Generate a fresh SLH-DSA-SHA2-256f key pair and wrap it in an adapter.
   *
   * @param seed - Optional 96-byte deterministic seed.
   */
  static generate(seed?: Uint8Array): SlhDsaAdapter {
    const kp = generateSlhDsaKeyPair(seed);
    return new SlhDsaAdapter(kp.publicKey, kp.secretKey);
  }

  /**
   * Wrap an existing SLH-DSA-SHA2-256f key pair in an adapter.
   *
   * @param pk - Raw public key bytes (64 bytes).
   * @param sk - Raw secret key bytes (128 bytes).
   */
  static fromKeyPair(pk: Uint8Array, sk: Uint8Array): SlhDsaAdapter {
    return new SlhDsaAdapter(pk, sk);
  }

  /** Return the raw SLH-DSA public key bytes (64 bytes). */
  getPublicKey(): Uint8Array { return this._publicKey; }

  /**
   * Sign `message` with SLH-DSA-SHA2-256f and return the raw signature bytes.
   *
   * @param message - The bytes to sign (typically an RLP-encoded tx hash).
   */
  async sign(message: Uint8Array): Promise<Uint8Array> {
    return slh_dsa_sha2_256f.sign(message, this._secretKey);
  }
}

/**
 * Generate a fresh {@link SignerAdapter} for the given algorithm.
 *
 * A convenience factory that dispatches to the correct adapter class.
 *
 * @param algorithm - The PQ algorithm to use.
 * @param seed - Optional deterministic seed (32 bytes for ML-DSA-65, 96 bytes for SLH-DSA).
 * @returns A ready-to-use `SignerAdapter`.
 * @throws {Error} If `algorithm` is not one of the supported values.
 *
 * @example
 * ```typescript
 * const adapter = generateAdapter("MlDsa65");
 * const adapter = generateAdapter("SphincsSha2256f", mySeed);
 * ```
 */
export function generateAdapter(algorithm: SignatureTypeName, seed?: Uint8Array): SignerAdapter {
  switch (algorithm) {
    case "ML-DSA-65":
    case "Dilithium3":
    case "MlDsa65":
      return MlDsa65Adapter.generate(seed);
    case "SphincsSha2256f":
      return SlhDsaAdapter.generate(seed ? seed.slice(0, 96) : undefined);
    default:
      throw new Error("unsupported algorithm: " + algorithm);
  }
}

/**
 * Build a {@link SignerAdapter} from an existing key pair (e.g. loaded from a keystore).
 *
 * @param algorithm - The PQ algorithm.
 * @param publicKey - Raw public key bytes.
 * @param secretKey - Raw secret key bytes.
 * @returns A `SignerAdapter` backed by the provided key pair.
 * @throws {Error} If `algorithm` is not one of the supported values.
 *
 * @example
 * ```typescript
 * const adapter = adapterFromKeyPair("MlDsa65", publicKey, secretKey);
 * ```
 */
export function adapterFromKeyPair(
  algorithm: SignatureTypeName,
  publicKey: Uint8Array,
  secretKey: Uint8Array,
): SignerAdapter {
  switch (algorithm) {
    case "ML-DSA-65":
    case "Dilithium3":
    case "MlDsa65":
      return MlDsa65Adapter.fromKeyPair(publicKey, secretKey);
    case "SphincsSha2256f":
      return SlhDsaAdapter.fromKeyPair(publicKey, secretKey);
    default:
      throw new Error("unsupported algorithm: " + algorithm);
  }
}
