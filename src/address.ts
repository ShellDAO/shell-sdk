/**
 * PQ address utilities for Shell Chain.
 *
 * Shell Chain uses **bech32m**-encoded addresses (prefix `"pq"`) instead of
 * Ethereum's checksummed hex format. Each address encodes a version byte and
 * 20 address bytes derived from the account's post-quantum public key:
 *
 * ```
 * address_bytes = blake3(version || algo_id || public_key)[0..20]
 * bech32m_address = bech32m_encode("pq", [version, ...address_bytes])
 * ```
 *
 * Algorithm IDs: Dilithium3=0, MlDsa65=1, SphincsSha2256f=2.
 *
 * Both pq1… and 0x… representations refer to the same underlying 20 bytes;
 * the SDK accepts either form in most places via the `AddressLike` type.
 *
 * @module address
 */
import { blake3 } from "@noble/hashes/blake3";
import { bech32m } from "@scure/base";
import { bytesToHex, hexToBytes } from "viem";

/** Human-readable part (HRP) used in Shell bech32m addresses. */
export const PQ_ADDRESS_HRP = "pq";

/** Number of raw address bytes (excluding the version byte). */
export const PQ_ADDRESS_LENGTH = 20;

/** Version byte for V1 Shell addresses (`0x01`). */
export const PQ_ADDRESS_VERSION_V1 = 0x01;

type Bech32Address = `${string}1${string}`;
type HexAddress = `0x${string}`;

function assertBech32Address(value: string): asserts value is Bech32Address {
  if (!value.includes("1")) {
    throw new Error("invalid bech32m address");
  }
}

function assertHexAddress(value: string): asserts value is HexAddress {
  if (!value.startsWith("0x")) {
    throw new Error("invalid hex address");
  }
}

/**
 * Encode 20 raw address bytes as a `pq1…` bech32m address.
 *
 * @param bytes - Exactly 20 address bytes (the 20-byte hash derived from a public key).
 * @param version - Address version byte; defaults to {@link PQ_ADDRESS_VERSION_V1} (`0x01`).
 * @returns The bech32m-encoded address string, e.g. `"pq1qx3f…"`.
 * @throws {Error} If `bytes.length !== 20` or `version` is out of the 0–255 range.
 *
 * @example
 * ```typescript
 * const addr = bytesToPqAddress(hashBytes);
 * // → "pq1qx3f…"
 * ```
 */
export function bytesToPqAddress(
  bytes: Uint8Array,
  version: number = PQ_ADDRESS_VERSION_V1,
): string {
  if (bytes.length !== PQ_ADDRESS_LENGTH) {
    throw new Error(`expected ${PQ_ADDRESS_LENGTH} address bytes, got ${bytes.length}`);
  }
  if (version < 0 || version > 255) {
    throw new Error(`invalid address version: ${version}`);
  }

  const payload = new Uint8Array(1 + PQ_ADDRESS_LENGTH);
  payload[0] = version;
  payload.set(bytes, 1);
  return bech32m.encode(PQ_ADDRESS_HRP, bech32m.toWords(payload));
}

/**
 * Decode a `pq1…` bech32m address to its raw 20 address bytes.
 *
 * The version byte is stripped; use {@link pqAddressVersion} to retrieve it.
 *
 * @param address - A valid `pq1…` bech32m address.
 * @returns The 20-byte address payload (version byte excluded).
 * @throws {Error} If the prefix is not `"pq"` or the payload length is wrong.
 *
 * @example
 * ```typescript
 * const bytes = pqAddressToBytes("pq1qx3f…");
 * // bytes.length === 20
 * ```
 */
export function pqAddressToBytes(address: string): Uint8Array {
  assertBech32Address(address);
  const { prefix, words } = bech32m.decode(address);

  if (prefix !== PQ_ADDRESS_HRP) {
    throw new Error(`expected ${PQ_ADDRESS_HRP} address prefix, got ${prefix}`);
  }

  const bytes = Uint8Array.from(bech32m.fromWords(words));
  if (bytes.length !== 1 + PQ_ADDRESS_LENGTH) {
    throw new Error(`expected ${1 + PQ_ADDRESS_LENGTH} address bytes, got ${bytes.length}`);
  }

  return bytes.slice(1);
}

/**
 * Extract the version byte from a `pq1…` bech32m address.
 *
 * @param address - A valid `pq1…` bech32m address.
 * @returns The version byte (e.g. `1` for V1 addresses).
 * @throws {Error} If the address is malformed.
 */
export function pqAddressVersion(address: string): number {
  assertBech32Address(address);
  const { words } = bech32m.decode(address);
  const bytes = Uint8Array.from(bech32m.fromWords(words));
  if (bytes.length !== 1 + PQ_ADDRESS_LENGTH) {
    throw new Error(`expected ${1 + PQ_ADDRESS_LENGTH} address bytes, got ${bytes.length}`);
  }
  return bytes[0];
}

/**
 * Parse a `0x…` hex address string into its raw 20 bytes.
 *
 * @param address - A `0x`-prefixed 40-character hex address.
 * @returns The 20-byte address payload.
 * @throws {Error} If the string does not start with `"0x"` or is not exactly 20 bytes.
 */
export function hexAddressToBytes(address: string): Uint8Array {
  assertHexAddress(address);
  const bytes = hexToBytes(address);
  if (bytes.length !== PQ_ADDRESS_LENGTH) {
    throw new Error(`expected ${PQ_ADDRESS_LENGTH} address bytes, got ${bytes.length}`);
  }
  return bytes;
}

/**
 * Encode 20 raw address bytes as a `0x…` hex address.
 *
 * @param bytes - Exactly 20 address bytes.
 * @returns A `0x`-prefixed 40-character hex string.
 * @throws {Error} If `bytes.length !== 20`.
 */
export function bytesToHexAddress(bytes: Uint8Array): HexAddress {
  if (bytes.length !== PQ_ADDRESS_LENGTH) {
    throw new Error(`expected ${PQ_ADDRESS_LENGTH} address bytes, got ${bytes.length}`);
  }
  return bytesToHex(bytes);
}

/**
 * Normalise an address to `pq1…` bech32m form.
 *
 * Accepts either a `pq1…` or `0x…` address and always returns the canonical
 * bech32m form.
 *
 * @param address - A `pq1…` or `0x…` address.
 * @returns The `pq1…` bech32m address.
 */
export function normalizePqAddress(address: string): string {
  if (isPqAddress(address)) {
    return address;
  }

  return bytesToPqAddress(hexAddressToBytes(address));
}

/**
 * Normalise an address to `0x…` hex form.
 *
 * Accepts either a `pq1…` or `0x…` address and always returns the hex form.
 *
 * @param address - A `pq1…` or `0x…` address.
 * @returns The `0x`-prefixed hex address.
 */
export function normalizeHexAddress(address: string): HexAddress {
  if (isPqAddress(address)) {
    return bytesToHexAddress(pqAddressToBytes(address));
  }

  assertHexAddress(address);
  return address;
}

/**
 * Derive a `pq1…` address from a raw post-quantum public key.
 *
 * The derivation is:
 * ```
 * address_bytes = blake3(version || algo_id || public_key)[0..20]
 * ```
 *
 * @param publicKey - Raw public key bytes (length depends on algorithm).
 * @param algorithmId - Numeric algorithm ID: Dilithium3=0, MlDsa65=1, SphincsSha2256f=2.
 * @param version - Address version byte; defaults to {@link PQ_ADDRESS_VERSION_V1}.
 * @returns The derived `pq1…` bech32m address.
 * @throws {Error} If `algorithmId` is outside 0–255.
 *
 * @example
 * ```typescript
 * const address = derivePqAddressFromPublicKey(publicKey, 1 /* MlDsa65 *\/);
 * // → "pq1qx3f…"
 * ```
 */
export function derivePqAddressFromPublicKey(
  publicKey: Uint8Array,
  algorithmId: number,
  version: number = PQ_ADDRESS_VERSION_V1,
): string {
  if (algorithmId < 0 || algorithmId > 255) {
    throw new Error(`invalid algorithm id: ${algorithmId}`);
  }

  const input = new Uint8Array(2 + publicKey.length);
  input[0] = version;
  input[1] = algorithmId;
  input.set(publicKey, 2);

  const hash = blake3(input);
  return bytesToPqAddress(hash.slice(0, PQ_ADDRESS_LENGTH), version);
}

/**
 * Return `true` if `address` is a structurally valid `pq1…` bech32m address.
 *
 * Does **not** check whether the address exists on-chain.
 *
 * @param address - Any string to test.
 * @returns `true` if the string is a valid Shell bech32m address.
 *
 * @example
 * ```typescript
 * isPqAddress("pq1qx3f…"); // true
 * isPqAddress("0xabc…");   // false
 * isPqAddress("garbage");   // false
 * ```
 */
export function isPqAddress(address: string): boolean {
  try {
    pqAddressToBytes(address);
    return true;
  } catch {
    return false;
  }
}
