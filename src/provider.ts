/**
 * Shell Chain RPC provider.
 *
 * Wraps a [viem](https://viem.sh) `PublicClient` for standard `eth_*` methods
 * and adds raw JSON-RPC support for Shell-specific methods (`shell_*`).
 *
 * @example
 * ```typescript
 * import { createShellProvider } from "shell-sdk/provider";
 *
 * const provider = createShellProvider();
 * const block    = await provider.client.getBlockNumber();
 * const hash     = await provider.sendTransaction(signedTx);
 * ```
 *
 * @module provider
 */
import {
  createPublicClient,
  defineChain,
  http,
  webSocket,
  type Chain,
  type PublicClient,
} from "viem";

import type {
  ShellEstimateBatchRequest,
  ShellEstimateBatchResult,
  ShellEstimatePaymasterGasRequest,
  ShellEstimatePaymasterGasResult,
  ShellIsSponsoredResult,
  ShellAddressSummary,
  ShellAddressSummaryOptions,
  ShellBlocksRange,
  ShellBlocksRangeOptions,
  ShellChainSnapshot,
  ShellNodeInfo,
  ShellPaymasterPolicy,
  ShellRpcCapabilities,
  ShellRpcReceipt,
  ShellStorageProfile,
  ShellStorageProfileInfo,
  ShellTxByAddressPage,
  ShellTxByAddressV2Options,
  ShellTxByAddressV2Page,
  ShellTransactionSummaryResult,
  ShellValidatorSnapshot,
  ShellValidatorSnapshotOptions,
  ShellWitnessBundle,
  ShellWitnessRootResult,
  SignedShellTransaction,
} from "./types.js";
import { validateRpcUrl } from "./validation.js";

class RpcRequestError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(`[${code}] ${message}`);
    this.name = "RpcRequestError";
    this.code = code;
  }
}

function isMethodNotFoundError(error: unknown): boolean {
  if (error instanceof RpcRequestError) {
    return error.code === -32601;
  }
  return error instanceof Error && /method not found/i.test(error.message);
}

function isStorageProfileUnavailableError(error: unknown): boolean {
  if (isMethodNotFoundError(error)) {
    return true;
  }
  return error instanceof Error && /storage profile not configured/i.test(error.message);
}

const MAX_VALIDATOR_SNAPSHOT_PROPOSER_WINDOW = 1000;

function validatorSnapshotOptions(options: ShellValidatorSnapshotOptions): {
  proposerWindow: number | null;
} {
  const proposerWindow = options.proposerWindow;
  if (proposerWindow == null) {
    return { proposerWindow: null };
  }
  if (
    !Number.isSafeInteger(proposerWindow) ||
    proposerWindow < 1 ||
    proposerWindow > MAX_VALIDATOR_SNAPSHOT_PROPOSER_WINDOW
  ) {
    throw new Error(
      `proposerWindow must be a safe integer in [1, ${MAX_VALIDATOR_SNAPSHOT_PROPOSER_WINDOW}], got ${proposerWindow}`,
    );
  }
  return { proposerWindow };
}

/**
 * Pre-configured viem chain definition for Shell local dev / testnet.
 *
 * - Chain ID: `1337` (shell-chain default — override via `chain` option for
 *   other deployments)
 * - HTTP RPC: `http://127.0.0.1:8545`
 * - WebSocket RPC: `ws://127.0.0.1:8546`
 * - Native currency: SHELL (18 decimals)
 */
export const shellDevnet = defineChain({
  id: 1337,
  name: "Shell Devnet",
  nativeCurrency: {
    decimals: 18,
    name: "SHELL",
    symbol: "SHELL",
  },
  rpcUrls: {
    default: {
      http: ["http://127.0.0.1:8545"],
      webSocket: ["ws://127.0.0.1:8546"],
    },
  },
});

/** Options accepted by the provider and client factory functions. */
export interface CreateShellPublicClientOptions {
  /** Override the chain config. Defaults to {@link shellDevnet}. */
  chain?: ShellChainConfig;
  /** Override the HTTP RPC URL. Defaults to the chain's first HTTP URL. */
  rpcHttpUrl?: string;
  /** Override the WebSocket RPC URL. Defaults to the chain's first WS URL. */
  rpcWsUrl?: string;
}

/**
 * Chain config accepted by the SDK public factory APIs.
 *
 * This intentionally mirrors the subset of viem's `Chain` shape consumed by
 * the SDK instead of exporting viem's full generic type. Consumers often use a
 * workspace-linked `shell-sdk` package, and leaking the SDK's own viem type
 * instance into `.d.ts` files makes otherwise identical chain objects from the
 * app's viem dependency fail assignment.
 */
export interface ShellChainConfig {
  id: number;
  name: string;
  nativeCurrency: {
    decimals: number;
    name: string;
    symbol: string;
  };
  rpcUrls: {
    default: {
      http: readonly string[];
      webSocket?: readonly string[];
    };
    [key: string]: {
      http: readonly string[];
      webSocket?: readonly string[];
    };
  };
  [key: string]: unknown;
}

/** A typed alias for a viem `PublicClient`. */
export type ShellPublicClient = PublicClient;

export type ShellBlockRangeBound = number | `0x${string}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function parseJsonRpcResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) {
    throw new Error("rpc response body is empty");
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("rpc response body is not valid JSON");
  }

  if (!isRecord(body)) {
    throw new Error("rpc response body must be a JSON-RPC object");
  }

  if ("error" in body && body.error !== undefined) {
    const error = body.error;
    if (
      !isRecord(error) ||
      typeof error.code !== "number" ||
      typeof error.message !== "string"
    ) {
      throw new Error("rpc error response is malformed");
    }
    throw new RpcRequestError(error.code, error.message);
  }

  if (!("result" in body)) {
    throw new Error("rpc response body is missing result");
  }

  return body.result as T;
}

/**
 * RPC client for Shell Chain.
 *
 * Combines a viem `PublicClient` (accessible via `.client`) for all standard
 * Ethereum JSON-RPC methods with direct `fetch`-based calls for Shell-specific
 * `shell_*` methods.
 *
 * Prefer constructing via {@link createShellProvider} rather than instantiating
 * this class directly.
 */
export class ShellProvider {
  /** Underlying viem `PublicClient` for standard `eth_*` methods. */
  readonly client: ShellPublicClient;
  /** HTTP RPC URL used for Shell-specific JSON-RPC calls. */
  readonly rpcHttpUrl: string;

  constructor(client: ShellPublicClient, rpcHttpUrl: string) {
    this.client = client;
    this.rpcHttpUrl = rpcHttpUrl;
  }

  private async request<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(this.rpcHttpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(`rpc request failed: ${response.status} ${response.statusText}`);
    }

    return parseJsonRpcResponse<T>(response);
  }

  /**
   * Retrieve the on-chain public key for an address.
   *
   * Calls `shell_getPqPubkey`. Returns `null` if the address has not yet
   * submitted a transaction (public key is only recorded on first send).
   *
   * @param address - A `0x…` hex address.
   * @returns Hex-encoded public key string, or `null` if unknown.
   */
  async getPqPubkey(address: string): Promise<string | null> {
    return this.request("shell_getPqPubkey", [address]);
  }

  /**
   * Broadcast a signed Shell transaction.
   *
   * Calls `shell_sendTransaction`.
   *
   * @param signedTransaction - A fully-signed transaction built with {@link ShellSigner.buildSignedTransaction}.
   * @returns The transaction hash as a hex string.
   * @throws {Error} If the node rejects the transaction.
   */
  async sendTransaction(signedTransaction: SignedShellTransaction): Promise<string> {
    return this.request("shell_sendTransaction", [signedTransaction]);
  }

  /**
   * Fetch paginated transaction history for an address.
   *
   * Calls `shell_getTransactionsByAddress`.
   *
   * @param address - The address to query.
   * @param options - Optional pagination and block range filters.
   * @param options.fromBlock - Start of block range (inclusive).
   * @param options.toBlock - End of block range (inclusive).
   * @param options.page - Zero-based page index.
   * @param options.limit - Maximum number of results per page.
   * @returns Paginated response from the node. `fromBlock`/`toBlock` in the
   * response is the effective inclusive range; clients that paginate under
   * live load should pin `toBlock` from the first page.
   */
  async getTransactionsByAddress(
    address: string,
    options: {
      fromBlock?: ShellBlockRangeBound;
      toBlock?: ShellBlockRangeBound;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<ShellTxByAddressPage> {
    return this.request("shell_getTransactionsByAddress", [
      address,
      options.fromBlock ?? null,
      options.toBlock ?? null,
      options.page ?? null,
      options.limit ?? null,
    ]);
  }

  /**
   * Fetch cursor-paginated transaction history for an address.
   *
   * Calls `shell_getTransactionsByAddressV2` and falls back to
   * `shell_getTransactionsByAddress` for the first page on older nodes.
   */
  async getTransactionsByAddressV2(
    address: string,
    options: ShellTxByAddressV2Options = {},
  ): Promise<ShellTxByAddressV2Page> {
    try {
      return await this.request("shell_getTransactionsByAddressV2", [
        address,
        {
          fromBlock: options.fromBlock ?? null,
          toBlock: options.toBlock ?? null,
          cursor: options.cursor ?? null,
          limit: options.limit ?? null,
          direction: options.direction ?? "desc",
          detail: options.detail ?? "summary",
          includeTotal: options.includeTotal ?? false,
        },
      ]);
    } catch (error) {
      if (options.cursor) {
        throw error;
      }
      if (!isMethodNotFoundError(error)) {
        throw error;
      }
      if (options.direction === "asc") {
        throw new Error(
          "shell_getTransactionsByAddressV2 is required for ascending cursor pagination; legacy fallback only supports descending first-page history",
        );
      }
      const legacy = await this.getTransactionsByAddress(address, {
        fromBlock: options.fromBlock,
        toBlock: options.toBlock,
        page: 0,
        limit: options.limit,
      });
      return {
        address: legacy.address,
        fromBlock: legacy.fromBlock ?? legacy.from_block ?? "0x0",
        toBlock: legacy.toBlock ?? legacy.to_block ?? "0x0",
        limit: legacy.limit,
        direction: "desc",
        total: legacy.total,
        nextCursor: null,
        hasMore: legacy.transactions.length < legacy.total,
        items: legacy.transactions,
      };
    }
  }

  async rpcCapabilities(): Promise<ShellRpcCapabilities> {
    return this.request("shell_rpcCapabilities", []);
  }

  async getChainSnapshot(options: Record<string, unknown> = {}): Promise<ShellChainSnapshot> {
    return this.request("shell_getChainSnapshot", [options]);
  }

  async getBlocksRange(
    start: string | number,
    options: ShellBlocksRangeOptions = {},
  ): Promise<ShellBlocksRange> {
    const startParam = typeof start === "number" ? `0x${start.toString(16)}` : start;
    return this.request("shell_getBlocksRange", [
      startParam,
      {
        direction: options.direction ?? "desc",
        limit: options.limit ?? null,
        txDetail: options.txDetail ?? "summary",
        txLimit: options.txLimit ?? null,
      },
    ]);
  }

  async getAddressSummary(
    address: string,
    options: ShellAddressSummaryOptions = {},
  ): Promise<ShellAddressSummary> {
    return this.request("shell_getAddressSummary", [
      address,
      {
        recentLimit: options.recentLimit ?? null,
        includeTotal: options.includeTotal ?? false,
      },
    ]);
  }

  async getTransactionSummary(
    txHash: string,
    options: { includeReceipt?: boolean } = {},
  ): Promise<ShellTransactionSummaryResult> {
    return this.request("shell_getTransactionSummary", [txHash, options]);
  }

  async getValidatorSnapshot(
    options: ShellValidatorSnapshotOptions = {},
  ): Promise<ShellValidatorSnapshot> {
    return this.request("shell_getValidatorSnapshot", [validatorSnapshotOptions(options)]);
  }

  /**
   * Fetch all transaction receipts for a block.
   *
   * Calls `eth_getBlockReceipts`.
   *
   * @param block - Block identifier: `"latest"`, `"earliest"`, or a hex block number.
   * @returns Array of transaction receipt objects.
   */
  async getBlockReceipts(block: string): Promise<ShellRpcReceipt[]> {
    return this.request("eth_getBlockReceipts", [block]);
  }

  /**
   * Fetch metadata about the connected Shell Chain node.
   *
   * Calls `shell_getNodeInfo`.
   *
   * @returns Node info including version, block height, peer count, and storage profile.
   */
  async getNodeInfo(): Promise<ShellNodeInfo> {
    return this.request("shell_getNodeInfo", []);
  }

  /**
   * Fetch the PQ witness bundle for a block.
   *
   * Calls `shell_getWitness`. Returns `null` if the witness has been pruned
   * (the node is running with a `full` or `light` profile and the STARK proof
   * has already replaced the raw signatures).
   *
   * @param blockNumberOrHash - Hex block number (`"0x1a"`) or block hash.
   * @returns Witness bundle, or `null` if pruned.
   */
  async getWitness(blockNumberOrHash: string): Promise<ShellWitnessBundle | null> {
    return this.request("shell_getWitness", [blockNumberOrHash]);
  }

  /**
   * Fetch the active storage profile of the connected node.
   *
   * Calls `shell_getStorageProfile` and returns its canonical profile name.
   *
   * @returns Storage profile string (`"archive"`, `"full"`, or `"pruned"`), or
   *   `undefined` if the node does not report it.
   */
  async getStorageProfile(): Promise<ShellStorageProfile | undefined> {
    try {
      const info = await this.request<ShellStorageProfileInfo>("shell_getStorageProfile", []);
      return info.profile;
    } catch (error) {
      if (isStorageProfileUnavailableError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  // ── AA methods (v0.18.0) ──────────────────────────────────────────────────

  /**
   * Estimate gas for a native AA batch transaction.
   *
   * Calls `shell_estimateBatch`.
   *
   * @param request - Batch estimate request with inner calls and optional paymaster.
   * @returns Gas estimates including `total_gas`, `per_inner`, and breakdown fields.
   *
   * @example
   * ```typescript
   * const estimate = await provider.estimateBatch({
   *   inner_calls: [{ to: "0x…", value: "0x0", gas_limit: "0x5208" }],
   * });
   * const totalGas = parseInt(estimate.total_gas, 16);
   * ```
   */
  async estimateBatch(request: ShellEstimateBatchRequest): Promise<ShellEstimateBatchResult> {
    return this.request("shell_estimateBatch", [request]);
  }

  /**
   * Query contract-paymaster validation gas capability.
   *
   * Calls `shell_estimatePaymasterGas`. Current nodes return
   * `simulation_status: "cap_only"` and expose only the protocol cap; clients
   * must gate sponsored contract-paymaster UX on the returned status.
   *
   * @param request - Paymaster, sender, optional inner-call bytes and context.
   * @returns Versioned paymaster gas capability/estimate response.
   */
  async estimatePaymasterGas(
    request: ShellEstimatePaymasterGasRequest,
  ): Promise<ShellEstimatePaymasterGasResult> {
    return this.request("shell_estimatePaymasterGas", [request]);
  }

  /**
   * Fetch the paymaster policy for an address.
   *
   * Calls `shell_getPaymasterPolicy`. Any address returns a default `eoa-open`
   * policy even if not explicitly registered as a paymaster.
   *
   * @param address - Paymaster address to query.
   * @returns Paymaster policy object.
   */
  async getPaymasterPolicy(address: string): Promise<ShellPaymasterPolicy> {
    return this.request("shell_getPaymasterPolicy", [address]);
  }

  /**
   * Check whether a transaction is sponsored by a paymaster.
   *
   * Calls `shell_isSponsored`. Returns `{ found: false, … }` for unknown hashes
   * without throwing.
   *
   * @param txHash - Transaction hash to query (`0x`-prefixed).
   * @returns Sponsorship details including found status, paymaster address, and inner call count.
   *
   * @example
   * ```typescript
   * const result = await provider.isSponsored("0xabcd…");
   * if (result.found && result.sponsored) {
   *   console.log("gas paid by", result.paymaster);
   * }
   * ```
   */
  async isSponsored(txHash: string): Promise<ShellIsSponsoredResult> {
    return this.request("shell_isSponsored", [txHash]);
  }

  /**
   * Verify the witness root stored in a block header against the bundle.
   *
   * Calls `shell_verifyWitnessRoot`.
   *
   * @param blockNumberOrTag - Hex block number or `"latest"`.
   * @returns Verification result object `{ block, witnessRoot, bundleRoot, match }`.
   */
  async verifyWitnessRoot(blockNumberOrTag: string): Promise<ShellWitnessRootResult> {
    return this.request("shell_verifyWitnessRoot", [blockNumberOrTag]);
  }
}

/**
 * Create a viem `PublicClient` connected to Shell Chain over HTTP.
 *
 * @param options - Optional chain and URL overrides.
 * @returns A configured viem `PublicClient`.
 *
 * @example
 * ```typescript
 * const client = createShellPublicClient();
 * const blockNumber = await client.getBlockNumber();
 * ```
 */
export function createShellPublicClient(
  options: CreateShellPublicClientOptions = {},
): ShellPublicClient {
  const chain = options.chain ?? shellDevnet;
  const rpcHttpUrl = options.rpcHttpUrl ?? chain.rpcUrls.default.http[0];

  validateRpcUrl(rpcHttpUrl);

  return createPublicClient({
    chain: chain as Chain,
    transport: http(rpcHttpUrl),
  });
}

/**
 * Create a viem `PublicClient` connected to Shell Chain over WebSocket.
 *
 * Useful for subscribing to `newHeads`, `logs`, and other real-time events.
 *
 * @param options - Optional chain and URL overrides.
 * @returns A configured viem `PublicClient` using a WebSocket transport.
 * @throws {Error} If no WebSocket URL is available for the chain.
 *
 * @example
 * ```typescript
 * const wsClient = createShellWsClient();
 * const unwatch = wsClient.watchBlocks({ onBlock: (block) => console.log(block.number) });
 * ```
 */
export function createShellWsClient(options: CreateShellPublicClientOptions = {}): ShellPublicClient {
  const chain = options.chain ?? shellDevnet;
  const rpcWsUrl = options.rpcWsUrl ?? chain.rpcUrls.default.webSocket?.[0];

  if (!rpcWsUrl) {
    throw new Error("chain does not define a default WebSocket RPC URL");
  }

  validateRpcUrl(rpcWsUrl);

  return createPublicClient({
    chain: chain as Chain,
    transport: webSocket(rpcWsUrl),
  });
}

/**
 * Create a {@link ShellProvider} — the recommended entry point for interacting
 * with Shell Chain.
 *
 * Combines a viem HTTP `PublicClient` with Shell-specific RPC helpers.
 *
 * @param options - Optional chain and URL overrides.
 * @returns A fully configured `ShellProvider`.
 *
 * @example
 * ```typescript
 * const provider = createShellProvider();
 * const balance  = await provider.getBalance(signer.getAddress());
 * const hash     = await provider.sendTransaction(signedTx);
 * ```
 */
export function createShellProvider(options: CreateShellPublicClientOptions = {}): ShellProvider {
  const client = createShellPublicClient(options);
  const chain = options.chain ?? shellDevnet;
  const rpcHttpUrl = options.rpcHttpUrl ?? chain.rpcUrls.default.http[0];

  validateRpcUrl(rpcHttpUrl);

  return new ShellProvider(client, rpcHttpUrl);
}
