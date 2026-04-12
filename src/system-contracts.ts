/**
 * System contract addresses and calldata encoders for Shell Chain.
 *
 * Shell Chain ships two built-in system contracts at well-known addresses:
 *
 * - **ValidatorRegistry** (`0x…0001`) — manages the set of active validators.
 * - **AccountManager** (`0x…0002`) — handles per-account key rotation and
 *   custom AA validation code.
 *
 * Transactions targeting these contracts should be built with the helpers in
 * `transactions.ts` (e.g. {@link buildRotateKeyTransaction}).
 *
 * @module system-contracts
 */
import { bytesToHex, encodeAbiParameters, keccak256, toBytes } from "viem";

import { bytesToPqAddress } from "./address.js";
import type { AddressLike, HexString } from "./types.js";

const SYSTEM_ADDRESS_LENGTH = 20;

function systemAddress(lastByte: number): Uint8Array {
  const bytes = new Uint8Array(SYSTEM_ADDRESS_LENGTH);
  bytes[SYSTEM_ADDRESS_LENGTH - 1] = lastByte;
  return bytes;
}

function selector(signature: string): HexString {
  return keccak256(toBytes(signature)).slice(0, 10) as HexString;
}

/** Hex address of the ValidatorRegistry system contract (`0x…0001`). */
export const validatorRegistryHexAddress = "0x0000000000000000000000000000000000000001";

/** Hex address of the AccountManager system contract (`0x…0002`). */
export const accountManagerHexAddress = "0x0000000000000000000000000000000000000002";

/** `pq1…` bech32m address of the ValidatorRegistry system contract. */
export const validatorRegistryAddress = bytesToPqAddress(systemAddress(1));

/** `pq1…` bech32m address of the AccountManager system contract. */
export const accountManagerAddress = bytesToPqAddress(systemAddress(2));

/** 4-byte ABI function selector for `rotateKey(bytes,uint8)`. */
export const rotateKeySelector = selector("rotateKey(bytes,uint8)");

/** 4-byte ABI function selector for `setValidationCode(bytes32)`. */
export const setValidationCodeSelector = selector("setValidationCode(bytes32)");

/** 4-byte ABI function selector for `clearValidationCode()`. */
export const clearValidationCodeSelector = selector("clearValidationCode()");

/**
 * ABI-encode calldata for `rotateKey(bytes publicKey, uint8 algorithmId)`.
 *
 * @param publicKey - Raw bytes of the new public key.
 * @param algorithmId - Numeric algorithm ID (Dilithium3=0, MlDsa65=1, SphincsSha2256f=2).
 * @returns `HexString` with the 4-byte selector prepended.
 *
 * @example
 * ```typescript
 * const data = encodeRotateKeyCalldata(newPublicKey, 1 /* MlDsa65 *\/);
 * ```
 */
export function encodeRotateKeyCalldata(publicKey: Uint8Array, algorithmId: number): HexString {
  const encoded = encodeAbiParameters(
    [
      { type: "bytes" },
      { type: "uint8" },
    ],
    [bytesToHex(publicKey), algorithmId],
  );

  return `${rotateKeySelector}${encoded.slice(2)}` as HexString;
}

/**
 * ABI-encode calldata for `setValidationCode(bytes32 codeHash)`.
 *
 * @param codeHash - `bytes32` hash of the custom validation contract.
 * @returns `HexString` with the 4-byte selector prepended.
 *
 * @example
 * ```typescript
 * const data = encodeSetValidationCodeCalldata("0xabc123…");
 * ```
 */
export function encodeSetValidationCodeCalldata(codeHash: HexString): HexString {
  const encoded = encodeAbiParameters([{ type: "bytes32" }], [codeHash]);
  return `${setValidationCodeSelector}${encoded.slice(2)}` as HexString;
}

/**
 * Return the 4-byte selector for `clearValidationCode()`.
 *
 * No parameters are encoded since the function takes no arguments.
 *
 * @returns The 4-byte function selector as a `HexString`.
 */
export function encodeClearValidationCodeCalldata(): HexString {
  return clearValidationCodeSelector;
}

/**
 * Return `true` if `address` refers to one of the Shell system contracts.
 *
 * Accepts both `pq1…` and `0x…` forms for the AccountManager and
 * ValidatorRegistry addresses.
 *
 * @param address - Address to test (any format accepted by `AddressLike`).
 * @returns `true` if the address matches AccountManager or ValidatorRegistry.
 *
 * @example
 * ```typescript
 * isSystemContractAddress("0x0000000000000000000000000000000000000002"); // true
 * isSystemContractAddress(accountManagerAddress);                        // true
 * isSystemContractAddress("pq1someuser…");                               // false
 * ```
 */
export function isSystemContractAddress(address: AddressLike): boolean {
  return (
    address === accountManagerAddress ||
    address === validatorRegistryAddress ||
    address === accountManagerHexAddress ||
    address === validatorRegistryHexAddress
  );
}
