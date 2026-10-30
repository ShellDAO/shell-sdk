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
  typeDescriptions?: { typeString?: string; typeIdentifier?: string };
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
  sourceLocation: (location: string) => string,
): string {
  const originalDefinitions = new Map<string, AstNode>();
  for (const source of Object.values(originalSources)) {
    visit(source.ast, (node) => {
      if (node.nodeType === "EventDefinition" || node.nodeType === "ErrorDefinition") {
        originalDefinitions.set(sourceLocation(node.src!), node);
      }
    });
  }
  const definitions = new Map<number, { node: AstNode; original: AstNode }>();
  for (const source of Object.values(loweredSources)) {
    visit(source.ast, (node) => {
      if (node.nodeType !== "EventDefinition" && node.nodeType !== "ErrorDefinition") return;
      // Pair declarations by translated byte ranges, including longer overload
      // names, rather than assuming identical AST ids across compilations.
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

/** Give only collapsed overloads distinct backend names. Prefer equal byte
 * widths; defer longer names until other original AST edits are complete.
 * References follow Solidity's already-resolved declaration ids, so lowering
 * must never choose an overload again after address becomes uint256.
 */
function nativeOverloadAliases(
  input: CompilerInput,
  originalSources: Record<string, AstSource>,
  contracts: Record<string, Record<string, { evm: { methodIdentifiers: Record<string, string> } }>>,
) {
  const functions: AstNode[] = [];
  const contractsById = new Map<number, AstNode>();
  const used = new Set<string>();
  for (const source of Object.values(originalSources)) {
    visit(source.ast, (node) => {
      if (node.name) used.add(node.name);
      if (node.memberName) used.add(node.memberName);
      if (node.nodeType === "FunctionDefinition" && node.name) functions.push(node);
      if (node.nodeType === "ContractDefinition") contractsById.set(node.id!, node);
    });
  }
  const publicSelectors = new Set<string>();
  for (const file of Object.values(contracts)) for (const contract of Object.values(file)) {
    const groups = new Map<string, Set<string>>();
    for (const signature of Object.keys(contract.evm.methodIdentifiers)) {
      const lowered = signature.replace(/\baddress\b/g, "uint256");
      const group = groups.get(lowered) ?? new Set<string>();
      group.add(signature); groups.set(lowered, group);
    }
    for (const group of groups.values()) if (group.size > 1) {
      for (const signature of group) if (/\baddress\b/.test(signature)) {
        publicSelectors.add(contract.evm.methodIdentifiers[signature]);
      }
    }
  }
  const signature = (node: AstNode) => {
    const parameters = (node.parameters as { parameters: AstNode[] }).parameters;
    return `${node.name}(${parameters.map((parameter) => parameter.typeDescriptions!.typeString!
      .replace(/\s+(?:memory|storage|calldata)(?:\s+(?:ref|pointer))?/g, "")).join(",")})`;
  };
  const collapsed = new Set<string>();
  const scopes = [...contractsById.values()].map((contract) =>
    (contract.linearizedBaseContracts as number[]).flatMap((id) => contractsById.get(id)!.nodes as AstNode[]));
  scopes.push(functions.filter((node) => node.kind === "freeFunction"));
  for (const scope of scopes) {
    const groups = new Map<string, Set<string>>();
    for (const node of scope) {
      if (node.nodeType !== "FunctionDefinition" || !node.name) continue;
      const before = signature(node);
      const lowered = before.replace(/\baddress\b/g, "uint256");
      const group = groups.get(lowered) ?? new Set<string>();
      group.add(before); groups.set(lowered, group);
    }
    for (const group of groups.values()) if (group.size > 1) {
      for (const before of group) if (/\baddress\b/.test(before)) collapsed.add(before);
    }
  }
  const byId = new Map<number, string>();
  const bySignature = new Map<string, string>();
  const bySelector = new Map<string, string>();
  for (const node of functions) {
    const key = signature(node);
    if (!collapsed.has(key) && !publicSelectors.has(node.functionSelector as string)) continue;
    let alias = bySignature.get(key);
    if (!alias) {
      const width = Buffer.byteLength(node.name!);
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
      const limit = Math.min(alphabet.length ** width, used.size + 1);
      for (let candidate = 0; candidate < limit && !alias; candidate++) {
        let remaining = candidate; let value = "";
        for (let i = 0; i < width; i++) {
          value += alphabet[remaining % alphabet.length];
          remaining = Math.floor(remaining / alphabet.length);
        }
        // An uppercase initial excludes Solidity keywords and reserved names.
        if (/^[A-Z]/.test(value) && !used.has(value)) alias = value;
      }
      if (!alias) {
        // Source can occupy every name of the original width. The dollar
        // prefix is legal in Solidity and cannot produce a reserved keyword.
        let candidate = 0;
        do { alias = `$${String(candidate++).padStart(width, "0")}`; } while (used.has(alias));
      }
      used.add(alias); bySignature.set(key, alias);
    }
    byId.set(node.id!, alias);
    if (typeof node.functionSelector === "string") bySelector.set(node.functionSelector, alias);
  }
  const sources: CompilerInput["sources"] = {};
  const longerNames = new Map<string, { start: number; length: number; alias: string }[]>();
  for (const [path, source] of Object.entries(input.sources)) {
    const replacements: { start: number; length: number; alias: string }[] = [];
    visit(originalSources[path].ast, (node) => {
      const alias = byId.get(node.nodeType === "FunctionDefinition" ? node.id! : node.referencedDeclaration as number);
      if (!alias) return;
      const location = node.nodeType === "FunctionDefinition" ? node.nameLocation :
        node.nodeType === "Identifier" ? node.src : undefined;
      if (node.nodeType !== "FunctionDefinition" && node.nodeType !== "Identifier") return;
      if (typeof location !== "string") throw new Error("PQABI overload name source range unavailable");
      const [start, length] = location.split(":").map(Number);
      if (length !== Buffer.byteLength(node.name!)) throw new Error("PQABI overload name source range mismatch");
      replacements.push({ start, length, alias });
    });
    const content = Buffer.from(source.content);
    longerNames.set(path, replacements.filter(({ length, alias }) => length !== Buffer.byteLength(alias)));
    for (const { start, length, alias } of replacements) {
      if (length === Buffer.byteLength(alias)) content.write(alias, start, length, "utf8");
    }
    sources[path] = { content: content.toString("utf8") };
  }
  return { sources, bySelector, longerNames };
}

function compile(input: unknown) {
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter((error: { severity: string }) => error.severity === "error");
  if (errors.length) {
    throw new Error(`PQABI compile failed:\n${errors.map((error: { formattedMessage: string }) => error.formattedMessage).join("\n")}`);
  }
  return output;
}

/** Integer metatype limits are evaluated by Solidity and contain no address
 * path. Identify the typed builtin, not a user member named min or max.
 */
function integerLimit(node: AstNode): boolean {
  const call = node.expression as AstNode | undefined;
  const callee = call?.expression as AstNode | undefined;
  return node.nodeType === "MemberAccess" && ["min", "max"].includes(node.memberName ?? "")
    && call?.nodeType === "FunctionCall" && call.kind === "functionCall"
    && callee?.typeDescriptions?.typeIdentifier === "t_function_metatype_pure$__$returns$__$"
    && /^t_magic_meta_type_t_u?int[0-9]+$/.test(call.typeDescriptions?.typeIdentifier ?? "");
}

function blockTimestamp(node: AstNode): boolean {
  const expression = node.expression as AstNode | undefined;
  return node.nodeType === "MemberAccess" && node.memberName === "timestamp"
    && expression?.nodeType === "Identifier" && expression.name === "block"
    && expression.typeDescriptions?.typeIdentifier === "t_magic_block";
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

function staticAbiScalar(type: AstNode): boolean {
  return (type?.name === "address" && type.stateMutability !== "payable")
    || /^u?int(?:[0-9]+)?$/.test(String(type?.name))
    || /^bytes[0-9]+$/.test(String(type?.name)) || type?.name === "bool";
}

function supportedAbiValue(type: AstNode): boolean {
  return staticAbiScalar(type) || type?.name === "bytes" || type?.name === "string"
    || (type?.nodeType === "ArrayTypeName" && staticAbiScalar(type.baseType as AstNode));
}

function abiReference(type: AstNode): boolean {
  return type.nodeType === "ArrayTypeName" || type.name === "bytes" || type.name === "string";
}

/**
 * Compile address values as full storage/ABI words, keeping Solidity's original
 * type checking and the original public ABI/dispatch selectors. Source edits
 * use compiler AST byte ranges rather than matching text in comments/strings.
 *
 * This first target supports address values, comparisons, arrays, mappings and
 * storage, events and explicit custom-error reverts. Native context and address
 * variable introspection require an explicit matching activation schedule.
 * Unsupported call paths reject instead of silently emitting a 160-bit path.
 */
export function compilePqabi(input: CompilerInput, contractName: string, nativeHeight?: number) {
  if (nativeHeight !== undefined && (!Number.isSafeInteger(nativeHeight) || nativeHeight < 0)) {
    throw new Error("native address context height must be a nonnegative safe integer");
  }
  const builtin = (node: AstNode): string | undefined => {
    if (node.nodeType === "MemberAccess") {
      const expression = node.expression as AstNode;
      if (["address", "address payable"].includes(expression?.typeDescriptions?.typeString ?? "")
        && (expression.nodeType === "Identifier" || ["caller", "origin", "coinbase", "address"].includes(builtin(expression) ?? ""))
        && ["balance", "codehash", "code"].includes(node.memberName ?? "")) return node.memberName;
      const name = expression?.name;
      const magic = ({msg: "t_magic_message", tx: "t_magic_transaction", block: "t_magic_block"} as Record<string, string>)[name ?? ""];
      if (!magic || expression.typeDescriptions?.typeIdentifier !== magic) return undefined;
      return ({ "msg.sender": "caller", "tx.origin": "origin", "block.coinbase": "coinbase" } as Record<string, string>)[`${name}.${node.memberName}`];
    }
    if (node.nodeType === "FunctionCall" && node.kind === "typeConversion"
      && ((node.expression as AstNode)?.typeName as AstNode)?.name === "address"
      && (node.arguments as AstNode[])?.length === 1
      && (node.arguments as AstNode[])[0].nodeType === "Identifier"
      && (node.arguments as AstNode[])[0].name === "this") return "address";
    return undefined;
  };
  const internalAddressReceiver = (node: AstNode) => node?.nodeType === "FunctionCall"
    && node.kind === "functionCall" && (node.arguments as AstNode[])?.every((argument) =>
      ["Identifier", "Literal"].includes(argument.nodeType ?? ""))
    && (node.expression as AstNode)?.nodeType === "Identifier"
    && (node.expression as AstNode)?.typeDescriptions?.typeIdentifier?.startsWith("t_function_internal");
  const selection = {
    "*": { "": ["ast"], "*": ["abi", "evm.methodIdentifiers", "ir"] },
  };
  const original = compile({ ...input, settings: { ...input.settings, outputSelection: selection } });
  const nativeYulOperations = new Set(["address", "caller", "origin", "coinbase", "balance", "extcodesize", "extcodehash", "extcodecopy", "call", "staticcall", "delegatecall"]);
  let hasAddress = false;
  for (const source of Object.values(original.sources) as { ast: unknown }[]) {
    visit(source.ast, (node) => {
      if ((node.nodeType === "ElementaryTypeName" && node.name === "address") || builtin(node)
        || (node.nodeType === "YulFunctionCall" && nativeYulOperations.has(String((node.functionName as AstNode)?.name)))) hasAddress = true;
    });
  }
  if (!hasAddress) return compile(input);

  const overloads = nativeOverloadAliases(input, original.sources, original.contracts);

  const structMembers = new Set<number>();
  for (const source of Object.values(original.sources) as AstSource[]) {
    visit(source.ast, (node) => {
      if (node.nodeType === "StructDefinition") {
        for (const member of node.members as AstNode[]) structMembers.add(member.id!);
      }
    });
  }
  const structMember = (node: AstNode): boolean => node.nodeType === "MemberAccess"
    && typeof node.referencedDeclaration === "number"
    && structMembers.has(node.referencedDeclaration)
    && (node.expression as AstNode)?.typeDescriptions?.typeIdentifier?.startsWith("t_struct$_") === true;

  const externalFunctions = new Map<number, AstNode>();
  const interfaceIds = new Map<number, string>();
  const sourceNames = new Set<string>();
  let selectorHelperIndex = 0;
  for (const source of Object.values(original.sources) as AstSource[]) {
    visit(source.ast, (node) => {
      if (node.name) sourceNames.add(node.name);
      if (node.nodeType === "ContractDefinition" && node.contractKind === "interface") {
        // Solidity excludes inherited functions; only direct named declarations
        // contribute. Events, errors, fallback and receive have no selectors.
        let id = 0n;
        for (const child of node.nodes as AstNode[]) {
          if (child.nodeType !== "FunctionDefinition" || child.kind !== "function") continue;
          const selector = child.functionSelector;
          if (typeof selector !== "string" || !/^[0-9a-f]{8}$/.test(selector)) {
            throw new Error("PQABI original interface function selector unavailable");
          }
          id ^= BigInt(`0x${selector}`);
        }
        interfaceIds.set(node.id!, id.toString(16).padStart(8, "0"));
      }
      if (node.nodeType === "FunctionDefinition") externalFunctions.set(node.id!, node);
    });
  }
  // Resolve the original declaration before address lowering changes signatures.
  // Only identifier receivers are constant here; evaluating a receiver expression
  // may have side effects and must never be erased by this transformation.
  const staticBytes4 = (node: AstNode): string | undefined => {
    const member = node.expression as AstNode;
    if (node.nodeType === "MemberAccess" && node.memberName === "interfaceId"
      && member?.nodeType === "FunctionCall"
      && (member.expression as AstNode)?.typeDescriptions?.typeIdentifier?.startsWith("t_function_metatype")
      && (member.arguments as AstNode[])?.length === 1) {
      return interfaceIds.get((member.arguments as AstNode[])[0].referencedDeclaration as number);
    }
    if (node.nodeType !== "MemberAccess" || node.memberName !== "selector"
      || member?.nodeType !== "MemberAccess"
      || (member.expression as AstNode)?.nodeType !== "Identifier") return undefined;
    const definition = externalFunctions.get(member.referencedDeclaration as number);
    const selector = definition?.functionSelector;
    return typeof selector === "string" && /^[0-9a-f]{8}$/.test(selector) ? selector : undefined;
  };
  const sources: CompilerInput["sources"] = {};
  let needsViewBackend = false;
  const longerNames = new Map<string, { start: number; length: number; alias: string }[]>();
  const assemblyGuards = new Map<string, { start: number; length: number; alias: string }[]>();
  for (const [path, source] of Object.entries(overloads.sources)) {
    const helpers = new Map<string, string>();
    const guards: { start: number; length: number; alias: string }[] = [];
    assemblyGuards.set(path, guards);
    const helperName = (operation: string, node: AstNode) => {
      const fileId = node.src!.split(":")[2];
      const letter = ({caller: "c", origin: "o", coinbase: "b", address: "a", balance: "l", codehash: "h", code: "x"} as Record<string, string>)[operation];
      const name = `_${["balance", "codehash", "code"].includes(operation) ? "" : "p"}${letter}${fileId}`;
      helpers.set(operation, name);
      return name;
    };
    const read = (node: AstNode): string => {
      const [start, length] = node.src!.split(":").map(Number);
      const contexts: { start: number; length: number; text: string }[] = [];
      visit(node, (child) => {
        if (!builtin(child) && !staticBytes4(child)) return;
        const [offset, size] = child.src!.split(":").map(Number);
        if (contexts.some((edit) => offset >= edit.start && offset + size <= edit.start + edit.length)) return;
        contexts.push({start: offset, length: size, text: renderContext(child)});
      });
      const edits = [
        ...overloads.longerNames.get(path)!.filter((edit) => edit.start >= start && edit.start + edit.length <= start + length
          && !contexts.some((context) => edit.start >= context.start && edit.start + edit.length <= context.start + context.length))
          .map((edit) => ({...edit, text: edit.alias})),
        ...contexts,
      ];
      let content = Buffer.from(source.content).subarray(start, start + length);
      for (const edit of edits.sort((a, b) => b.start - a.start)) {
        const offset = edit.start - start;
        content = Buffer.concat([content.subarray(0, offset), Buffer.from(edit.text), content.subarray(offset + edit.length)]);
      }
      return content.toString("utf8");
    };
    function renderContext(node: AstNode): string {
      const selector = staticBytes4(node);
      if (selector) {
        // This typed literal also remains valid in Solidity constant initializers.
        if (node.memberName === "interfaceId") return `bytes4(0x${selector})`;
        const key = `selector:${selector}`;
        let name = helpers.get(key);
        if (!name) {
          do { name = `_j${(selectorHelperIndex++).toString(36)}`; } while (sourceNames.has(name));
          sourceNames.add(name);
          helpers.set(key, name);
          typedDeclarations.set(name, `function ${name}() pure returns(bytes4) { return 0x${selector}; }`);
        }
        return `${name}()`;
      }
      if (nativeHeight === undefined) {
        throw new Error("PQABI target does not yet support native context without nativeAddressContextHeight matching an activated node profile");
      }
      const opcode = builtin(node)!;
      const name = helperName(opcode, node);
      const receiver = ["balance", "codehash", "code"].includes(opcode) ? read(node.expression as AstNode) : "";
      return `${name}(${receiver})`;
    }
    const replacements: { start: number; length: number; text: string }[] = [];
    const handled = new Set<number>();
    const typedDeclarations = new Map<string, string>();
    visit(original.sources[path].ast, (node) => {
      if (node.id !== undefined && handled.has(node.id)) return;
      if (node.nodeType === "InlineAssembly") {
        if (nativeHeight === undefined) throw new Error("PQABI target does not yet support InlineAssembly without nativeAddressContextHeight matching an activated node profile");
        visit(node, (child) => {
          if (child.nodeType === "YulFunctionCall" && ["create", "create2", "callcode", "selfdestruct"].includes(String((child.functionName as AstNode)?.name))) {
            throw new Error(`PQABI native InlineAssembly does not yet support ${(child.functionName as AstNode).name}`);
          }
          if (child.id !== undefined) handled.add(child.id);
        });
        const body = node.AST as AstNode;
        const start = Number(body.src!.split(":")[0]) + 1;
        if (Buffer.from(source.content)[start - 1] !== 123) throw new Error("unsupported PQABI assembly block source range");
        guards.push({start, length: 0, alias: ` if lt(number(), ${nativeHeight}) { revert(0, 0) } `});
        // Original Solidity purity was checked before adding the height guard.
        needsViewBackend = true;
        return;
      }
      if (node.nodeType === "FunctionCall") {
        const call = node.expression as AstNode;
        const member = (call?.nodeType === "FunctionCallOptions" ? call.expression : call) as AstNode;
        const target = member?.expression as AstNode;
        if (member?.nodeType === "MemberAccess" && target?.nodeType === "FunctionCall"
          && target.kind === "typeConversion" && target.typeDescriptions?.typeString?.startsWith("contract ")) {
          const definition = externalFunctions.get(member.referencedDeclaration as number);
          const parameters = (definition?.parameters as AstNode)?.parameters as AstNode[] | undefined;
          const returns = (definition?.returnParameters as AstNode)?.parameters as AstNode[] | undefined;
          const receiver = (target.arguments as AstNode[])?.[0];
          const arguments_ = node.arguments as AstNode[] | undefined;
          const supportedParameter = (parameter: AstNode) => supportedAbiValue(parameter.typeName as AstNode);
          if (!definition || !parameters || !returns
            || !parameters.every(supportedParameter) || !returns.every(supportedParameter)
            || (target.arguments as AstNode[])?.length !== 1 || !(receiver?.nodeType === "Identifier" || (receiver && structMember(receiver)))
            || receiver.typeDescriptions?.typeString !== "address" || !arguments_ || arguments_.length !== parameters.length
            || arguments_.some((argument) => !["Identifier", "Literal"].includes(argument.nodeType ?? "")
              && !(argument.nodeType === "UnaryOperation" && argument.operator === "-"
                && (argument.subExpression as AstNode)?.nodeType === "Literal"
                && (argument.subExpression as AstNode).kind === "number")
              && !integerLimit(argument) && !blockTimestamp(argument) && !structMember(argument) && !builtin(argument) && !staticBytes4(argument))
            || (node.names as unknown[])?.length || node.tryCall) {
            throw new Error("PQABI typed calls currently require an interface cast of an address variable or typed struct field, static address, integer, fixed bytes or bool, one-dimensional scalar arrays, bytes or string arguments and results");
          }
          if (nativeHeight === undefined) throw new Error("PQABI typed call requires nativeAddressContextHeight matching an activated node profile");
          const selector = definition.functionSelector;
          if (typeof selector !== "string" || !/^[0-9a-f]{8}$/.test(selector)) throw new Error("PQABI typed call selector unavailable");
          const options = call.nodeType === "FunctionCallOptions" ? call.options as AstNode[] : [];
          const names = call.nodeType === "FunctionCallOptions" ? call.names as string[] : [];
          const value = options[names.indexOf("value")];
          const callGas = options[names.indexOf("gas")];
          if (names.some((name) => !["value", "gas"].includes(name))
            || options.some((option) => !["Identifier", "Literal"].includes(option.nodeType ?? "")
              && !integerLimit(option) && !blockTimestamp(option) && !structMember(option))) {
            throw new Error("PQABI typed call options currently require simple value/gas expressions or typed struct fields");
          }
          const operation = value ? "callvalue" : ["view", "pure"].includes(String(definition.stateMutability)) ? "staticcall" : "call";
          if (definition.stateMutability === "pure") needsViewBackend = true;
          const lowName = `_${callGas ? "g" : ""}${value ? "v" : operation === "call" ? "k" : "s"}${node.src!.split(":")[2]}`;
          if (returns.length) helpers.set(operation + (callGas ? "gas" : ""), lowName);
          const nativeType = (parameter: AstNode): string => {
            const type = parameter.typeName as AstNode;
            if (type.nodeType === "ArrayTypeName") {
              const name = type.typeDescriptions?.typeString;
              if (!name) throw new Error("PQABI array ABI type unavailable");
              return name.replace(/\baddress\b/g, "uint256");
            }
            return type.name === "address" ? "uint256" : type.name!;
          };
          const declarationType = (parameter: AstNode) => nativeType(parameter)
            + (abiReference(parameter.typeName as AstNode) ? " memory" : "");
          const resultType = returns.map(declarationType).join(", ");
          const decodedType = returns.map(nativeType).join(", ");
          const argumentNames = parameters.map((_, index) => parameters.length === 1 ? "argument" : `argument${index}`);
          const declarations = parameters.map((parameter, index) => `${declarationType(parameter)} ${argumentNames[index]}`);
          const key = `typed:${definition.id}:${operation}:${!!callGas}`;
          let name = helpers.get(key);
          if (!name) {
            name = `_t${node.id!.toString(36)}`;
            helpers.set(key, name);
            if (!returns.length) {
              const opcode = operation === "callvalue" ? "call" : operation;
              const amount = opcode === "call" ? `${value ? "value" : "0"}, ` : "";
              typedDeclarations.set(name, `function ${name}(uint256 target${declarations.length ? ", " + declarations.join(", ") : ""}${value ? ", uint256 value" : ""}${callGas ? ", uint256 callGas" : ""}) ${operation === "staticcall" ? "view " : ""}{ bytes memory data = abi.encodeWithSelector(bytes4(0x${selector})${argumentNames.length ? ", " + argumentNames.join(", ") : ""}); assembly { if lt(number(), ${nativeHeight}) { revert(0, 0) } if iszero(extcodesize(target)) { revert(0, 0) } if iszero(${opcode}(${callGas ? "callGas" : "gas()"}, target, ${amount}add(data, 32), mload(data), 0, 0)) { returndatacopy(0, 0, returndatasize()) revert(0, returndatasize()) } } }`);
            } else {
            typedDeclarations.set(name, `function ${name}(uint256 target${declarations.length ? ", " + declarations.join(", ") : ""}${value ? ", uint256 value" : ""}${callGas ? ", uint256 callGas" : ""}) ${operation === "staticcall" ? "view " : ""}returns (${resultType}) { (bool success, bytes memory output) = ${lowName}(target, ${value ? "value, " : ""}${callGas ? "callGas, " : ""}abi.encodeWithSelector(bytes4(0x${selector})${argumentNames.length ? ", " + argumentNames.join(", ") : ""})); if (!success) { assembly { revert(add(output, 32), mload(output)) } } return abi.decode(output, (${decodedType})); }`);
            }
          }
          const text = `${name}(${read(receiver)}${arguments_.length ? "," + arguments_.map(read).join(",") : ""}${value ? "," + read(value) : ""}${callGas ? "," + read(callGas) : ""})`;
          const [start, length] = node.src!.split(":").map(Number);
          if (Buffer.byteLength(text) > length) throw new Error("unsupported PQABI typed call source range");
          replacements.push({start, length, text: text + " ".repeat(length - Buffer.byteLength(text))});
          visit(node, (child) => { if (child.id !== undefined) handled.add(child.id); });
          return;
        }

        if (member?.nodeType === "MemberAccess" && ["call", "staticcall", "delegatecall"].includes(member.memberName ?? "")
          && ["address", "address payable"].includes(target?.typeDescriptions?.typeString ?? "")
          && (target.nodeType === "Identifier" || internalAddressReceiver(target)
            || ["caller", "origin", "coinbase", "address"].includes(builtin(target) ?? ""))) {
          if (nativeHeight === undefined) throw new Error("PQABI native call requires nativeAddressContextHeight matching an activated node profile");
          const arguments_ = node.arguments as AstNode[];
          const options = call.nodeType === "FunctionCallOptions" ? call.options as AstNode[] : [];
          const names = call.nodeType === "FunctionCallOptions" ? call.names as string[] : [];
          const value = options[names.indexOf("value")];
          const callGas = options[names.indexOf("gas")];
          if (arguments_.length !== 1 || arguments_[0].nodeType !== "Identifier"
            || !arguments_[0].typeDescriptions?.typeString?.startsWith("bytes ")
            || names.some((name) => !["value", "gas"].includes(name))
            || (value && member.memberName !== "call")
            || options.some((option) => !["Identifier", "Literal"].includes(option.nodeType ?? "")
              && !integerLimit(option) && !structMember(option))) {
            throw new Error("PQABI native call currently requires address and bytes variables, with optional simple value/gas expressions or typed struct fields");
          }
          const operation = value ? "callvalue" : member.memberName!;
          const letter = value ? "v" : ({call:"k",staticcall:"s",delegatecall:"d"} as Record<string,string>)[operation];
          const name = `_${callGas ? "g" : ""}${letter}${node.src!.split(":")[2]}`;
          helpers.set(operation + (callGas ? "gas" : ""), name);
          const context = builtin(target);
          let receiver = read(target);
          if (context) {
            const letter = ({caller:"c",origin:"o",coinbase:"b",address:"a"} as Record<string,string>)[context];
            const contextName = `_p${letter}${node.src!.split(":")[2]}`;
            helpers.set(context, contextName);
            receiver = `${contextName}()`;
          }
          const text = `${name}(${receiver},${value ? read(value) + "," : ""}${callGas ? read(callGas) + "," : ""}${read(arguments_[0])})`;
          const [start, length] = node.src!.split(":").map(Number);
          if (Buffer.byteLength(text) > length) throw new Error("unsupported PQABI native call source range");
          replacements.push({start, length, text: text + " ".repeat(length - Buffer.byteLength(text))});
          visit(node, (child) => { if (child.id !== undefined) handled.add(child.id); });
          return;
        }
      }
      const opcode = builtin(node);
      if (!opcode && !staticBytes4(node)) return;
      visit(node, (child) => { if (child.id !== undefined) handled.add(child.id); });
      const [start, length] = node.src!.split(":").map(Number);
      const text = renderContext(node);
      if (Buffer.byteLength(text) > length) throw new Error("unsupported PQABI native context source range");
      replacements.push({ start, length, text: text + " ".repeat(length - Buffer.byteLength(text)) });
    });
    visit(original.sources[path].ast, (node) => {
      if ((node.nodeType === "Identifier" || node.nodeType === "FunctionDefinition")
        && [...helpers.values()].includes(node.name ?? "")) {
        throw new Error("PQABI native context helper name conflicts with source declaration");
      }
    });
    visit(original.sources[path].ast, (node) => {
      if (node.id !== undefined && handled.has(node.id)) return;
      if (node.nodeType === "InlineAssembly"
        || node.nodeType === "FunctionTypeName"
        || (node.nodeType === "NewExpression" && (!abiReference(node.typeName as AstNode) || !supportedAbiValue(node.typeName as AstNode)))
        || (node.nodeType === "ElementaryTypeName" && node.name === "address"
          && node.stateMutability === "payable")
        || (node.nodeType === "Identifier" && ["this", "super"].includes(node.name ?? ""))
        || (node.nodeType === "MemberAccess" && !integerLimit(node) && !blockTimestamp(node) && !structMember(node)
          && !["length", "push", "pop"].includes(node.memberName ?? ""))) {
        throw new Error(`PQABI target does not yet support ${node.nodeType}${node.memberName ? ` .${node.memberName}` : ""} in ${path}; native context/calls require further compiler support`);
      }
      if (node.nodeType === "ElementaryTypeName" && node.name === "address") {
        const [start, length] = node.src!.split(":").map(Number);
        if (length !== 7) throw new Error("unsupported PQABI address source range");
        replacements.push({ start, length, text: "uint256" });
      }
    });
    // Whole-expression edits already render any renamed references they contain.
    longerNames.set(path, overloads.longerNames.get(path)!.filter((edit) =>
      !replacements.some(({ start, length }) => edit.start >= start && edit.start + edit.length <= start + length)));
    let content = Buffer.from(source.content);
    for (const { start, length, text } of replacements.sort((a, b) => b.start - a.start)) {
      content = Buffer.concat([content.subarray(0, start), Buffer.from(text), content.subarray(start + length)]);
    }
    const declarations = [...helpers].map(([opcode, name]) => {
      if (typedDeclarations.has(name)) return typedDeclarations.get(name)!;
      const guard = `if lt(number(), ${nativeHeight}) { revert(0, 0) }`;
      const callGas = opcode.endsWith("gas");
      const callKind = callGas ? opcode.slice(0, -3) : opcode;
      if (["call", "callvalue", "staticcall", "delegatecall"].includes(callKind)) {
        const operation = callKind === "callvalue" ? "call" : callKind;
        const value = operation === "call" ? `${callKind === "callvalue" ? "value" : "0"}, ` : "";
        return `function ${name}(uint256 target, ${callKind === "callvalue" ? "uint256 value, " : ""}${callGas ? "uint256 callGas, " : ""}bytes memory data) ${callKind === "staticcall" ? "view " : ""}returns (bool success, bytes memory output) { uint256 size; assembly { ${guard} success := ${operation}(${callGas ? "callGas" : "gas()"}, target, ${value}add(data, 32), mload(data), 0, 0) size := returndatasize() } output = new bytes(size); assembly { returndatacopy(add(output, 32), 0, size) } }`;
      }
      if (opcode === "code") return `function ${name}(uint256 target) view returns (bytes memory value) { uint256 size; assembly { ${guard} size := extcodesize(target) } value = new bytes(size); assembly { extcodecopy(target, add(value, 32), 0, size) } }`;
      if (opcode === "balance" || opcode === "codehash") {
        return `function ${name}(uint256 target) view returns (${opcode === "codehash" ? "bytes32" : "uint256"} value) { assembly { ${guard} value := ${opcode === "codehash" ? "extcodehash" : "balance"}(target) } }`;
      }
      return `function ${name}() view returns (uint256 value) { assembly { ${guard} value := ${opcode}() } }`;
    }).join("\n");
    sources[path] = { content: content.toString("utf8") + "\n" + declarations };
  }
  if (needsViewBackend) {
    // Typed pure calls use a view STATICCALL helper, and assembly guards read
    // block height. Original source has passed Solidity's purity checks. Lower
    // pure annotations only in backend source, across imports and overrides so
    // transitive callers remain consistent; the public ABI stays original.
    for (const [path, source] of Object.entries(input.sources)) {
      const content = Buffer.from(sources[path].content);
      visit(original.sources[path].ast, (node) => {
        if (node.nodeType !== "FunctionDefinition" || node.stateMutability !== "pure") return;
        const [start, length] = node.src!.split(":").map(Number);
        const bodyStart = (node.body as AstNode | undefined)?.src?.split(":")[0];
        const header = Buffer.from(source.content).subarray(start, bodyStart === undefined ? start + length : Number(bodyStart)).toString("utf8");
        // Skip comments and quoted modifier arguments; AST offsets are bytes.
        const tokens = header.matchAll(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b[A-Za-z_]\w*\b/g);
        const pure = [...tokens].filter((token) => token[0] === "pure");
        if (pure.length !== 1) throw new Error("unsupported PQABI pure annotation source range");
        content.write("view", start + Buffer.byteLength(header.slice(0, pure[0].index)), "utf8");
      });
      sources[path] = {content: content.toString("utf8")};
    }
  }
  const locationEdits = new Map<string, { start: number; length: number; alias: string }[]>();
  for (const [path, longer] of longerNames) {
    const edits = [...longer, ...assemblyGuards.get(path)!];
    let content = Buffer.from(sources[path].content);
    for (const { start, length, alias } of [...edits].sort((a, b) => b.start - a.start)) {
      content = Buffer.concat([content.subarray(0, start), Buffer.from(alias), content.subarray(start + length)]);
    }
    sources[path] = { content: content.toString("utf8") };
    locationEdits.set(original.sources[path].ast.src.split(":")[2], edits);
  }
  const sourceLocation = (location: string) => {
    const [start, length, file] = location.split(":").map(Number);
    const shift = (offset: number) => (locationEdits.get(String(file)) ?? []).reduce((delta, edit) =>
      delta + (edit.start + edit.length <= offset ? Buffer.byteLength(edit.alias) - edit.length : 0), 0);
    const loweredStart = start + shift(start);
    return `${loweredStart}:${start + length + shift(start + length) - loweredStart}:${file}`;
  };
  const lowered = compile({ ...input, sources, settings: { ...input.settings, viaIR: true, outputSelection: selection } });
  for (const [path, contracts] of Object.entries(original.contracts) as [string, Record<string, { abi: unknown; evm: { methodIdentifiers: Record<string, string> } }>][] ) {
    const originalContract = contracts[contractName];
    if (!originalContract) continue;
    const loweredContract = lowered.contracts[path][contractName];
    const selectors = new Map<string, string>();
    for (const [signature, selector] of Object.entries(originalContract.evm.methodIdentifiers)) {
      const alias = overloads.bySelector.get(selector);
      const loweredSignature = signature.replace(/\baddress\b/g, "uint256")
        .replace(/^[^(]+/, alias ?? signature.slice(0, signature.indexOf("(")));
      const loweredSelector = loweredContract.evm.methodIdentifiers[loweredSignature];
      if (!loweredSelector) throw new Error(`missing lowered selector for ${signature}`);
      selectors.set(loweredSelector.toLowerCase(), selector);
    }
    // Restrict restoration to the compiler-generated dispatcher, leaving user
    // assembly switch cases unchanged even when a literal equals a selector.
    const seen = new Map<string, number>();
    let dispatcherIndent: string | undefined;
    let ir = loweredContract.ir.split("\n").map((line: string) => {
      const header = line.match(/^([ \t]*)switch selector[ \t]*$/);
      if (header) dispatcherIndent = header[1];
      if (dispatcherIndent === undefined) return line;
      const leading = line.match(/^[ \t]*/)![0];
      if (line.trim() && (leading.length < dispatcherIndent.length || (leading === dispatcherIndent && line.trimStart().startsWith("default")))) {
        dispatcherIndent = undefined;
        return line;
      }
      if (leading !== dispatcherIndent) return line;
      return line.replace(/^(\s*case )0x([0-9a-fA-F]{1,8})\b/, (match: string, prefix: string, hex: string) => {
        const key = hex.toLowerCase().padStart(8, "0");
        const selector = selectors.get(key);
        if (!selector) return match;
        seen.set(key, (seen.get(key) ?? 0) + 1);
        return `${prefix}0x${selector}`;
      });
    }).join("\n");
    for (const selector of selectors.keys()) {
      if (seen.get(selector) !== 1) throw new Error(`ambiguous or missing PQABI dispatcher selector ${selector}`);
    }
    ir = restoreTopicsAndErrors(ir, original.sources, lowered.sources, sourceLocation);
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
