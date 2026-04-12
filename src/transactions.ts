/**
 * Transaction builders for Shell Chain.
 *
 * Provides typed helpers for constructing `ShellTransactionRequest` objects
 * for common operations: token transfers, system contract calls, key rotation,
 * and custom validation code management.
 *
 * @module transactions
 */
import { bytesToHex, keccak256, toRlp, numberToHex, hexToBytes } from "viem";

import type {
  AddressLike,
  HexString,
  ShellSignature,
  ShellTransactionRequest,
  SignedShellTransaction,
  SignatureTypeName,
} from "./types.js";
import {
  accountManagerAddress,
  encodeClearValidationCodeCalldata,
  encodeRotateKeyCalldata,
  encodeSetValidationCodeCalldata,
} from "./system-contracts.js";

/** Default transaction type: `2` (EIP-1559). */
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
  /** EIP-155 chain ID. Devnet = 424242. */
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
  /** EIP-1559 max fee per gas in wei. Defaults to {@link DEFAULT_MAX_FEE_PER_GAS}. */
  maxFeePerGas?: number;
  /** EIP-1559 priority fee in wei. Defaults to {@link DEFAULT_MAX_PRIORITY_FEE_PER_GAS}. */
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
  /** Sender address (pq1… bech32m form). */
  from: AddressLike;
  /** The unsigned transaction payload. */
  tx: ShellTransactionRequest;
  /** Raw signature bytes. */
  signature: Uint8Array | number[];
  /** Algorithm that produced the signature. */
  signatureType: SignatureTypeName;
  /** Optional public key bytes to embed as `sender_pubkey`. */
  senderPubkey?: Uint8Array | number[];
}

function toByteArray(bytes: Uint8Array | number[]): number[] {
  return Array.from(bytes);
}

function toHexData(data?: HexString): HexString {
  return data ?? "0x";
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
 *   to: "pq1recipient…",
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
 * RLP-encode a `ShellTransactionRequest` and return its keccak256 hash.
 *
 * This is the signing hash that must be passed to `ShellSigner.buildSignedTransaction`
 * (or `signer.sign`). Shell Chain computes it identically on the node side as
 * `keccak256(RLP(tx))` — the same scheme as Ethereum EIP-1559 signing.
 *
 * **Encoding order** (EIP-2718 type-2 fields):
 * chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit,
 * to, value, data, accessList, maxFeePerBlobGas (if present), blobVersionedHashes (if present)
 *
 * @example
 * ```typescript
 * import { buildTransferTransaction, hashTransaction } from "shell-sdk/transactions";
 *
 * const tx     = buildTransferTransaction({ chainId: 424242, nonce: 0, to: "pq1…", value: 1n });
 * const txHash = hashTransaction(tx);
 * const signed = await signer.buildSignedTransaction({ tx, txHash });
 * ```
 *
 * @param tx - The unsigned transaction to hash.
 * @returns 32-byte keccak256 hash as a `Uint8Array`.
 */
export function hashTransaction(tx: ShellTransactionRequest): Uint8Array {
  const to = tx.to ? hexToBytes(tx.to.startsWith("0x") ? (tx.to as `0x${string}`) : `0x${tx.to}`) : new Uint8Array(0);
  const data = hexToBytes(tx.data as `0x${string}`);
  const value = hexToBytes(tx.value as `0x${string}`);

  const fields: `0x${string}`[] = [
    numberToHex(tx.chain_id),
    numberToHex(tx.nonce),
    numberToHex(tx.max_priority_fee_per_gas),
    numberToHex(tx.max_fee_per_gas),
    numberToHex(tx.gas_limit),
    bytesToHex(to),
    bytesToHex(value),
    bytesToHex(data),
    "0x",  // empty access list
  ];

  if (tx.max_fee_per_blob_gas != null) {
    fields.push(numberToHex(tx.max_fee_per_blob_gas));
    fields.push("0x");  // empty blob versioned hashes
  }

  const rlpEncoded = toRlp(fields);
  const hash = hexToBytes(keccak256(rlpEncoded));
  return hash;
}

