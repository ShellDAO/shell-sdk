/**
 * System contract addresses and calldata encoders for Shell Chain.
 *
 * Shell Chain ships two built-in system contracts at well-known addresses:
 *
 * - **ValidatorRegistry** (`0x…0001`) — manages the set of active validators.
 * - **AccountManager** (`0x…0002`) — handles per-account key rotation,
 *   custom AA validation code, and (v0.19.0+) guardian recovery.
 *
 * Transactions targeting these contracts should be built with the helpers in
 * `transactions.ts` (e.g. {@link buildRotateKeyTransaction}).
 *
 * ## AA Phase 2 — Guardian Recovery (v0.19.0-dev)
 *
 * Use {@link encodeSetGuardiansCalldata}, {@link encodeSubmitRecoveryCalldata},
 * {@link encodeExecuteRecoveryCalldata}, and {@link encodeCancelRecoveryCalldata}.
 *
 * @module system-contracts
 */
import { bytesToHex, encodeAbiParameters, keccak256, toBytes } from "viem";

import { bytesToShellAddress, shellAddressToBytes } from "./address.js";
import type { AddressLike, HexString } from "./types.js";

const SYSTEM_ADDRESS_LENGTH = 32;

/** Maximum public-key payload accepted by AccountManager calls. */
export const MAX_ACCOUNT_PUBLIC_KEY_BYTES = 4_096;

function validateAccountPublicKey(publicKey: Uint8Array): void {
  if (publicKey.length === 0) {
    throw new RangeError("public key must not be empty");
  }
  if (publicKey.length > MAX_ACCOUNT_PUBLIC_KEY_BYTES) {
    throw new RangeError(
      `public key is too large: ${publicKey.length} bytes (max ${MAX_ACCOUNT_PUBLIC_KEY_BYTES})`,
    );
  }
}

function systemAddress(lastByte: number): Uint8Array {
  const bytes = new Uint8Array(SYSTEM_ADDRESS_LENGTH);
  bytes[SYSTEM_ADDRESS_LENGTH - 1] = lastByte;
  return bytes;
}

function selector(signature: string): HexString {
  return keccak256(toBytes(signature)).slice(0, 10) as HexString;
}

/** `0x`-prefixed hex address of the ValidatorRegistry system contract. */
export const validatorRegistryAddress = bytesToShellAddress(systemAddress(1));

/** `0x`-prefixed hex address of the AccountManager system contract. */
export const accountManagerAddress = bytesToShellAddress(systemAddress(2));

/** 4-byte ABI function selector for `rotateKey(bytes,uint8)`. */
export const rotateKeySelector = selector("rotateKey(bytes,uint8)");

/** 4-byte ABI function selector for `setValidationCode(bytes32)`. */
export const setValidationCodeSelector = selector("setValidationCode(bytes32)");

/** 4-byte ABI function selector for `clearValidationCode()`. */
export const clearValidationCodeSelector = selector("clearValidationCode()");

// ---------------------------------------------------------------------------
// AA Phase 2 — Guardian Recovery selectors (v0.19.0-dev)
// ---------------------------------------------------------------------------

/** 4-byte ABI function selector for `setGuardians(address[],uint8,uint64)`. */
export const setGuardiansSelector = selector("setGuardians(address[],uint8,uint64)");

/** 4-byte ABI function selector for `submitRecovery(address,bytes,uint8)`. */
export const submitRecoverySelector = selector("submitRecovery(address,bytes,uint8)");

/** 4-byte ABI function selector for `executeRecovery(address)`. */
export const executeRecoverySelector = selector("executeRecovery(address)");

/** 4-byte ABI function selector for `cancelRecovery(address)`. */
export const cancelRecoverySelector = selector("cancelRecovery(address)");

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
  validateAccountPublicKey(publicKey);
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
 * @param address - `0x…` hex address to test.
 * @returns `true` if the address matches AccountManager or ValidatorRegistry.
 *
 * @example
 * ```typescript
 * isSystemContractAddress(accountManagerAddress);  // true
 * isSystemContractAddress("0xsomeuser…");         // false
 * ```
 */
export function isSystemContractAddress(address: AddressLike): boolean {
  return address === accountManagerAddress || address === validatorRegistryAddress;
}

// ---------------------------------------------------------------------------
// AA Phase 2 — Guardian Recovery calldata encoders (v0.19.0-dev)
// ---------------------------------------------------------------------------

/**
 * ABI-encode calldata for `setGuardians(address[] guardians, uint8 threshold, uint64 timelock)`.
 *
 * Configures the guardian recovery set for the caller's account. Only the
 * account owner can call this (the call must be made as an inner call from
 * the owner's AA bundle, or as a direct transaction).
 *
 * @param guardians - Array of guardian addresses (1..5). Must be `0x…` hex form.
 * @param threshold - k-of-n required votes (1 ≤ threshold ≤ guardians.length).
 * @param timelock - Minimum blocks between threshold-reach and execution (≥ 100).
 * @returns `HexString` with the 4-byte selector prepended.
 *
 * @example
 * ```typescript
 * const data = encodeSetGuardiansCalldata(
 *   ["0xguardian…", "0xguardian…", "0xguardian…"],
 *   2,   // 2-of-3 threshold
 *   100, // 100-block timelock
 * );
 * ```
 */
export function encodeSetGuardiansCalldata(
  guardians: AddressLike[],
  threshold: number,
  timelock: number,
): HexString {
  const hexGuardians = guardians.map(shellAddressToNativeHex);
  const encoded = encodeAbiParameters(
    [{ type: "bytes32[]" }, { type: "uint8" }, { type: "uint64" }],
    [hexGuardians, threshold, BigInt(timelock)],
  );
  return `${setGuardiansSelector}${encoded.slice(2)}` as HexString;
}

/**
 * ABI-encode calldata for `submitRecovery(address account, bytes newPubkey, uint8 newAlgo)`.
 *
 * Called by a guardian to vote for a new PQ public key on behalf of `account`.
 * When k-of-n threshold is reached, the proposal becomes executable after
 * `timelock` blocks.
 *
 * @param account - Account being recovered (`0x…` hex form).
 * @param newPubkey - Raw bytes of the new PQ public key.
 * @param newAlgo - Algorithm ID for the new key (ML-DSA-65 = 0, etc.).
 * @returns `HexString` with the 4-byte selector prepended.
 *
 * @example
 * ```typescript
 * const data = encodeSubmitRecoveryCalldata(
 *   "0xaccountaddress…",
 *   newPubkeyBytes,
 *   0, // ML-DSA-65
 * );
 * ```
 */
export function encodeSubmitRecoveryCalldata(
  account: AddressLike,
  newPubkey: Uint8Array,
  newAlgo: number,
): HexString {
  validateAccountPublicKey(newPubkey);
  const hexAccount = shellAddressToNativeHex(account);
  const encoded = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes" }, { type: "uint8" }],
    [hexAccount, bytesToHex(newPubkey), newAlgo],
  );
  return `${submitRecoverySelector}${encoded.slice(2)}` as HexString;
}

/**
 * ABI-encode calldata for `executeRecovery(address account)`.
 *
 * Can be called by anyone once the recovery proposal has reached maturity
 * (`current_block >= maturity_block && maturity_block != 0`).
 *
 * @param account - Account whose recovery proposal to execute.
 * @returns `HexString` with the 4-byte selector prepended.
 */
export function encodeExecuteRecoveryCalldata(account: AddressLike): HexString {
  const hexAccount = shellAddressToNativeHex(account);
  const encoded = encodeAbiParameters([{ type: "bytes32" }], [hexAccount]);
  return `${executeRecoverySelector}${encoded.slice(2)}` as HexString;
}

/**
 * ABI-encode calldata for `cancelRecovery(address account)`.
 *
 * Owner-only: removes the active recovery proposal. Useful if the account
 * owner regains access before the timelock expires.
 *
 * @param account - Account whose recovery proposal to cancel (must be caller).
 * @returns `HexString` with the 4-byte selector prepended.
 */
export function encodeCancelRecoveryCalldata(account: AddressLike): HexString {
  const hexAccount = shellAddressToNativeHex(account);
  const encoded = encodeAbiParameters([{ type: "bytes32" }], [hexAccount]);
  return `${cancelRecoverySelector}${encoded.slice(2)}` as HexString;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Preserve the native address in the 32-byte ABI word decoded by AccountManager. */
function shellAddressToNativeHex(address: AddressLike): `0x${string}` {
  return bytesToHex(shellAddressToBytes(address as string));
}
