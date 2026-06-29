/**
 * Node-only Solidity compiler helpers for Shell Chain contract development.
 *
 * Import this subpath only from Node scripts:
 *
 * ```ts
 * import { compileSolidity } from "shell-sdk/contracts/compiler";
 * ```
 *
 * @module contracts/compiler
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import solc from "solc";
import type { Abi } from "viem";

import type { HexString } from "./types.js";
import type { ShellContractArtifact } from "./contracts.js";

export interface CompileSoliditySource {
  path: string;
  content?: string;
}

export interface CompileSolidityOptions {
  sources: CompileSoliditySource[];
  contractName: string;
  optimizer?: {
    enabled?: boolean;
    runs?: number;
  };
  evmVersion?: string;
  outputPath?: string;
}

interface SolcError {
  severity?: string;
  message?: string;
  formattedMessage?: string;
}

interface SolcCompiledContract {
  abi?: Abi;
  evm?: {
    bytecode?: { object?: string };
    deployedBytecode?: { object?: string };
  };
  metadata?: string;
}

function ensureHexBytecode(bytecode: string | undefined): HexString {
  if (!bytecode || !/^[0-9a-fA-F]+$/.test(bytecode)) {
    throw new Error("compiled contract is missing EVM bytecode");
  }
  return `0x${bytecode}`;
}

async function readSources(sources: CompileSoliditySource[]): Promise<Record<string, { content: string }>> {
  if (sources.length === 0) {
    throw new Error("compileSolidity requires at least one source");
  }

  const entries = await Promise.all(sources.map(async (source) => {
    const content = source.content ?? await readFile(source.path, "utf8");
    return [source.path, { content }] as const;
  }));
  return Object.fromEntries(entries);
}

export async function compileSolidity(
  options: CompileSolidityOptions,
): Promise<ShellContractArtifact> {
  const sources = await readSources(options.sources);
  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: {
        enabled: options.optimizer?.enabled ?? true,
        runs: options.optimizer?.runs ?? 200,
      },
      ...(options.evmVersion ? { evmVersion: options.evmVersion } : {}),
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = ((output.errors ?? []) as SolcError[]).filter((entry) => entry.severity === "error");
  if (errors.length > 0) {
    const message = errors
      .map((entry) => entry.formattedMessage ?? entry.message ?? "unknown Solidity compiler error")
      .join("\n");
    throw new Error(`Solidity compile failed:\n${message}`);
  }

  let selectedSourcePath: string | null = null;
  let selectedContract: SolcCompiledContract | null = null;
  for (const [sourcePath, contracts] of Object.entries(output.contracts ?? {})) {
    const candidate = (contracts as Record<string, SolcCompiledContract>)[options.contractName];
    if (candidate) {
      selectedSourcePath = sourcePath;
      selectedContract = candidate;
      break;
    }
  }

  if (!selectedSourcePath || !selectedContract?.abi) {
    throw new Error(`missing compiled contract ${options.contractName}`);
  }

  const artifact: ShellContractArtifact = {
    contractName: options.contractName,
    sourcePath: selectedSourcePath,
    solcVersion: solc.version(),
    abi: selectedContract.abi,
    bytecode: ensureHexBytecode(selectedContract.evm?.bytecode?.object),
    deployedBytecode: selectedContract.evm?.deployedBytecode?.object
      ? ensureHexBytecode(selectedContract.evm.deployedBytecode.object)
      : undefined,
    metadata: selectedContract.metadata ? JSON.parse(selectedContract.metadata) : undefined,
  };

  if (options.outputPath) {
    await saveContractArtifact(options.outputPath, artifact);
  }

  return artifact;
}

export async function loadContractArtifact(artifactPath: string): Promise<ShellContractArtifact> {
  return JSON.parse(await readFile(artifactPath, "utf8")) as ShellContractArtifact;
}

export async function saveContractArtifact(
  artifactPath: string,
  artifact: ShellContractArtifact,
): Promise<void> {
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}
