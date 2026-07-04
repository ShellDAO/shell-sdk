/**
 * Shell address utilities for Shell Chain.
 *
 * Shell Chain uses **0x-prefixed 64-character lowercase hex** addresses exclusively.
 * Each address is the full 32-byte BLAKE3 output derived from the account's
 * post-quantum public key:
 *
 * ```
 * address_bytes = BLAKE3(algo_id || public_key)   // full 32 bytes, no truncation
 * address_string = "0x" + hex_lower(address_bytes)
 * ```
 *
 * Algorithm IDs: Dilithium3=0, MlDsa65=1, SphincsSha2256f=2.
 *
 * @module address
 */
import { blake3 } from "@noble/hashes/blake3";

/** Number of raw address bytes. */
export const SHELL_ADDRESS_LENGTH = 32;

/**
 * Encode 32 raw address bytes as a `0x`-prefixed hex string.
 *
 * @param bytes - Exactly 32 address bytes.
 * @returns The hex-encoded address string, e.g. `"0xabcdef…"`.
 * @throws {Error} If `bytes.length !== 32`.
 *
 * @example
 * ```typescript
 * const addr = bytesToShellAddress(hashBytes);
 * // → "0xabcdef…"
 * ```
 */
export function bytesToShellAddress(bytes: Uint8Array): string {
  if (bytes.length !== SHELL_ADDRESS_LENGTH) {
    throw new Error(`expected ${SHELL_ADDRESS_LENGTH} address bytes, got ${bytes.length}`);
  }
  return "0x" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Decode a `0x`-prefixed hex address to its raw 32 bytes.
 *
 * @param address - A valid `0x` + 64-char hex address string.
 * @returns The 32-byte address payload.
 * @throws {Error} If the address is not a valid Shell address.
 *
 * @example
 * ```typescript
 * const bytes = shellAddressToBytes("0xabcdef…");
 * // bytes.length === 32
 * ```
 */
export function shellAddressToBytes(address: string): Uint8Array {
  if (!isShellAddress(address)) {
    throw new Error(`expected 0x + 64-char hex address, got: "${address.slice(0, 12)}…"`);
  }
  const hex = address.slice(2);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Normalise an address: validates it is a Shell `0x` hex address and returns it.
 *
 * @param address - A `0x` + 64-char hex address string.
 * @returns The same address (validated, lowercased).
 * @throws {Error} If the address is not a valid Shell hex address.
 */
export function normalizeShellAddress(address: string): string {
  if (!isShellAddress(address)) {
    throw new Error(`expected a 0x + 64-char hex address, got: "${address.slice(0, 12)}…"`);
  }
  return address.toLowerCase();
}

/**
 * Derive a Shell address from a raw post-quantum public key.
 *
 * The derivation is:
 * ```
 * address_bytes = BLAKE3(algo_id || public_key)   // full 32 bytes, no version byte
 * ```
 *
 * @param publicKey - Raw public key bytes (length depends on algorithm).
 * @param algorithmId - Numeric algorithm ID: Dilithium3=0, MlDsa65=1, SphincsSha2256f=2.
 * @returns The derived `0x`-prefixed hex address.
 * @throws {Error} If `algorithmId` is outside 0–255.
 *
 * @example
 * ```typescript
 * const address = deriveShellAddressFromPublicKey(publicKey, 1 /* MlDsa65 *\/);
 * // → "0xabcdef…"
 * ```
 */
export function deriveShellAddressFromPublicKey(
  publicKey: Uint8Array,
  algorithmId: number,
): string {
  if (!Number.isInteger(algorithmId) || algorithmId < 0 || algorithmId > 255) {
    throw new Error(`invalid algorithm id: ${algorithmId}`);
  }

  const input = new Uint8Array(1 + publicKey.length);
  input[0] = algorithmId;
  input.set(publicKey, 1);

  const hash = blake3(input);
  return bytesToShellAddress(hash);
}

/**
 * Return `true` if `address` is a structurally valid Shell address (`0x` + 64 hex chars).
 *
 * Does **not** check whether the address exists on-chain.
 *
 * @param address - Any string to test.
 * @returns `true` if the string is a valid Shell hex address.
 *
 * @example
 * ```typescript
 * isShellAddress("0xabcdef…"); // true
 * isShellAddress("pq1qx3f…"); // false
 * isShellAddress("garbage");   // false
 * ```
 */
export function isShellAddress(address: string): boolean {
  return /^0x[0-9a-f]{64}$/i.test(address);
}

// ---------------------------------------------------------------------------
// Legacy aliases (deprecated — use the Shell* variants above)
// ---------------------------------------------------------------------------

/** @deprecated Use {@link bytesToShellAddress} */
export const bytesToPqAddress = bytesToShellAddress;
/** @deprecated Use {@link shellAddressToBytes} */
export const pqAddressToBytes = shellAddressToBytes;
/** @deprecated Use {@link normalizeShellAddress} */
export const normalizePqAddress = normalizeShellAddress;
/** @deprecated Use {@link deriveShellAddressFromPublicKey} */
export function derivePqAddressFromPublicKey(
  publicKey: Uint8Array,
  algorithmId: number,
  _version?: number,
): string {
  return deriveShellAddressFromPublicKey(publicKey, algorithmId);
}
/** @deprecated Use {@link isShellAddress} */
export const isPqAddress = isShellAddress;
/** @deprecated No longer meaningful — Shell addresses have no version byte */
export function pqAddressVersion(_address: string): number {
  return 0;
}
