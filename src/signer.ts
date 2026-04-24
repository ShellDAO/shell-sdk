/**
 * ShellSigner and SignerAdapter — the signing layer for Shell Chain transactions.
 *
 * `SignerAdapter` is a minimal interface for plugging in any PQ signing
 * implementation. Concrete adapters live in `adapters.ts`.
 *
 * `ShellSigner` wraps an adapter and adds address derivation, transaction
 * building, and Shell-specific helpers.
 *
 * @module signer
 */
import { hexToBytes } from "viem";

import { derivePqAddressFromPublicKey, normalizeHexAddress, normalizePqAddress } from "./address.js";
import {
  buildSignature,
  buildSignedTransaction,
  type BuildSignedTransactionOptions,
} from "./transactions.js";
import type { SignedShellTransaction, SignatureTypeName } from "./types.js";

/**
 * Maps each {@link SignatureTypeName} to its numeric algorithm ID used in
 * address derivation and on-chain records.
 *
 * - `"ML-DSA-65"` → `0` (canonical FIPS 204 name)
 * - `"Dilithium3"` → `0` (legacy alias, same algorithm)
 * - `"MlDsa65"` → `0` (camelCase alias, same algorithm)
 * - `"SphincsSha2256f"` → `2`
 */
export const SIGNATURE_TYPE_IDS: Record<SignatureTypeName, number> = {
  "ML-DSA-65": 0,
  Dilithium3: 0,
  MlDsa65: 0,
  SphincsSha2256f: 2,
};

/**
 * Maps the `key_type` strings found in Shell keystore files to their
 * corresponding {@link SignatureTypeName}.
 *
 * Keys are lowercase; matching is done after calling `.toLowerCase()`.
 * Always returns the FIPS 204 canonical name `"ML-DSA-65"` for ML-DSA-65 variants.
 */
export const KEY_TYPE_TO_SIGNATURE_TYPE: Record<string, SignatureTypeName> = {
  "ml-dsa-65": "ML-DSA-65",
  mldsa65: "ML-DSA-65",
  dilithium3: "ML-DSA-65",
  "sphincs-sha2-256f": "SphincsSha2256f",
};

/**
 * Minimal interface that any post-quantum signing implementation must satisfy
 * to be used with {@link ShellSigner}.
 *
 * @example
 * ```typescript
 * class MyAdapter implements SignerAdapter {
 *   getPublicKey(): Uint8Array { … }
 *   async sign(message: Uint8Array): Promise<Uint8Array> { … }
 * }
 * ```
 */
export interface SignerAdapter {
  /**
   * Sign a raw message (the transaction hash bytes) and return the signature.
   *
   * @param message - The bytes to sign (typically an RLP-encoded tx hash).
   * @returns The raw signature bytes.
   */
  sign(message: Uint8Array): Promise<Uint8Array>;

  /** Return the raw public key bytes for this signer. */
  getPublicKey(): Uint8Array;
}

/**
 * High-level Shell Chain signer.
 *
 * Wraps a {@link SignerAdapter} and provides address derivation, signing, and
 * transaction assembly for Shell Chain.
 *
 * @example
 * ```typescript
 * import { MlDsa65Adapter } from "shell-sdk/adapters";
 * import { ShellSigner } from "shell-sdk/signer";
 *
 * const adapter = MlDsa65Adapter.generate();
 * const signer  = new ShellSigner("MlDsa65", adapter);
 *
 * console.log(signer.getAddress());    // pq1…
 * console.log(signer.getHexAddress()); // 0x…
 * ```
 */
export class ShellSigner {
  /** The signature algorithm this signer uses. */
  readonly signatureType: SignatureTypeName;
  /** The underlying adapter that performs the actual cryptographic operations. */
  readonly adapter: SignerAdapter;

  /**
   * @param signatureType - The PQ algorithm name.
   * @param adapter - An adapter providing `sign` and `getPublicKey`.
   */
  constructor(signatureType: SignatureTypeName, adapter: SignerAdapter) {
    this.signatureType = signatureType;
    this.adapter = adapter;
  }

  /**
   * Numeric algorithm ID for this signer's signature type.
   *
   * Used in address derivation and in `rotateKey` calldata.
   */
  get algorithmId(): number {
    return SIGNATURE_TYPE_IDS[this.signatureType];
  }

  /** Return the raw public key bytes from the underlying adapter. */
  getPublicKey(): Uint8Array {
    return this.adapter.getPublicKey();
  }

  /**
   * Derive and return the `pq1…` bech32m address for this signer.
   *
   * The address is computed deterministically from the public key and algorithm ID.
   */
  getAddress(): string {
    return derivePqAddressFromPublicKey(this.getPublicKey(), this.algorithmId);
  }

  /**
   * Return the `0x…` hex representation of this signer's address.
   *
   * Equivalent to `normalizeHexAddress(signer.getAddress())`.
   */
  getHexAddress(): `0x${string}` {
    return normalizeHexAddress(this.getAddress());
  }

  /**
   * Sign a raw byte message with the underlying adapter.
   *
   * @param message - Bytes to sign (e.g. RLP-encoded transaction hash).
   * @returns Raw signature bytes.
   */
  async sign(message: Uint8Array): Promise<Uint8Array> {
    return this.adapter.sign(message);
  }

  /**
   * Sign a transaction hash and assemble a complete {@link SignedShellTransaction}.
   *
   * @param options.tx - The unsigned `ShellTransactionRequest` to embed.
   * @param options.txHash - The bytes to sign (RLP-encoded EIP-1559 signing hash).
   * @param options.includePublicKey - When `true`, embeds `sender_pubkey` in the
   *   result. Required for accounts that have not yet appeared on-chain.
   * @returns A fully-signed transaction ready for {@link ShellProvider.sendTransaction}.
   *
   * @example
   * ```typescript
   * const signed = await signer.buildSignedTransaction({
   *   tx,
   *   txHash: rlpHashBytes,
   *   includePublicKey: true,
   * });
   * const hash = await provider.sendTransaction(signed);
   * ```
   */
  async buildSignedTransaction(
    options: Omit<BuildSignedTransactionOptions, "from" | "signature" | "signatureType"> & {
      txHash: Uint8Array;
      includePublicKey?: boolean;
      aaBundle?: import("./types.js").AaBundle;
    },
  ): Promise<SignedShellTransaction> {
    const signature = await this.sign(options.txHash);

    return buildSignedTransaction({
      from: normalizePqAddress(this.getAddress()),
      tx: options.tx,
      signature,
      signatureType: this.signatureType,
      senderPubkey: options.includePublicKey ? this.getPublicKey() : undefined,
      aaBbundle: options.aaBundle,
    });
  }
}

/**
 * Convert a keystore `key_type` string to a {@link SignatureTypeName}.
 *
 * Matching is case-insensitive and ignores leading/trailing whitespace.
 *
 * @param keyType - The `key_type` field from a Shell keystore file (e.g. `"mldsa65"`).
 * @returns The corresponding `SignatureTypeName`.
 * @throws {Error} If the key type is not recognised.
 *
 * @example
 * ```typescript
 * signatureTypeFromKeyType("mldsa65");          // "MlDsa65"
 * signatureTypeFromKeyType("sphincs-sha2-256f"); // "SphincsSha2256f"
 * ```
 */
export function signatureTypeFromKeyType(keyType: string): SignatureTypeName {
  const normalized = keyType.trim().toLowerCase();
  const value = KEY_TYPE_TO_SIGNATURE_TYPE[normalized];
  if (!value) {
    throw new Error(`unsupported key type: ${keyType}`);
  }
  return value;
}

/**
 * Convert a hex-encoded public key string to a `Uint8Array`.
 *
 * Accepts both `0x`-prefixed and bare hex strings.
 *
 * @param publicKeyHex - Hex-encoded public key (with or without `0x` prefix).
 * @returns The decoded public key bytes.
 *
 * @example
 * ```typescript
 * const pk = publicKeyFromHex("0xabcdef…");
 * const pk = publicKeyFromHex("abcdef…");
 * ```
 */
export function publicKeyFromHex(publicKeyHex: string): Uint8Array {
  return hexToBytes(`0x${publicKeyHex.replace(/^0x/i, "")}`);
}

/**
 * Build a {@link ShellSignature} object from raw signature bytes.
 *
 * A thin wrapper around {@link buildSignature} from `transactions.ts`.
 *
 * @param signatureType - The algorithm that produced the signature.
 * @param signature - Raw signature bytes.
 * @returns A `ShellSignature` with `sig_type` and `data` fields.
 */
export function buildShellSignature(signatureType: SignatureTypeName, signature: Uint8Array) {
  return buildSignature(signatureType, signature);
}
