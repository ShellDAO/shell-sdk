/**
 * Encrypted keystore utilities for Shell Chain.
 *
 * Shell keystore files are JSON objects that store a post-quantum private key
 * encrypted with:
 * - **KDF**: argon2id (memory-hard password derivation)
 * - **Cipher**: xchacha20-poly1305 (authenticated encryption)
 *
 * ## Keystore format (v1 — canonical)
 *
 * The **ciphertext** contains **only the secret key bytes** (sk-only format).
 * The public key is stored separately in the `public_key` field as plain hex.
 * This matches the format produced by `shell-node key generate`.
 *
 * Previous SDK versions expected `sk || pk` in the ciphertext. That format
 * is no longer produced or accepted; all new keystores use sk-only.
 *
 * @module keystore
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2id } from "hash-wasm";

import { derivePqAddressFromPublicKey, normalizePqAddress } from "./address.js";
import { adapterFromKeyPair } from "./adapters.js";
import {
  ShellSigner,
  canonicalSignatureType,
  publicKeyFromHex,
  signatureTypeFromKeyType,
} from "./signer.js";
import type { ShellEncryptedKey, SignatureTypeName } from "./types.js";

/**
 * Parsed metadata from an encrypted Shell keystore file.
 *
 * Produced by {@link parseEncryptedKey}; does **not** contain the decrypted private key.
 */
export interface ParsedShellKeystore {
  /** The raw keystore object as parsed from JSON. */
  raw: ShellEncryptedKey;
  /** Resolved signature algorithm name. */
  signatureType: SignatureTypeName;
  /** Numeric algorithm ID (0/1/2). */
  algorithmId: number;
  /** Raw public key bytes decoded from `raw.public_key`. */
  publicKey: Uint8Array;
  /** Canonical `pq1…` address derived from `publicKey`. */
  canonicalAddress: string;
}

const SIG_IDS: Record<SignatureTypeName, number> = { "ML-DSA-65": 1, Dilithium3: 0, MlDsa65: 1, SphincsSha2256f: 2 };

/**
 * Parse a Shell keystore file (string or object) and extract public metadata.
 *
 * Does **not** decrypt the private key. Use {@link decryptKeystore} for full
 * decryption.
 *
 * @param input - Keystore JSON string or already-parsed {@link ShellEncryptedKey} object.
 * @returns {@link ParsedShellKeystore} with algorithm info, public key, and derived addresses.
 * @throws {Error} If `key_type` is not a recognised algorithm.
 *
 * @example
 * ```typescript
 * const parsed = parseEncryptedKey(readFileSync("key.json", "utf8"));
 * console.log(parsed.canonicalAddress); // pq1…
 * console.log(parsed.signatureType);    // "ML-DSA-65"
 * ```
 */
export function parseEncryptedKey(input: string | ShellEncryptedKey): ParsedShellKeystore {
  const raw = typeof input === "string" ? (JSON.parse(input) as ShellEncryptedKey) : input;
  const signatureType = signatureTypeFromKeyType(raw.key_type);
  const algorithmId = SIG_IDS[signatureType];
  const publicKey = publicKeyFromHex(raw.public_key);
  const canonicalAddress = derivePqAddressFromPublicKey(publicKey, algorithmId);
  return { raw, signatureType, algorithmId, publicKey, canonicalAddress };
}

/**
 * Parse a keystore and verify that the declared address matches the public key.
 *
 * @param input - Keystore JSON string or object.
 * @returns {@link ParsedShellKeystore} if validation passes.
 * @throws {Error} If the declared address does not match the address derived from the public key.
 *
 * @example
 * ```typescript
 * const parsed = validateEncryptedKeyAddress(json); // throws if tampered
 * ```
 */
export function validateEncryptedKeyAddress(input: string | ShellEncryptedKey): ParsedShellKeystore {
  const parsed = parseEncryptedKey(input);
  const declared = normalizePqAddress(parsed.raw.address);
  if (declared !== parsed.canonicalAddress) {
    throw new Error("keystore address mismatch: declared=" + declared + " derived=" + parsed.canonicalAddress);
  }
  return parsed;
}

/**
 * Serialise a keystore to a pretty-printed JSON string.
 *
 * @param input - Keystore JSON string or object.
 * @returns Indented JSON string (2-space indent).
 */
export function exportEncryptedKeyJson(input: string | ShellEncryptedKey): string {
  return JSON.stringify(typeof input === "string" ? JSON.parse(input) : input, null, 2);
}

/**
 * Assert that a {@link ShellSigner} corresponds to the given keystore.
 *
 * Checks that the signature algorithm and derived address both match.
 *
 * @param signer - The signer to verify.
 * @param keystore - The parsed keystore to compare against.
 * @throws {Error} If the algorithm or address does not match.
 *
 * @example
 * ```typescript
 * assertSignerMatchesKeystore(signer, parsed); // throws on mismatch
 * ```
 */
export function assertSignerMatchesKeystore(signer: ShellSigner, keystore: ParsedShellKeystore): void {
  if (canonicalSignatureType(signer.signatureType) !== keystore.signatureType) {
    throw new Error("algorithm mismatch: signer=" + signer.signatureType + " keystore=" + keystore.signatureType);
  }
  const addr = signer.getAddress();
  if (addr !== keystore.canonicalAddress) {
    throw new Error("address mismatch: signer=" + addr + " keystore=" + keystore.canonicalAddress);
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("invalid hex");
  const buf = new Uint8Array(hex.length / 2);
  for (let i = 0; i < buf.length; i++) buf[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return buf;
}

/**
 * Decrypt a Shell keystore file and return a ready-to-use {@link ShellSigner}.
 *
 * **KDF**: argon2id (parameters from `kdf_params`)
 * **Cipher**: xchacha20-poly1305 (24-byte nonce from `cipher_params`)
 * **Plaintext layout (v1)**: secret key bytes only (sk-only format).
 * The public key is read from the `public_key` JSON field directly.
 *
 * @param input - Keystore JSON string or object.
 * @param password - The passphrase used to encrypt the key.
 * @returns A fully configured `ShellSigner` ready for signing transactions.
 * @throws {Error} If the KDF or cipher is unsupported.
 * @throws {Error} If decryption fails (wrong password or corrupt ciphertext).
 *
 * @example
 * ```typescript
 * const signer = await decryptKeystore(readFileSync("key.json", "utf8"), "my-passphrase");
 * console.log(signer.getAddress()); // pq1…
 * const hash = await provider.sendTransaction(await signer.buildSignedTransaction(…));
 * ```
 */
export async function decryptKeystore(
  input: string | ShellEncryptedKey,
  password: string,
): Promise<ShellSigner> {
  const parsed = validateEncryptedKeyAddress(input);
  const ek = parsed.raw;
  if (ek.kdf !== "argon2id") throw new Error("unsupported kdf: " + ek.kdf);
  if (ek.cipher !== "xchacha20-poly1305") throw new Error("unsupported cipher: " + ek.cipher);

  const salt = hexToBytes(ek.kdf_params.salt);
  const nonce = hexToBytes(ek.cipher_params.nonce);
  const ciphertext = hexToBytes(ek.ciphertext);

  const derivedKeyHex = await argon2id({
    password,
    salt,
    iterations: ek.kdf_params.t_cost,
    memorySize: ek.kdf_params.m_cost,
    parallelism: ek.kdf_params.p_cost,
    hashLength: 32,
    outputType: "hex",
  });
  const derivedKey = hexToBytes(derivedKeyHex);

  const chacha = xchacha20poly1305(derivedKey, nonce);
  // Plaintext is sk-only; public key comes from the JSON `public_key` field.
  const secretKey = chacha.decrypt(ciphertext);

  const adapter = adapterFromKeyPair(parsed.signatureType, parsed.publicKey, secretKey);
  return new ShellSigner(parsed.signatureType, adapter);
}
