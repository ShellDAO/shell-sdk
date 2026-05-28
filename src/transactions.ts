/**
 * Transaction builders for Shell Chain.
 *
 * Provides typed helpers for constructing `ShellTransactionRequest` objects
 * for common operations: token transfers, system contract calls, key rotation,
 * custom validation code management, and AA batch/sponsored transactions.
 *
 * @module transactions
 */
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, toRlp, hexToBytes } from "viem";

import type {
  AaBundle,
  AaInnerCall,
  AddressLike,
  HexString,
  HexQuantity,
  SessionAuth,
  ShellSignature,
  ShellTransactionRequest,
  SignedShellTransaction,
  SignatureTypeName,
} from "./types.js";
import { AA_BUNDLE_TX_TYPE, AA_MAX_INNER_CALLS } from "./types.js";
export { AA_BUNDLE_TX_TYPE, AA_MAX_INNER_CALLS };

// Domain separator for batch (AA bundle) signing hash (matches node PQTX_BUNDLE_V1\0\0).
const BATCH_SIGNING_HASH_DOMAIN = new Uint8Array([
  0x50, 0x51, 0x54, 0x58, 0x5f, 0x42, 0x55, 0x4e,
  0x44, 0x4c, 0x45, 0x5f, 0x56, 0x31, 0x00, 0x00,
]); // b"PQTX_BUNDLE_V1\0\0"

// Domain separator for paymaster signing hash (matches node PQTX_PAYMASTER_V).
const PAYMASTER_SIGNING_HASH_DOMAIN = new Uint8Array([
  0x50, 0x51, 0x54, 0x58, 0x5f, 0x50, 0x41, 0x59,
  0x4d, 0x41, 0x53, 0x54, 0x45, 0x52, 0x5f, 0x56,
]); // b"PQTX_PAYMASTER_V"

const SIGNATURE_TYPE_IDS: Record<SignatureTypeName, number> = {
  "ML-DSA-65": 1,
  Dilithium3: 0,
  MlDsa65: 1,
  SphincsSha2256f: 2,
};
import {
  accountManagerAddress,
  encodeClearValidationCodeCalldata,
  encodeRotateKeyCalldata,
  encodeSetValidationCodeCalldata,
} from "./system-contracts.js";
import { shellAddressToBytes } from "./address.js";
import { validateAddress, validateNonNegativeBigInt, validateNonNegativeInteger } from "./validation.js";

/** Default transaction type: `2` (Shell PQTx format; encodes EIP-1559 fee fields, which are scaffolded and not yet enforced on-chain). */
export const DEFAULT_TX_TYPE = 2;

/** Default gas limit for simple SHELL token transfers (`21_000`). */
export const DEFAULT_TRANSFER_GAS_LIMIT = 21_000;

/** Default gas limit for system contract calls (`100_000`). */
export const DEFAULT_SYSTEM_GAS_LIMIT = 100_000;

/** Default EIP-1559 max fee per gas: `1_000_000_000` wei (1 Gwei). */
export const DEFAULT_MAX_FEE_PER_GAS = 1_000_000_000;

/** Default EIP-1559 priority fee (tip) per gas: `100_000_000` wei (0.1 Gwei). */
export const DEFAULT_MAX_PRIORITY_FEE_PER_GAS = 100_000_000;

/** Options accepted by {@link buildTransaction}. */
export interface BuildTransactionOptions {
  /** EIP-155 chain ID (Shell Chain). Devnet = 424242. */
  chainId: number;
  /** Sender account nonce. */
  nonce: number;
  /** Recipient address, or `null` for contract deployment. */
  to: AddressLike | null;
  /** Transfer value in wei. Defaults to `0n`. */
  value?: bigint;
  /** ABI-encoded calldata. Defaults to `"0x"`. */
  data?: HexString;
  /** Gas limit. Defaults to {@link DEFAULT_TRANSFER_GAS_LIMIT}. */
  gasLimit?: number;
  /** EIP-1559 max fee per gas in wei (scaffolded; not enforced by the chain). Defaults to {@link DEFAULT_MAX_FEE_PER_GAS}. */
  maxFeePerGas?: number;
  /** EIP-1559 priority fee in wei (scaffolded; not enforced by the chain). Defaults to {@link DEFAULT_MAX_PRIORITY_FEE_PER_GAS}. */
  maxPriorityFeePerGas?: number;
  /** Transaction type. Defaults to {@link DEFAULT_TX_TYPE}. */
  txType?: number;
  /** Optional EIP-2930 access list. */
  accessList?: ShellTransactionRequest["access_list"];
  /** EIP-4844 max fee per blob gas. */
  maxFeePerBlobGas?: number | null;
  /** EIP-4844 blob versioned hashes. */
  blobVersionedHashes?: HexString[] | null;
}

/** Options accepted by {@link buildSignedTransaction}. */
export interface BuildSignedTransactionOptions {
  /** Sender address (0x… hex form). */
  from: AddressLike;
  /** The unsigned transaction payload. */
  tx: ShellTransactionRequest;
  /** Raw signature bytes. */
  signature: Uint8Array | number[];
  /** Algorithm that produced the signature. */
  signatureType: SignatureTypeName;
  /** Optional public key bytes to embed as `sender_pubkey`. */
  senderPubkey?: Uint8Array | number[];
  /** AA bundle to attach when `tx.tx_type === AA_BUNDLE_TX_TYPE`. */
  aaBundle?: AaBundle;
  /** @deprecated Use {@link aaBundle} (typo alias kept for backward compatibility). */
  aaBbundle?: AaBundle;
}

function toByteArray(bytes: Uint8Array | number[]): number[] {
  return Array.from(bytes);
}

function toHexData(data?: HexString): HexString {
  return data ?? "0x";
}

function toRlpUint(value: number | bigint | string): HexString {
  const numeric = typeof value === "string" ? BigInt(value) : BigInt(value);
  if (numeric === 0n) {
    return "0x";
  }
  return `0x${numeric.toString(16)}`;
}

function signatureTypeToId(signatureType: SignatureTypeName | number): number {
  if (typeof signatureType === "number") {
    if (!Number.isInteger(signatureType) || signatureType < 0 || signatureType > 255) {
      throw new RangeError(`signatureType id must be a byte, got: ${signatureType}`);
    }
    return signatureType;
  }

  const id = SIGNATURE_TYPE_IDS[signatureType];
  if (id == null) {
    throw new Error(`unsupported signature type: ${signatureType}`);
  }
  return id;
}

function encodeU64Be(value: number | bigint | string, fieldName: string): Uint8Array {
  const numeric = typeof value === "string" ? BigInt(value) : BigInt(value);
  if (numeric < 0n || numeric > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`${fieldName} must fit in u64, got: ${value}`);
  }

  const bytes = new Uint8Array(8);
  let remaining = numeric;
  for (let index = 7; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function encodeU256Be(value: number | bigint | string, fieldName: string): Uint8Array {
  const numeric = typeof value === "string" ? BigInt(value) : BigInt(value);
  if (numeric < 0n || numeric > ((1n << 256n) - 1n)) {
    throw new RangeError(`${fieldName} must fit in u256, got: ${value}`);
  }

  const bytes = new Uint8Array(32);
  let remaining = numeric;
  for (let index = 31; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  return combined;
}

function toRlpAccessList(
  accessList?: ShellTransactionRequest["access_list"] | null,
): Array<[HexString, HexString[]]> {
  if (!accessList || accessList.length === 0) {
    return [];
  }

  return accessList.map((item) => [
    bytesToHex(shellAddressToBytes(item.address)),
    item.storage_keys.map((key) => key as HexString),
  ]);
}

/**
 * Low-level transaction builder that maps camelCase options to the
 * snake_case wire format expected by the Shell node.
 *
 * Prefer the higher-level helpers ({@link buildTransferTransaction},
 * {@link buildRotateKeyTransaction}, etc.) for common use cases.
 *
 * @param options - Transaction fields; all optional fields fall back to safe defaults.
 * @returns A `ShellTransactionRequest` ready for signing.
 */
export function buildTransaction(options: BuildTransactionOptions): ShellTransactionRequest {
  // Validate inputs
  validateNonNegativeInteger(options.chainId, "chainId");
  validateNonNegativeInteger(options.nonce, "nonce");
  validateAddress(options.to, "to");
  if (options.value !== undefined) {
    validateNonNegativeBigInt(options.value, "value");
  }
  if (options.gasLimit !== undefined) {
    validateNonNegativeInteger(options.gasLimit, "gasLimit");
  }
  if (options.maxFeePerGas !== undefined) {
    validateNonNegativeInteger(options.maxFeePerGas, "maxFeePerGas");
  }
  if (options.maxPriorityFeePerGas !== undefined) {
    validateNonNegativeInteger(options.maxPriorityFeePerGas, "maxPriorityFeePerGas");
  }
  if (options.txType !== undefined) {
    validateNonNegativeInteger(options.txType, "txType");
  }
  if (options.maxFeePerBlobGas !== undefined && options.maxFeePerBlobGas !== null) {
    validateNonNegativeInteger(options.maxFeePerBlobGas, "maxFeePerBlobGas");
  }

  return {
    chain_id: options.chainId,
    nonce: options.nonce,
    to: options.to,
    value: `0x${(options.value ?? 0n).toString(16)}`,
    data: toHexData(options.data),
    gas_limit: options.gasLimit ?? DEFAULT_TRANSFER_GAS_LIMIT,
    max_fee_per_gas: options.maxFeePerGas ?? DEFAULT_MAX_FEE_PER_GAS,
    max_priority_fee_per_gas:
      options.maxPriorityFeePerGas ?? DEFAULT_MAX_PRIORITY_FEE_PER_GAS,
    access_list: options.accessList ?? null,
    tx_type: options.txType ?? DEFAULT_TX_TYPE,
    max_fee_per_blob_gas: options.maxFeePerBlobGas ?? null,
    blob_versioned_hashes: options.blobVersionedHashes ?? null,
  };
}

/**
 * Build a SHELL token transfer transaction (type-2 EIP-1559).
 *
 * Sets `data` to `"0x"` and applies the transfer gas limit default.
 *
 * @param options - Transfer options. `to` is required; `value` defaults to `0n`.
 * @returns A `ShellTransactionRequest` for a plain token transfer.
 *
 * @example
 * ```typescript
 * import { parseEther } from "viem";
 *
 * const tx = buildTransferTransaction({
 *   chainId: 424242,
 *   nonce: 0,
 *   to: "0xrecipient…",
 *   value: parseEther("1.5"),
 * });
 * ```
 */
export function buildTransferTransaction(options: Omit<BuildTransactionOptions, "data" | "to"> & {
  to: AddressLike;
}): ShellTransactionRequest {
  return buildTransaction({
    ...options,
    data: "0x",
    gasLimit: options.gasLimit ?? DEFAULT_TRANSFER_GAS_LIMIT,
  });
}

/**
 * Build a transaction directed at the AccountManager system contract.
 *
 * Sets `to` to {@link accountManagerAddress}, `value` to `0n`, and applies
 * the system gas limit default. Used internally by the higher-level system
 * transaction builders.
 *
 * @param options - Must include `data` (ABI-encoded calldata); `to` and `value` are fixed.
 * @returns A `ShellTransactionRequest` targeting the AccountManager.
 */
export function buildSystemTransaction(
  options: Omit<BuildTransactionOptions, "to" | "value"> & { data: HexString },
): ShellTransactionRequest {
  return buildTransaction({
    ...options,
    to: accountManagerAddress,
    value: 0n,
    gasLimit: options.gasLimit ?? DEFAULT_SYSTEM_GAS_LIMIT,
  });
}

/**
 * Build a `rotateKey` transaction that replaces the signing key for the
 * sender's account.
 *
 * After this transaction is confirmed, the account can only be controlled
 * by the new private key.
 *
 * @param options.chainId - EIP-155 chain ID.
 * @param options.nonce - Sender nonce.
 * @param options.publicKey - New public key bytes.
 * @param options.algorithmId - Numeric algorithm ID for the new key (0/1/2).
 * @param options.gasLimit - Override the default system gas limit.
 * @returns A `ShellTransactionRequest` that calls `rotateKey(bytes,uint8)` on AccountManager.
 *
 * @example
 * ```typescript
 * const tx = buildRotateKeyTransaction({
 *   chainId: 424242,
 *   nonce: 5,
 *   publicKey: newAdapter.getPublicKey(),
 *   algorithmId: 1, // MlDsa65
 * });
 * ```
 */
export function buildRotateKeyTransaction(options: {
  chainId: number;
  nonce: number;
  publicKey: Uint8Array;
  algorithmId: number;
  gasLimit?: number;
}): ShellTransactionRequest {
  return buildSystemTransaction({
    chainId: options.chainId,
    nonce: options.nonce,
    data: encodeRotateKeyCalldata(options.publicKey, options.algorithmId),
    gasLimit: options.gasLimit ?? DEFAULT_SYSTEM_GAS_LIMIT,
  });
}

/**
 * Build a `setValidationCode` transaction that attaches a custom EVM
 * validation contract to the sender's account (smart account / AA).
 *
 * @param options.chainId - EIP-155 chain ID.
 * @param options.nonce - Sender nonce.
 * @param options.codeHash - `bytes32` hash of the validation contract.
 * @param options.gasLimit - Override the default system gas limit.
 * @returns A `ShellTransactionRequest` that calls `setValidationCode(bytes32)`.
 */
export function buildSetValidationCodeTransaction(options: {
  chainId: number;
  nonce: number;
  codeHash: HexString;
  gasLimit?: number;
}): ShellTransactionRequest {
  return buildSystemTransaction({
    chainId: options.chainId,
    nonce: options.nonce,
    data: encodeSetValidationCodeCalldata(options.codeHash),
    gasLimit: options.gasLimit ?? DEFAULT_SYSTEM_GAS_LIMIT,
  });
}

/**
 * Build a `clearValidationCode` transaction that removes the custom
 * validation contract and reverts the account to default PQ key validation.
 *
 * @param options.chainId - EIP-155 chain ID.
 * @param options.nonce - Sender nonce.
 * @param options.gasLimit - Override the default system gas limit.
 * @returns A `ShellTransactionRequest` that calls `clearValidationCode()`.
 */
export function buildClearValidationCodeTransaction(options: {
  chainId: number;
  nonce: number;
  gasLimit?: number;
}): ShellTransactionRequest {
  return buildSystemTransaction({
    chainId: options.chainId,
    nonce: options.nonce,
    data: encodeClearValidationCodeCalldata(),
    gasLimit: options.gasLimit ?? DEFAULT_SYSTEM_GAS_LIMIT,
  });
}

/**
 * Build a {@link ShellSignature} object from raw signature bytes.
 *
 * @param signatureType - The algorithm that produced the signature.
 * @param signature - Raw signature bytes (Uint8Array or number[]).
 * @returns A `ShellSignature` with `sig_type` and `data`.
 */
export function buildSignature(
  signatureType: SignatureTypeName,
  signature: Uint8Array | number[],
): ShellSignature {
  return {
    sig_type: signatureType,
    data: toByteArray(signature),
  };
}

/**
 * Assemble a {@link SignedShellTransaction} from individual components.
 *
 * In practice, use {@link ShellSigner.buildSignedTransaction} which handles
 * signing and assembly in one step.
 *
 * @param options - Sender address, unsigned tx, raw signature bytes, and algorithm name.
 * @returns A complete `SignedShellTransaction` ready to broadcast.
 */
export function buildSignedTransaction(
  options: BuildSignedTransactionOptions,
): SignedShellTransaction {
  return {
    from: options.from,
    tx: options.tx,
    signature: buildSignature(options.signatureType, options.signature),
    sender_pubkey: options.senderPubkey ? toByteArray(options.senderPubkey) : null,
    aa_bundle: options.aaBundle ?? options.aaBbundle ?? null,
  };
}

/**
 * Encode a `Uint8Array` as a `0x`-prefixed hex string.
 *
 * @param bytes - Bytes to encode.
 * @returns A `HexString`.
 */
export function hexBytes(bytes: Uint8Array): HexString {
  return bytesToHex(bytes);
}

/**
 * Compute the canonical Shell transaction signing hash.
 *
 * Shell-chain v0.23.0 signs `blake3` over the structured preimage from
 * `shell-chain/crates/core/src/transaction.rs::Transaction::signing_hash`:
 *
 * `PQTX_SIGNING_V1\0(16B) || chain_id(8B BE) || nonce(8B BE) || to(32B|zero) || value(32B BE) || data ||`
 * `gas_limit(8B BE) || max_fee_per_gas(8B BE) || max_priority_fee_per_gas(8B BE) ||`
 * `sig_type(1B) || tx_type(1B)`
 *
 * Blob transactions (`tx_type === 3`) append
 * `max_fee_per_blob_gas(8B BE) || blob_hash_0(32B) || ...`.
 *
 * `access_list` is intentionally excluded because the chain's signing preimage
 * does not include it.
 *
 * @param tx - The unsigned transaction to hash.
 * @param signatureType - Signature algorithm name or numeric id. Defaults to Dilithium3 (`0`).
 * @returns 32-byte BLAKE3 signing hash as a `Uint8Array`.
 */

/** Domain separator prepended to every transaction signing preimage (matches node constant). */
const PQTX_SIGNING_DOMAIN = new Uint8Array([
  0x50, 0x51, 0x54, 0x58, 0x5f, 0x53, 0x49, 0x47,
  0x4e, 0x49, 0x4e, 0x47, 0x5f, 0x56, 0x31, 0x00,
]); // b"PQTX_SIGNING_V1\0"

export function hashTransaction(
  tx: ShellTransactionRequest,
  signatureType: SignatureTypeName | number = "Dilithium3",
): Uint8Array {
  const txType = tx.tx_type ?? DEFAULT_TX_TYPE;
  const preimageParts = [
    PQTX_SIGNING_DOMAIN,
    encodeU64Be(tx.chain_id, "chain_id"),
    encodeU64Be(tx.nonce, "nonce"),
    tx.to ? shellAddressToBytes(tx.to) : new Uint8Array(32),
    encodeU256Be(tx.value, "value"),
    hexToBytes(tx.data),
    encodeU64Be(tx.gas_limit, "gas_limit"),
    encodeU64Be(tx.max_fee_per_gas, "max_fee_per_gas"),
    encodeU64Be(tx.max_priority_fee_per_gas, "max_priority_fee_per_gas"),
    new Uint8Array([signatureTypeToId(signatureType)]),
    new Uint8Array([txType]),
  ];

  if (txType === 3) {
    preimageParts.push(
      encodeU64Be(tx.max_fee_per_blob_gas ?? 0, "max_fee_per_blob_gas"),
      ...((tx.blob_versioned_hashes ?? []).map((hash, index) => {
        const bytes = hexToBytes(hash);
        if (bytes.length !== 32) {
          throw new RangeError(`blob_versioned_hashes[${index}] must be 32 bytes, got ${bytes.length}`);
        }
        return bytes;
      })),
    );
  }

  return blake3(concatBytes(...preimageParts));
}

// ---------------------------------------------------------------------------
// AA batch & sponsored transaction builders (v0.18.0)
// ---------------------------------------------------------------------------

/**
 * Options for {@link buildBatchTransaction}.
 */
export interface BuildBatchTransactionOptions {
  /** EIP-155 chain ID. */
  chainId: number;
  /** Sender account nonce. */
  nonce: number;
  /** Inner calls to include in the batch. Max {@link AA_MAX_INNER_CALLS}. */
  innerCalls: AaInnerCall[];
  /**
   * Total gas budget for the outer transaction.
   * Should be ≥ sum(innerCalls[i].gas_limit) + 21 000 + overhead.
   * Defaults to `200_000`.
   */
  gasLimit?: number;
  /** EIP-1559 max fee per gas. Defaults to {@link DEFAULT_MAX_FEE_PER_GAS}. */
  maxFeePerGas?: number;
  /** EIP-1559 priority fee. Defaults to {@link DEFAULT_MAX_PRIORITY_FEE_PER_GAS}. */
  maxPriorityFeePerGas?: number;
}

/**
 * Options for {@link buildSponsoredTransaction}.
 *
 * Extends {@link BuildBatchTransactionOptions} with paymaster fields.
 */
export interface BuildSponsoredTransactionOptions extends BuildBatchTransactionOptions {
  /** Paymaster address that will pay the gas cost. */
  paymaster: AddressLike;
  /**
   * Paymaster's PQ signature over the `paymaster_signing_hash`.
   * Obtain this from the paymaster service before building the transaction.
   */
  paymasterSignature: Uint8Array | number[];
}

/** Default outer gas budget for AA batch transactions. */
export const DEFAULT_AA_GAS_LIMIT = 200_000;

/**
 * Build a native AA batch transaction (`tx_type = 0x7E`).
 *
 * The resulting `SignedShellTransaction` will have `aa_bundle` set.
 * The caller is responsible for signing the `batch_signing_hash` (use
 * {@link hashBatchTransaction}) rather than the plain `tx.hash()`.
 *
 * @param options - Batch transaction options including inner calls.
 * @returns `{ tx: ShellTransactionRequest; aa_bundle: AaBundle }` — an unsigned transaction
 *   skeleton plus bundle. Pass `txHash: hashBatchTransaction(tx, aa_bundle)` and `aa_bundle`
 *   into `signer.buildSignedTransaction(...)` to produce the final signed transaction.
 *
 * @example
 * ```typescript
 * import { buildBatchTransaction, hashBatchTransaction } from "shell-sdk/transactions";
 *
 * const { tx, aa_bundle } = buildBatchTransaction({
 *   chainId: 424242,
 *   nonce: 0,
 *   innerCalls: [{ to: "0xrecipient…", value: "0x3e8", data: "0x", gas_limit: "0x5208" }],
 * });
 * const signingHash = hashBatchTransaction(tx, aa_bundle);
 * const signed = await signer.buildSignedTransaction({ tx, txHash: signingHash, aaBundle: aa_bundle });
 * ```
 */
export function buildBatchTransaction(options: BuildBatchTransactionOptions): {
  tx: ShellTransactionRequest;
  aa_bundle: AaBundle;
} {
  if (options.innerCalls.length === 0) {
    throw new Error("buildBatchTransaction: innerCalls must not be empty");
  }
  if (options.innerCalls.length > AA_MAX_INNER_CALLS) {
    throw new Error(
      `buildBatchTransaction: innerCalls length ${options.innerCalls.length} exceeds AA_MAX_INNER_CALLS (${AA_MAX_INNER_CALLS})`,
    );
  }

  const tx = buildTransaction({
    chainId: options.chainId,
    nonce: options.nonce,
    to: null,
    value: 0n,
    data: "0x",
    gasLimit: options.gasLimit ?? DEFAULT_AA_GAS_LIMIT,
    maxFeePerGas: options.maxFeePerGas ?? DEFAULT_MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: options.maxPriorityFeePerGas ?? DEFAULT_MAX_PRIORITY_FEE_PER_GAS,
    txType: AA_BUNDLE_TX_TYPE,
  });

  const aa_bundle: AaBundle = {
    inner_calls: options.innerCalls,
    paymaster: null,
    paymaster_signature: null,
  };

  return { tx, aa_bundle };
}

/**
 * Build a sponsored AA batch transaction (`tx_type = 0x7E`) with a paymaster.
 *
 * Identical to {@link buildBatchTransaction} but also sets `paymaster` and
 * `paymaster_signature` in the bundle.
 *
 * @param options - Sponsored transaction options including paymaster address and signature.
 * @returns An unsigned `SignedShellTransaction` skeleton plus the bundle.
 *
 * @example
 * ```typescript
 * const { tx, aa_bundle } = buildSponsoredTransaction({
 *   chainId: 424242,
 *   nonce: 0,
 *   innerCalls: [...],
 *   paymaster: "0xpaymaster…",
 *   paymasterSignature: pmSigBytes,
 * });
 * const signingHash = hashBatchTransaction(tx, aa_bundle);
 * const signed = await signer.buildSignedTransaction({ tx, txHash: signingHash, aaBundle: aa_bundle });
 * ```
 */
export function buildSponsoredTransaction(options: BuildSponsoredTransactionOptions): {
  tx: ShellTransactionRequest;
  aa_bundle: AaBundle;
} {
  const { tx, aa_bundle } = buildBatchTransaction(options);
  aa_bundle.paymaster = options.paymaster;
  aa_bundle.paymaster_signature = Array.from(options.paymasterSignature);
  return { tx, aa_bundle };
}

/**
 * Compute the sender's canonical AA bundle signing hash.
 *
 * Matches `shell-chain/crates/core/src/transaction.rs::SignedTransaction::batch_signing_hash`:
 * `blake3( PQTX_BUNDLE_V1\0\0(16B) || tx_signing_hash || rlp(aa_bundle_for_signing) )`.
 *
 * The signing-form bundle omits `paymaster_signature`, `session_auth.root_signature`,
 * and `session_auth.session_signature`, but still commits to `paymaster_context`.
 *
 * @param tx - The outer unsigned transaction (must have `tx_type = 0x7E`).
 * @param bundle - The AA bundle that will be attached.
 * @param signatureType - Signature algorithm name or numeric id. Defaults to Dilithium3 (`0`).
 * @returns 32-byte BLAKE3 batch signing hash as a `Uint8Array`.
 */
export function hashBatchTransaction(
  tx: ShellTransactionRequest,
  bundle: AaBundle,
  signatureType: SignatureTypeName | number = "Dilithium3",
): Uint8Array {
  if (tx.tx_type !== AA_BUNDLE_TX_TYPE) {
    throw new Error(
      `hashBatchTransaction: tx.tx_type must be AA_BUNDLE_TX_TYPE (0x7E), got ${tx.tx_type}`,
    );
  }

  const innerCallsRlp = bundle.inner_calls.map((call) => [
    call.to ? bytesToHex(shellAddressToBytes(call.to)) : "0x",
    toRlpUint(call.value),
    call.data,
    toRlpUint(call.gas_limit),
  ]);
  const paymasterField = bundle.paymaster
    ? (bytesToHex(shellAddressToBytes(bundle.paymaster)) as HexString)
    : ("0x" as HexString);
  const paymasterContextField: HexString =
    bundle.paymaster_context && bundle.paymaster_context.length > 0
      ? (bytesToHex(new Uint8Array(bundle.paymaster_context)) as HexString)
      : ("0x" as HexString);
  const bundleSigningFields = [innerCallsRlp, paymasterField, paymasterContextField] as const;

  return blake3(
    concatBytes(
      BATCH_SIGNING_HASH_DOMAIN,
      hashTransaction(tx, signatureType),
      hexToBytes(toRlp(bundleSigningFields)),
    ),
  );
}

/**
 * Compute the paymaster authorization hash for a sponsored AA bundle.
 *
 * Matches `shell-chain/crates/core/src/transaction.rs::SignedTransaction::paymaster_signing_hash`:
 * `blake3( PQTX_PAYMASTER_V(16B) || from || batch_signing_hash )`.
 *
 * @param from - Sender address bound into the paymaster authorization.
 * @param tx - The outer unsigned AA transaction.
 * @param bundle - AA bundle containing a paymaster address.
 * @param signatureType - Signature algorithm name or numeric id. Defaults to Dilithium3 (`0`).
 * @returns 32-byte BLAKE3 paymaster hash as a `Uint8Array`.
 */
export function hashPaymasterTransaction(
  from: AddressLike,
  tx: ShellTransactionRequest,
  bundle: AaBundle,
  signatureType: SignatureTypeName | number = "Dilithium3",
): Uint8Array {
  if (!bundle.paymaster) {
    throw new Error("hashPaymasterTransaction: bundle.paymaster must be set");
  }

  return blake3(
    concatBytes(
      PAYMASTER_SIGNING_HASH_DOMAIN,
      shellAddressToBytes(from),
      hashBatchTransaction(tx, bundle, signatureType),
    ),
  );
}

/**
 * Validate and encode a gas limit as a JSON-RPC hex quantity.
 * Throws if `gasLimit` is not a non-negative safe integer.
 */
function toHexGasLimit(gasLimit: number): HexQuantity {
  if (!Number.isSafeInteger(gasLimit) || gasLimit < 0) {
    throw new RangeError(
      `gasLimit must be a non-negative safe integer, got: ${gasLimit}`,
    );
  }
  return ("0x" + gasLimit.toString(16)) as HexQuantity;
}

/**
 * Convenience helper: build a minimal `AaInnerCall` for a SHELL token transfer.
 *
 * @param to - Recipient address.
 * @param value - Amount in wei to send.
 * @param gasLimit - Gas limit for this inner call. Defaults to `21_000`.
 * @returns An `AaInnerCall` ready for use in {@link buildBatchTransaction}.
 */
export function buildInnerTransfer(
  to: AddressLike,
  value: bigint,
  gasLimit = 21_000,
): AaInnerCall {
  return { to, value: ("0x" + value.toString(16)) as HexString, data: "0x", gas_limit: toHexGasLimit(gasLimit) };
}

/**
 * Convenience helper: build a contract-call `AaInnerCall`.
 *
 * @param to - Target contract address.
 * @param data - ABI-encoded calldata.
 * @param gasLimit - Gas limit for this inner call.
 * @param value - Optional ETH value. Defaults to `0n`.
 * @returns An `AaInnerCall` ready for use in {@link buildBatchTransaction}.
 */
export function buildInnerCall(
  to: AddressLike,
  data: HexString,
  gasLimit: number,
  value = 0n,
): AaInnerCall {
  return { to, value: ("0x" + value.toString(16)) as HexString, data, gas_limit: toHexGasLimit(gasLimit) };
}

// ---------------------------------------------------------------------------
// AA Phase 2 helpers (v0.19.0-dev)
// ---------------------------------------------------------------------------

/**
 * Options for {@link buildContractPaymasterTransaction}.
 *
 * Extends {@link BuildBatchTransactionOptions} with contract paymaster fields.
 */
export interface BuildContractPaymasterTransactionOptions extends BuildBatchTransactionOptions {
  /** Contract paymaster address. */
  paymaster: AddressLike;
  /**
   * Opaque context bytes forwarded to `IPaymaster.validatePaymasterOp`.
   * Max 256 bytes.
   */
  paymasterContext: Uint8Array | number[];
}

/**
 * Build an AA batch transaction using a **contract paymaster** (Phase 2).
 *
 * Unlike {@link buildSponsoredTransaction} (off-chain paymaster), a contract
 * paymaster implements `IPaymaster.validatePaymasterOp` on-chain and receives
 * `paymasterContext` as input. The bundle must NOT include `paymaster_signature`.
 *
 * @param options - Options including contract paymaster address and context bytes.
 * @returns `{ tx, aa_bundle }` — an unsigned transaction skeleton plus bundle.
 *
 * @example
 * ```typescript
 * const { tx, aa_bundle } = buildContractPaymasterTransaction({
 *   chainId: 424242,
 *   nonce: 0,
 *   innerCalls: [...],
 *   paymaster: contractPaymasterAddress,
 *   paymasterContext: contextBytes,
 * });
 * const signingHash = hashBatchTransaction(tx, aa_bundle);
 * const signed = await signer.buildSignedTransaction({ tx, txHash: signingHash, aaBundle: aa_bundle });
 * ```
 */
export function buildContractPaymasterTransaction(
  options: BuildContractPaymasterTransactionOptions,
): {
  tx: ShellTransactionRequest;
  aa_bundle: AaBundle;
} {
  const { tx, aa_bundle } = buildBatchTransaction(options);
  aa_bundle.paymaster = options.paymaster;
  aa_bundle.paymaster_context = Array.from(options.paymasterContext);
  return { tx, aa_bundle };
}

/**
 * Options for {@link buildSessionKeyTransaction}.
 *
 * Extends {@link BuildBatchTransactionOptions} with session key authorization.
 */
export interface BuildSessionKeyTransactionOptions extends BuildBatchTransactionOptions {
  /** Pre-built session key authorization. */
  sessionAuth: SessionAuth;
}

/**
 * Build an AA batch transaction authorized by a **session key** (Phase 2).
 *
 * The session key must have been authorized by the root account via a
 * `root_signature` over its `auth_hash`. The transaction is then signed
 * by the session key via `session_signature`.
 *
 * @param options - Options including the session key authorization struct.
 * @returns `{ tx, aa_bundle }` — an unsigned transaction skeleton plus bundle.
 *
 * @example
 * ```typescript
 * const { tx, aa_bundle } = buildSessionKeyTransaction({
 *   chainId: 424242,
 *   nonce: 0,
 *   innerCalls: [...],
 *   sessionAuth: {
 *     session_pubkey: Array.from(sessionPubkeyBytes),
 *     session_algo: 0,
 *     target: null,
 *     value_cap: "0xde0b6b3a7640000",
 *     expiry_block: 500,
 *     root_signature: Array.from(rootSigBytes),
 *     session_signature: Array.from(sessionSigBytes),
 *   },
 * });
 * const signingHash = hashBatchTransaction(tx, aa_bundle);
 * ```
 */
export function buildSessionKeyTransaction(options: BuildSessionKeyTransactionOptions): {
  tx: ShellTransactionRequest;
  aa_bundle: AaBundle;
} {
  const { tx, aa_bundle } = buildBatchTransaction(options);
  aa_bundle.session_auth = options.sessionAuth;
  return { tx, aa_bundle };
}
