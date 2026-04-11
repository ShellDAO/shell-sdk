import { bytesToHex } from "viem";

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

export const DEFAULT_TX_TYPE = 2;
export const DEFAULT_TRANSFER_GAS_LIMIT = 21_000;
export const DEFAULT_SYSTEM_GAS_LIMIT = 100_000;
export const DEFAULT_MAX_FEE_PER_GAS = 1_000_000_000;
export const DEFAULT_MAX_PRIORITY_FEE_PER_GAS = 100_000_000;

export interface BuildTransactionOptions {
  chainId: number;
  nonce: number;
  to: AddressLike | null;
  value?: bigint;
  data?: HexString;
  gasLimit?: number;
  maxFeePerGas?: number;
  maxPriorityFeePerGas?: number;
  txType?: number;
  accessList?: ShellTransactionRequest["access_list"];
  maxFeePerBlobGas?: number | null;
  blobVersionedHashes?: HexString[] | null;
}

export interface BuildSignedTransactionOptions {
  from: AddressLike;
  tx: ShellTransactionRequest;
  signature: Uint8Array | number[];
  signatureType: SignatureTypeName;
  senderPubkey?: Uint8Array | number[];
}

function toByteArray(bytes: Uint8Array | number[]): number[] {
  return Array.from(bytes);
}

function toHexData(data?: HexString): HexString {
  return data ?? "0x";
}

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

export function buildTransferTransaction(options: Omit<BuildTransactionOptions, "data" | "to"> & {
  to: AddressLike;
}): ShellTransactionRequest {
  return buildTransaction({
    ...options,
    data: "0x",
    gasLimit: options.gasLimit ?? DEFAULT_TRANSFER_GAS_LIMIT,
  });
}

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

export function buildSignature(
  signatureType: SignatureTypeName,
  signature: Uint8Array | number[],
): ShellSignature {
  return {
    sig_type: signatureType,
    data: toByteArray(signature),
  };
}

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

export function hexBytes(bytes: Uint8Array): HexString {
  return bytesToHex(bytes);
}
