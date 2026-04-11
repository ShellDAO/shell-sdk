import {
  createPublicClient,
  defineChain,
  http,
  webSocket,
  type Chain,
  type PublicClient,
} from "viem";

import type { SignedShellTransaction } from "./types.js";

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

export interface CreateShellPublicClientOptions {
  chain?: Chain;
  rpcHttpUrl?: string;
  rpcWsUrl?: string;
}

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

export class ShellProvider {
  readonly client: ShellPublicClient;
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

  async getPqPubkey(address: string): Promise<string | null> {
    return this.request("shell_getPqPubkey", [address]);
  }

  async sendTransaction(signedTransaction: SignedShellTransaction): Promise<string> {
    return this.request("shell_sendTransaction", [signedTransaction]);
  }

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

  async getBlockReceipts(block: string): Promise<unknown[]> {
    return this.request("eth_getBlockReceipts", [block]);
  }
}

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

export function createShellProvider(options: CreateShellPublicClientOptions = {}): ShellProvider {
  const client = createShellPublicClient(options);
  const chain = options.chain ?? shellDevnet;
  const rpcHttpUrl = options.rpcHttpUrl ?? chain.rpcUrls.default.http[0];
  return new ShellProvider(client, rpcHttpUrl);
}
