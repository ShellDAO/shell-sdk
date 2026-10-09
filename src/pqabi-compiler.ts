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
  id?: number;
  nodeType?: string;
  name?: string;
  memberName?: string;
  src?: string;
  typeDescriptions?: { typeString?: string };
  [key: string]: unknown;
}

interface AstSource {
  ast: unknown;
}

/** Restore only generated signature constants at the typed emission/revert
 * source location. A whole-IR literal replacement would also change unrelated
 * user constants that happen to equal a lowered event topic or error selector.
 */
function restoreTopicsAndErrors(
  ir: string,
  originalSources: Record<string, AstSource>,
  loweredSources: Record<string, AstSource>,
): string {
  const originalDefinitions = new Map<string, AstNode>();
  for (const source of Object.values(originalSources)) {
    visit(source.ast, (node) => {
      if (node.nodeType === "EventDefinition" || node.nodeType === "ErrorDefinition") {
        originalDefinitions.set(node.src!, node);
      }
    });
  }
  const definitions = new Map<number, { node: AstNode; original: AstNode }>();
  for (const source of Object.values(loweredSources)) {
    visit(source.ast, (node) => {
      if (node.nodeType !== "EventDefinition" && node.nodeType !== "ErrorDefinition") return;
      // Both address and uint256 are seven ASCII bytes: every source range
      // remains unchanged. Validate the declaration pairing rather than rely on
      // the compiler assigning identical AST ids in the two compilations.
      const original = originalDefinitions.get(node.src!);
      if (!original || original.name !== node.name || original.nodeType !== node.nodeType) {
        throw new Error("PQABI signature declaration source mismatch");
      }
      definitions.set(node.id!, { node, original });
    });
  }
  const locations = new Map<string, { kind: string; before: string; after: string }>();
  for (const source of Object.values(loweredSources)) {
    visit(source.ast, (node) => {
      const call = (node.eventCall ?? node.errorCall) as AstNode | undefined;
      if (!call) return;
      const expression = call.expression as AstNode;
      const definition = definitions.get(expression.referencedDeclaration as number);
      if (!definition) throw new Error("PQABI signature declaration unavailable");
      if (definition.node.anonymous) return;
      const kind = definition.node.nodeType === "EventDefinition" ? "event" : "error";
      const selectorKey = kind === "event" ? "eventSelector" : "errorSelector";
      const pad = (value: unknown) => {
        const width = kind === "event" ? 64 : 8;
        if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${width}}$`).test(value)) {
          throw new Error("PQABI signature metadata unavailable");
        }
        return kind === "event" ? value : value.padEnd(64, "0");
      };
      const [start, length, file] = call.src!.split(":").map(Number);
      locations.set(`${file}:${start}:${start + length}`, {
        kind, before: pad(definition.node[selectorKey]), after: pad(definition.original[selectorKey]),
      });
    });
  }
  let location = "";
  let requireError: number | undefined;
  let helperDepth = 0;
  const changed = new Set<string>();
  const encountered = new Set<string>();
  const output = ir.split("\n").map((line) => {
    const functionStart = line.match(/^\s*function (\w+)\(/);
    if (functionStart) {
      const helper = functionStart[1].match(/^require_helper_t_error_(\d+)_/);
      requireError = helper ? Number(helper[1]) : undefined;
      helperDepth = 0;
    }
    if (requireError !== undefined && !line.trimStart().startsWith("//")) {
      helperDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      if (helperDepth === 0) requireError = undefined;
    }
    const marker = line.match(/^\s*\/\/\/ @src (\d+:\d+:\d+)/);
    if (marker) location = marker[1];
    const definition = requireError === undefined ? undefined : definitions.get(requireError);
    if (requireError !== undefined && (!definition || definition.node.nodeType !== "ErrorDefinition")) {
      throw new Error("PQABI require error declaration unavailable");
    }
    // Solidity emits custom-error require helpers outside the call's source
    // marker. Bind their constants to the lowered error declaration's AST id.
    if (definition && [definition.node.errorSelector, definition.original.errorSelector]
      .some((selector) => typeof selector !== "string" || !/^[0-9a-f]{8}$/.test(selector))) {
      throw new Error("PQABI require error signature metadata unavailable");
    }
    const key = definition ? `require:${requireError}` : location;
    const signature = definition ? {
      kind: "error",
      before: String(definition.node.errorSelector).padEnd(64, "0"),
      after: String(definition.original.errorSelector).padEnd(64, "0"),
    } : locations.get(location);
    if (!signature || line.trimStart().startsWith("//")) return line;
    encountered.add(key);
    const pattern = signature.kind === "event"
      ? /^(\s*let \w+ := )0x([0-9a-fA-F]+)(\s*)$/
      : /^(\s*mstore\(\w+, )0x([0-9a-fA-F]+)(\)\s*)$/;
    return line.replace(pattern, (match, before: string, value: string, after: string) => {
      if (value.toLowerCase().padStart(64, "0") !== signature.before) return match;
      changed.add(key);
      return `${before}0x${signature.after}${after}`;
    });
  }).join("\n");
  for (const location of encountered) {
    if (!changed.has(location)) throw new Error(`unsupported PQABI signature emission at ${location}`);
  }
  return output;
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
 * storage, events and explicit custom-error reverts. Reject features that need
 * native call-context instead of silently emitting a 160-bit path.
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
      if (node.nodeType === "InlineAssembly"
        || node.nodeType === "FunctionTypeName" || node.nodeType === "NewExpression"
        || (node.nodeType === "ElementaryTypeName" && node.name === "address"
          && node.stateMutability === "payable")
        || (node.nodeType === "Identifier" && ["this", "super"].includes(node.name ?? ""))
        || (node.nodeType === "MemberAccess" && !["length", "push", "pop"].includes(node.memberName ?? ""))) {
        throw new Error(`PQABI target does not yet support ${node.nodeType}${node.memberName ? ` .${node.memberName}` : ""} in ${path}; native context/calls require further compiler support`);
      }
      if (node.nodeType === "ElementaryTypeName" && node.name === "address") {
        const [start, length] = node.src!.split(":").map(Number);
        if (length !== 7) throw new Error("unsupported PQABI address source range");
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
    let ir = loweredContract.ir.replace(/\bcase 0x([0-9a-fA-F]{1,8})\b/g, (match: string, hex: string) => {
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
    ir = restoreTopicsAndErrors(ir, original.sources, lowered.sources);
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
