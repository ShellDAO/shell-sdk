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

import type { SignedShellTransaction } from "./types.js";

/**
 * Pre-configured viem chain definition for Shell Devnet.
 *
 * - Chain ID: `424242`
 * - HTTP RPC: `http://127.0.0.1:8545`
 * - WebSocket RPC: `ws://127.0.0.1:8546`
 * - Native currency: SHELL (18 decimals)
 */
export const shellDevnet = defineChain({
  id: 424242,
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
  /** Override the viem chain config. Defaults to {@link shellDevnet}. */
  chain?: Chain;
  /** Override the HTTP RPC URL. Defaults to the chain's first HTTP URL. */
  rpcHttpUrl?: string;
  /** Override the WebSocket RPC URL. Defaults to the chain's first WS URL. */
  rpcWsUrl?: string;
}

/** A typed alias for a viem `PublicClient`. */
export type ShellPublicClient = PublicClient;

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

    const body = (await response.json()) as JsonRpcResponse<T>;
    if ("error" in body && body.error) {
      throw new Error(`[${body.error.code}] ${body.error.message}`);
    }

    return body.result;
  }

  /**
   * Retrieve the on-chain public key for an address.
   *
   * Calls `shell_getPqPubkey`. Returns `null` if the address has not yet
   * submitted a transaction (public key is only recorded on first send).
   *
   * @param address - A `pq1…` or `0x…` address.
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
   * @returns Raw paginated response from the node.
   */
  async getTransactionsByAddress(
    address: string,
    options: {
      fromBlock?: number;
      toBlock?: number;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<unknown> {
    return this.request("shell_getTransactionsByAddress", [
      address,
      options.fromBlock ?? null,
      options.toBlock ?? null,
      options.page ?? null,
      options.limit ?? null,
    ]);
  }

  /**
   * Fetch all transaction receipts for a block.
   *
   * Calls `eth_getBlockReceipts`.
   *
   * @param block - Block identifier: `"latest"`, `"earliest"`, or a hex block number.
   * @returns Array of transaction receipt objects.
   */
  async getBlockReceipts(block: string): Promise<unknown[]> {
    return this.request("eth_getBlockReceipts", [block]);
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

  return createPublicClient({
    chain,
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

  return createPublicClient({
    chain,
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
 * const balance  = await provider.client.getBalance({ address: signer.getHexAddress() });
 * const hash     = await provider.sendTransaction(signedTx);
 * ```
 */
export function createShellProvider(options: CreateShellPublicClientOptions = {}): ShellProvider {
  const client = createShellPublicClient(options);
  const chain = options.chain ?? shellDevnet;
  const rpcHttpUrl = options.rpcHttpUrl ?? chain.rpcUrls.default.http[0];
  return new ShellProvider(client, rpcHttpUrl);
}
