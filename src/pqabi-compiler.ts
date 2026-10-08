import solc from "solc";

interface CompilerInput {
  language: string;
  sources: Record<string, { content: string }>;
  settings: {
    optimizer: { enabled: boolean; runs: number };
    evmVersion?: string;
    outputSelection: Record<string, Record<string, string[]>>;
  };
}

interface AstNode {
  nodeType?: string;
  name?: string;
  memberName?: string;
  src?: string;
  typeDescriptions?: { typeString?: string };
  [key: string]: unknown;
}

function compile(input: unknown) {
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter((error: { severity: string }) => error.severity === "error");
  if (errors.length) {
    throw new Error(`PQABI compile failed:\n${errors.map((error: { formattedMessage: string }) => error.formattedMessage).join("\n")}`);
  }
  return output;
}

function visit(value: unknown, visitor: (node: AstNode) => void): void {
  if (Array.isArray(value)) {
    for (const child of value) visit(child, visitor);
  } else if (value && typeof value === "object") {
    const node = value as AstNode;
    if (node.nodeType) visitor(node);
    for (const child of Object.values(node)) visit(child, visitor);
  }
}

/**
 * Compile address values as full storage/ABI words, keeping Solidity's original
 * type checking and the original public ABI/dispatch selectors. Source edits
 * use compiler AST byte ranges rather than matching text in comments/strings.
 *
 * This first target supports address values, comparisons, arrays, mappings and
 * storage. Reject features that need native call-context or typed selector/topic
 * lowering instead of silently emitting a 160-bit path.
 */
export function compilePqabi(input: CompilerInput, contractName: string) {
  const selection = {
    "*": { "": ["ast"], "*": ["abi", "evm.methodIdentifiers", "ir"] },
  };
  const original = compile({ ...input, settings: { ...input.settings, outputSelection: selection } });
  let hasAddress = false;
  for (const source of Object.values(original.sources) as { ast: unknown }[]) {
    visit(source.ast, (node) => {
      if (node.nodeType === "ElementaryTypeName" && node.name === "address") hasAddress = true;
    });
  }
  if (!hasAddress) return compile(input);

  const sources: CompilerInput["sources"] = {};
  for (const [path, source] of Object.entries(input.sources)) {
    const replacements: { start: number; length: number }[] = [];
    visit(original.sources[path].ast, (node) => {
      if (node.nodeType === "InlineAssembly" || node.nodeType === "EventDefinition" || node.nodeType === "ErrorDefinition"
        || node.nodeType === "FunctionTypeName" || node.nodeType === "NewExpression"
        || (node.nodeType === "ElementaryTypeName" && node.name === "address"
          && node.stateMutability === "payable")
        || (node.nodeType === "Identifier" && ["this", "super"].includes(node.name ?? ""))
        || (node.nodeType === "MemberAccess" && !["length", "push", "pop"].includes(node.memberName ?? ""))) {
        throw new Error(`PQABI target does not yet support ${node.nodeType}${node.memberName ? ` .${node.memberName}` : ""} in ${path}; native context/calls and event/selector lowering require further compiler support`);
      }
      if (node.nodeType === "ElementaryTypeName" && node.name === "address") {
        const [start, length] = node.src!.split(":").map(Number);
        replacements.push({ start, length });
      }
    });
    let content = Buffer.from(source.content);
    for (const { start, length } of replacements.sort((a, b) => b.start - a.start)) {
      content = Buffer.concat([content.subarray(0, start), Buffer.from("uint256"), content.subarray(start + length)]);
    }
    sources[path] = { content: content.toString("utf8") };
  }
  const lowered = compile({ ...input, sources, settings: { ...input.settings, viaIR: true, outputSelection: selection } });
  for (const [path, contracts] of Object.entries(original.contracts) as [string, Record<string, { abi: unknown; evm: { methodIdentifiers: Record<string, string> } }>][] ) {
    const originalContract = contracts[contractName];
    if (!originalContract) continue;
    const loweredContract = lowered.contracts[path][contractName];
    const selectors = new Map<string, string>();
    for (const [signature, selector] of Object.entries(originalContract.evm.methodIdentifiers)) {
      const loweredSignature = signature.replace(/\baddress\b/g, "uint256");
      const loweredSelector = loweredContract.evm.methodIdentifiers[loweredSignature];
      if (!loweredSelector) throw new Error(`missing lowered selector for ${signature}`);
      selectors.set(loweredSelector.toLowerCase(), selector);
    }
    // Replace only dispatcher case literals, in one pass (avoids cascading swaps).
    const seen = new Map<string, number>();
    const ir = loweredContract.ir.replace(/\bcase 0x([0-9a-fA-F]{1,8})\b/g, (match: string, hex: string) => {
      const selector = selectors.get(hex.toLowerCase().padStart(8, "0"));
      if (selector) {
        const key = hex.toLowerCase().padStart(8, "0");
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      return selector ? `case 0x${selector}` : match;
    });
    for (const selector of selectors.keys()) {
      if (seen.get(selector) !== 1) throw new Error(`ambiguous or missing PQABI dispatcher selector ${selector}`);
    }
    const yul = compile({
      language: "Yul",
      sources: { [path]: { content: ir } },
      settings: {
        optimizer: input.settings.optimizer,
        ...(input.settings.evmVersion ? { evmVersion: input.settings.evmVersion } : {}),
        outputSelection: { "*": { "*": ["evm.bytecode.object", "evm.deployedBytecode.object"] } },
      },
    });
    const compiled = Object.values(yul.contracts[path])[0];
    return { contracts: { [path]: { [contractName]: { ...compiled as object, abi: originalContract.abi } } } };
  }
  throw new Error(`missing compiled contract ${contractName}`);
}
