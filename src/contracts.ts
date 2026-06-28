/**
 * Smart contract helpers for Shell Chain.
 *
 * These helpers wrap Shell-native transaction signing/broadcast with viem ABI
 * encoding so dApps can compile elsewhere, then deploy/read/write contracts
 * without duplicating Shell transaction plumbing.
 *
 * @module contracts
 */
import {
  decodeFunctionResult as viemDecodeFunctionResult,
  encodeDeployData,
  encodeFunctionData as viemEncodeFunctionData,
  type Abi,
  type Hex,
} from "viem";

import { isShellAddress } from "./address.js";
import { buildTransaction, type BuildTransactionOptions } from "./transactions.js";
import type { ShellProvider } from "./provider.js";
import type { ShellSigner } from "./signer.js";
import type {
  AddressLike,
  HexString,
  ShellRpcReceipt,
  ShellTransactionRequest,
} from "./types.js";
import { validateAddress, validateNonNegativeInteger } from "./validation.js";

export interface ShellContractArtifact {
  contractName: string;
  sourcePath?: string;
  abi: Abi;
  bytecode: HexString;
  deployedBytecode?: HexString;
  solcVersion?: string;
  metadata?: unknown;
}

export interface WaitForTransactionReceiptOptions {
  provider: ShellProvider;
  hash: HexString;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface BuildDeployTransactionOptions {
  artifact: ShellContractArtifact;
  chainId: number;
  nonce: number;
  constructorArgs?: readonly unknown[];
  gasLimit?: number;
  value?: bigint;
  maxFeePerGas?: number;
  maxPriorityFeePerGas?: number;
  txType?: number;
  accessList?: BuildTransactionOptions["accessList"];
}

export interface DeployContractOptions extends Omit<BuildDeployTransactionOptions, "nonce"> {
  provider: ShellProvider;
  signer: ShellSigner;
  nonce?: number;
  includePublicKey?: boolean;
  wait?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface DeployContractResult {
  hash: HexString;
  nonce: number;
  receipt?: ShellRpcReceipt;
  contractAddress?: AddressLike;
}

export interface BuildContractCallTransactionOptions {
  chainId: number;
  nonce: number;
  address: AddressLike;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  gasLimit?: number;
  value?: bigint;
  maxFeePerGas?: number;
  maxPriorityFeePerGas?: number;
  txType?: number;
  accessList?: BuildTransactionOptions["accessList"];
}

export interface ContractWriteOptions extends Omit<BuildContractCallTransactionOptions, "nonce"> {
  provider: ShellProvider;
  signer: ShellSigner;
  nonce?: number;
  includePublicKey?: boolean;
  wait?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ContractWriteResult {
  hash: HexString;
  nonce: number;
  receipt?: ShellRpcReceipt;
}

export interface ContractReadOptions {
  provider: ShellProvider;
  address: AddressLike;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  blockTag?: string;
}

export interface EncodeContractFunctionDataOptions {
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export interface DecodeContractFunctionResultOptions {
  abi: Abi;
  functionName: string;
  data: HexString;
}

interface JsonRpcSuccess<T> {
  result: T;
  error?: undefined;
}

interface JsonRpcFailure {
  result?: undefined;
  error: {
    code: number;
    message: string;
  };
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

function normalizeHexData(value: string, fieldName: string): HexString {
  if (!/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new Error(`${fieldName} must be 0x-prefixed hex data`);
  }
  return value as HexString;
}

function normalizeAbi(abi: Abi): Abi {
  if (!Array.isArray(abi)) {
    throw new Error("contract ABI must be an array");
  }
  return abi;
}

function normalizeArtifact(artifact: ShellContractArtifact): ShellContractArtifact {
  normalizeAbi(artifact.abi);
  return {
    ...artifact,
    bytecode: normalizeHexData(artifact.bytecode, "artifact.bytecode"),
    deployedBytecode: artifact.deployedBytecode
      ? normalizeHexData(artifact.deployedBytecode, "artifact.deployedBytecode")
      : undefined,
  };
}

async function rpcRequest<T>(provider: ShellProvider, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(provider.rpcHttpUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  if (!response.ok) {
    throw new Error(`rpc request failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as JsonRpcResponse<T>;
  if ("error" in body && body.error) {
    throw new Error(`[${body.error.code}] ${body.error.message}`);
  }
  return body.result;
}

async function getPendingNonce(provider: ShellProvider, address: AddressLike): Promise<number> {
  const nonceHex = await rpcRequest<HexString>(provider, "eth_getTransactionCount", [address, "pending"]);
  const nonce = Number(BigInt(nonceHex));
  validateNonNegativeInteger(nonce, "nonce");
  return nonce;
}

export function encodeFunctionData(parameters: EncodeContractFunctionDataOptions): HexString {
  return normalizeHexData(viemEncodeFunctionData(parameters as never), "encoded function data");
}

export function decodeFunctionResult(parameters: DecodeContractFunctionResultOptions): unknown {
  return viemDecodeFunctionResult(parameters as never);
}

export function buildDeployTransaction(options: BuildDeployTransactionOptions): ShellTransactionRequest {
  const artifact = normalizeArtifact(options.artifact);
  const data = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode as Hex,
    args: options.constructorArgs ?? [],
  } as never);

  return buildTransaction({
    chainId: options.chainId,
    nonce: options.nonce,
    to: null,
    value: options.value,
    data: normalizeHexData(data, "deploy data"),
    gasLimit: options.gasLimit,
    maxFeePerGas: options.maxFeePerGas,
    maxPriorityFeePerGas: options.maxPriorityFeePerGas,
    txType: options.txType,
    accessList: options.accessList,
  });
}

export function buildContractCallTransaction(
  options: BuildContractCallTransactionOptions,
): ShellTransactionRequest {
  validateAddress(options.address, "address");
  const data = encodeFunctionData({
    abi: options.abi,
    functionName: options.functionName,
    args: options.args ?? [],
  } as never);

  return buildTransaction({
    chainId: options.chainId,
    nonce: options.nonce,
    to: options.address,
    value: options.value,
    data,
    gasLimit: options.gasLimit,
    maxFeePerGas: options.maxFeePerGas,
    maxPriorityFeePerGas: options.maxPriorityFeePerGas,
    txType: options.txType,
    accessList: options.accessList,
  });
}

export async function waitForTransactionReceipt(
  options: WaitForTransactionReceiptOptions,
): Promise<ShellRpcReceipt> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  validateNonNegativeInteger(timeoutMs, "timeoutMs");
  validateNonNegativeInteger(pollIntervalMs, "pollIntervalMs");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const receipt = await rpcRequest<ShellRpcReceipt | null>(
      options.provider,
      "eth_getTransactionReceipt",
      [options.hash],
    );
    if (receipt) {
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`timeout waiting for transaction receipt: ${options.hash}`);
}

export async function deployContract(options: DeployContractOptions): Promise<DeployContractResult> {
  const nonce = options.nonce ?? await getPendingNonce(options.provider, options.signer.getAddress());
  const tx = buildDeployTransaction({ ...options, nonce });
  const signed = await options.signer.buildSignedTransaction({
    tx,
    includePublicKey: options.includePublicKey ?? nonce === 0,
  });
  const hash = normalizeHexData(await options.provider.sendTransaction(signed), "transaction hash");

  if (!options.wait) {
    return { hash, nonce };
  }

  const receipt = await waitForTransactionReceipt({
    provider: options.provider,
    hash,
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
  });
  if (receipt.status !== "0x1") {
    throw new Error(`contract deploy reverted: ${hash}`);
  }
  if (!receipt.contractAddress || !isShellAddress(receipt.contractAddress)) {
    throw new Error(`missing or invalid Shell contract address for deploy tx: ${hash}`);
  }

  return { hash, nonce, receipt, contractAddress: receipt.contractAddress };
}

export async function writeContract(options: ContractWriteOptions): Promise<ContractWriteResult> {
  const nonce = options.nonce ?? await getPendingNonce(options.provider, options.signer.getAddress());
  const tx = buildContractCallTransaction({ ...options, nonce });
  const signed = await options.signer.buildSignedTransaction({
    tx,
    includePublicKey: options.includePublicKey ?? nonce === 0,
  });
  const hash = normalizeHexData(await options.provider.sendTransaction(signed), "transaction hash");

  if (!options.wait) {
    return { hash, nonce };
  }

  const receipt = await waitForTransactionReceipt({
    provider: options.provider,
    hash,
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
  });
  if (receipt.status !== "0x1") {
    throw new Error(`contract write reverted: ${hash}`);
  }

  return { hash, nonce, receipt };
}

export async function readContract(options: ContractReadOptions): Promise<unknown> {
  validateAddress(options.address, "address");
  const data = encodeFunctionData({
    abi: options.abi,
    functionName: options.functionName,
    args: options.args ?? [],
  } as never);
  const result = await rpcRequest<HexString>(options.provider, "eth_call", [
    { to: options.address, data },
    options.blockTag ?? "latest",
  ]);
  return decodeFunctionResult({
    abi: options.abi,
    functionName: options.functionName,
    data: result,
  } as never);
}
