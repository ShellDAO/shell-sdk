#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import {
  createShellProvider,
  decryptKeystore,
  deployContract,
  readContract,
  writeContract,
} from "./index.js";
import {
  compileSolidity,
  loadContractArtifact,
} from "./contracts-compiler.js";

type CliOptions = Record<string, string | boolean>;

function usage(): string {
  return `shell-sdk contract <command> [options]

Commands:
  contract compile  --source <path> --contract <name> --out <artifact.json>
  contract deploy   --artifact <artifact.json> --keystore <key.json> --password <password>
  contract write    --artifact <artifact.json> --address <0x...> --function <name> [--args <json>]
  contract read     --artifact <artifact.json> --address <0x...> --function <name> [--args <json>]
  contract smoke    --source <path> --contract <name> --keystore <key.json> [--write <name>] [--read <name>]

Shared options:
  --rpc <url>              Default: SHELL_RPC_URL or http://127.0.0.1:8545
  --chain-id <number>      Default: SHELL_CHAIN_ID or 1337
  --password <password>    Default: SHELL_KEYSTORE_PASSWORD
  --gas-limit <number>
  --args <json>            JSON array; use strings ending in "n" for bigint, e.g. ["7n"]
`;
}

function parseOptions(argv: string[]): { command: string | undefined; options: CliOptions } {
  const [namespace, command, ...rest] = argv;
  if (namespace !== "contract") {
    return { command: namespace, options: {} };
  }

  const options: CliOptions = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }

  return { command, options };
}

function stringOption(options: CliOptions, key: string, fallback?: string): string {
  const value = options[key] ?? fallback;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing --${key}`);
  }
  return value;
}

function optionalStringOption(options: CliOptions, key: string, fallback?: string): string | undefined {
  const value = options[key] ?? fallback;
  if (value == null || typeof value === "boolean") {
    return undefined;
  }
  return value;
}

function numberOption(options: CliOptions, key: string, fallback: number): number {
  const raw = options[key];
  const value = raw == null || raw === true ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${key} must be a positive integer`);
  }
  return value;
}

function parseJsonArgs(raw: string | undefined): unknown[] {
  if (!raw) {
    return [];
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("--args must be a JSON array");
  }
  return parsed.map((value) => {
    if (typeof value === "string" && /^\d+n$/.test(value)) {
      return BigInt(value.slice(0, -1));
    }
    return value;
  });
}

async function loadSigner(options: CliOptions) {
  const keystorePath = stringOption(options, "keystore", process.env.SHELL_KEYSTORE_PATH);
  const password = stringOption(options, "password", process.env.SHELL_KEYSTORE_PASSWORD);
  const keystore = JSON.parse(await readFile(keystorePath, "utf8"));
  return decryptKeystore(keystore, password);
}

function providerFromOptions(options: CliOptions) {
  return createShellProvider({
    rpcHttpUrl: stringOption(options, "rpc", process.env.SHELL_RPC_URL ?? "http://127.0.0.1:8545"),
  });
}

async function compileCommand(options: CliOptions) {
  const artifact = await compileSolidity({
    sources: [{ path: stringOption(options, "source") }],
    contractName: stringOption(options, "contract"),
    outputPath: stringOption(options, "out"),
  });
  console.log(JSON.stringify({
    contractName: artifact.contractName,
    sourcePath: artifact.sourcePath,
    bytecodeBytes: (artifact.bytecode.length - 2) / 2,
  }));
}

async function deployCommand(options: CliOptions) {
  const provider = providerFromOptions(options);
  const signer = await loadSigner(options);
  const artifact = await loadContractArtifact(stringOption(options, "artifact"));
  const result = await deployContract({
    provider,
    signer,
    chainId: numberOption(options, "chain-id", Number(process.env.SHELL_CHAIN_ID ?? "1337")),
    artifact,
    constructorArgs: parseJsonArgs(optionalStringOption(options, "args")),
    gasLimit: numberOption(options, "gas-limit", 1_500_000),
    includePublicKey: true,
    wait: true,
  });
  console.log(JSON.stringify(result));
}

async function writeCommand(options: CliOptions) {
  const provider = providerFromOptions(options);
  const signer = await loadSigner(options);
  const artifact = await loadContractArtifact(stringOption(options, "artifact"));
  const result = await writeContract({
    provider,
    signer,
    chainId: numberOption(options, "chain-id", Number(process.env.SHELL_CHAIN_ID ?? "1337")),
    address: stringOption(options, "address"),
    abi: artifact.abi,
    functionName: stringOption(options, "function"),
    args: parseJsonArgs(optionalStringOption(options, "args")),
    gasLimit: numberOption(options, "gas-limit", 120_000),
    wait: true,
  });
  console.log(JSON.stringify(result));
}

async function readCommand(options: CliOptions) {
  const provider = providerFromOptions(options);
  const artifact = await loadContractArtifact(stringOption(options, "artifact"));
  const result = await readContract({
    provider,
    address: stringOption(options, "address"),
    abi: artifact.abi,
    functionName: stringOption(options, "function"),
    args: parseJsonArgs(optionalStringOption(options, "args")),
  });
  console.log(JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value));
}

async function smokeCommand(options: CliOptions) {
  const out = optionalStringOption(options, "out") ?? ".shell-sdk-smoke-artifact.json";
  await compileCommand({ ...options, out });
  const deployResult = await deployContract({
    provider: providerFromOptions(options),
    signer: await loadSigner(options),
    chainId: numberOption(options, "chain-id", Number(process.env.SHELL_CHAIN_ID ?? "1337")),
    artifact: await loadContractArtifact(out),
    constructorArgs: parseJsonArgs(optionalStringOption(options, "args")),
    gasLimit: numberOption(options, "gas-limit", 1_500_000),
    includePublicKey: true,
    wait: true,
  });
  const writeName = optionalStringOption(options, "write");
  if (writeName) {
    await writeCommand({
      ...options,
      artifact: out,
      address: deployResult.contractAddress ?? "",
      function: writeName,
      args: optionalStringOption(options, "write-args") ?? "[]",
    });
  }
  const readName = optionalStringOption(options, "read");
  if (readName) {
    await readCommand({
      ...options,
      artifact: out,
      address: deployResult.contractAddress ?? "",
      function: readName,
      args: optionalStringOption(options, "read-args") ?? "[]",
    });
  }
  console.log(JSON.stringify({ ok: true, deploy: deployResult }));
}

async function main(argv: string[]) {
  const { command, options } = parseOptions(argv);
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }
  if (command === "compile") return compileCommand(options);
  if (command === "deploy") return deployCommand(options);
  if (command === "write") return writeCommand(options);
  if (command === "read") return readCommand(options);
  if (command === "smoke") return smokeCommand(options);
  throw new Error(`unknown command: ${command}\n\n${usage()}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
