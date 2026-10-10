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
  let hasAddress = false;
  for (const source of Object.values(original.sources) as { ast: unknown }[]) {
    visit(source.ast, (node) => {
      if ((node.nodeType === "ElementaryTypeName" && node.name === "address") || builtin(node)) hasAddress = true;
    });
  }
  if (!hasAddress) return compile(input);

  const externalFunctions = new Map<number, AstNode>();
  for (const source of Object.values(original.sources) as AstSource[]) {
    visit(source.ast, (node) => {
      if (node.nodeType === "FunctionDefinition") externalFunctions.set(node.id!, node);
    });
  }
  const sources: CompilerInput["sources"] = {};
  for (const [path, source] of Object.entries(input.sources)) {
    const replacements: { start: number; length: number; text: string }[] = [];
    const handled = new Set<number>();
    const helpers = new Map<string, string>();
    const typedDeclarations = new Map<string, string>();
    visit(original.sources[path].ast, (node) => {
      if (node.id !== undefined && handled.has(node.id)) return;
      if (node.nodeType === "FunctionCall") {
        const call = node.expression as AstNode;
        const member = (call?.nodeType === "FunctionCallOptions" ? call.expression : call) as AstNode;
        const target = member?.expression as AstNode;
        if (call?.nodeType === "MemberAccess" && target?.nodeType === "FunctionCall"
          && target.kind === "typeConversion" && target.typeDescriptions?.typeString?.startsWith("contract ")) {
          const definition = externalFunctions.get(call.referencedDeclaration as number);
          const parameters = (definition?.parameters as AstNode)?.parameters as AstNode[] | undefined;
          const returns = (definition?.returnParameters as AstNode)?.parameters as AstNode[] | undefined;
          const receiver = (target.arguments as AstNode[])?.[0];
          const argument = (node.arguments as AstNode[])?.[0];
          const addressParameter = (parameter: AstNode) => (parameter.typeName as AstNode)?.name === "address"
            && (parameter.typeName as AstNode)?.stateMutability !== "payable";
          if (!definition || parameters?.length !== 1 || returns?.length !== 1
            || !(addressParameter(parameters[0]) || ["uint", "uint256"].includes(String((parameters[0].typeName as AstNode)?.name))) || !(addressParameter(returns[0]) || (returns[0].typeName as AstNode)?.name === "bytes32")
            || (target.arguments as AstNode[])?.length !== 1 || receiver?.nodeType !== "Identifier"
            || receiver.typeDescriptions?.typeString !== "address" || (node.arguments as AstNode[])?.length !== 1
            || (!["Identifier", "Literal"].includes(argument?.nodeType ?? "") && !integerLimit(argument))
            || (node.names as unknown[])?.length || node.tryCall) {
            throw new Error("PQABI typed calls currently require an interface cast of an address variable, one address or uint256 argument and one address or bytes32 result");
          }
          if (nativeHeight === undefined) throw new Error("PQABI typed call requires nativeAddressContextHeight matching an activated node profile");
          const selector = definition.functionSelector;
          if (typeof selector !== "string" || !/^[0-9a-f]{8}$/.test(selector)) throw new Error("PQABI typed call selector unavailable");
          const operation = ["view", "pure"].includes(String(definition.stateMutability)) ? "staticcall" : "call";
          const lowName = `_${operation === "call" ? "k" : "s"}${node.src!.split(":")[2]}`;
          helpers.set(operation, lowName);
          const resultType = addressParameter(returns[0]) ? "uint256" : "bytes32";
          const key = `typed:${definition.id}`;
          let name = helpers.get(key);
          if (!name) {
            name = `_t${node.id!.toString(36)}`;
            helpers.set(key, name);
            typedDeclarations.set(name, `function ${name}(uint256 target, uint256 value) ${operation === "staticcall" ? "view " : ""}returns (${resultType}) { (bool success, bytes memory output) = ${lowName}(target, abi.encodeWithSelector(bytes4(0x${selector}), value)); if (!success) { assembly { revert(add(output, 32), mload(output)) } } return abi.decode(output, (${resultType})); }`);
          }
          const read = (argument: AstNode) => {
            const [start, length] = argument.src!.split(":").map(Number);
            return Buffer.from(source.content).subarray(start, start + length).toString("utf8");
          };
          const text = `${name}(${read(receiver)},${read(argument)})`;
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
          const value = options[0];
          if (arguments_.length !== 1 || arguments_[0].nodeType !== "Identifier"
            || !arguments_[0].typeDescriptions?.typeString?.startsWith("bytes ")
            || names.length > 1 || (names.length === 1 && (names[0] !== "value" || member.memberName !== "call"))
            || (value && !["Identifier", "Literal"].includes(value.nodeType ?? ""))) {
            throw new Error("PQABI native call currently requires address and bytes variables, with an optional simple value");
          }
          const read = (argument: AstNode) => {
            const [start, length] = argument.src!.split(":").map(Number);
            return Buffer.from(source.content).subarray(start, start + length).toString("utf8");
          };
          const operation = value ? "callvalue" : member.memberName!;
          const letter = value ? "v" : ({call:"k",staticcall:"s",delegatecall:"d"} as Record<string,string>)[operation];
          const name = `_${letter}${node.src!.split(":")[2]}`;
          helpers.set(operation, name);
          const context = builtin(target);
          let receiver = read(target);
          if (context) {
            const letter = ({caller:"c",origin:"o",coinbase:"b",address:"a"} as Record<string,string>)[context];
            const contextName = `_p${letter}${node.src!.split(":")[2]}`;
            helpers.set(context, contextName);
            receiver = `${contextName}()`;
          }
          const text = `${name}(${receiver},${value ? read(value) + "," : ""}${read(arguments_[0])})`;
          const [start, length] = node.src!.split(":").map(Number);
          if (Buffer.byteLength(text) > length) throw new Error("unsupported PQABI native call source range");
          replacements.push({start, length, text: text + " ".repeat(length - Buffer.byteLength(text))});
          visit(node, (child) => { if (child.id !== undefined) handled.add(child.id); });
          return;
        }
      }
      const opcode = builtin(node);
      if (!opcode) return;
      if (nativeHeight === undefined) {
        throw new Error("PQABI target does not yet support native context without nativeAddressContextHeight matching an activated node profile");
      }
      const fileId = node.src!.split(":")[2];
      const helperName = (operation: string) => {
        const letter = ({caller: "c", origin: "o", coinbase: "b", address: "a", balance: "l", codehash: "h", code: "x"} as Record<string, string>)[operation];
        const name = `_${["balance", "codehash", "code"].includes(operation) ? "" : "p"}${letter}${fileId}`;
        helpers.set(operation, name);
        return name;
      };
      const member = ["balance", "codehash", "code"].includes(opcode);
      const name = helperName(opcode);
      visit(node, (child) => { if (child.id !== undefined) handled.add(child.id); });
      const [start, length] = node.src!.split(":").map(Number);
      const expression = node.expression as AstNode;
      const [receiverStart, receiverLength] = member ? expression.src!.split(":").map(Number) : [0, 0];
      const receiverOpcode = member ? builtin(expression) : undefined;
      const receiver = receiverOpcode ? `${helperName(receiverOpcode)}()`
        : member ? Buffer.from(source.content).subarray(receiverStart, receiverStart + receiverLength).toString("utf8") : "";
      const text = `${name}(${receiver})`;
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
        || node.nodeType === "FunctionTypeName" || node.nodeType === "NewExpression"
        || (node.nodeType === "ElementaryTypeName" && node.name === "address"
          && node.stateMutability === "payable")
        || (node.nodeType === "Identifier" && ["this", "super"].includes(node.name ?? ""))
        || (node.nodeType === "MemberAccess" && !integerLimit(node)
          && !["length", "push", "pop"].includes(node.memberName ?? ""))) {
        throw new Error(`PQABI target does not yet support ${node.nodeType}${node.memberName ? ` .${node.memberName}` : ""} in ${path}; native context/calls require further compiler support`);
      }
      if (node.nodeType === "ElementaryTypeName" && node.name === "address") {
        const [start, length] = node.src!.split(":").map(Number);
        if (length !== 7) throw new Error("unsupported PQABI address source range");
        replacements.push({ start, length, text: "uint256" });
      }
    });
    let content = Buffer.from(source.content);
    for (const { start, length, text } of replacements.sort((a, b) => b.start - a.start)) {
      content = Buffer.concat([content.subarray(0, start), Buffer.from(text), content.subarray(start + length)]);
    }
    const declarations = [...helpers].map(([opcode, name]) => {
      if (typedDeclarations.has(name)) return typedDeclarations.get(name)!;
      const guard = `if lt(number(), ${nativeHeight}) { revert(0, 0) }`;
      if (["call", "callvalue", "staticcall", "delegatecall"].includes(opcode)) {
        const operation = opcode === "callvalue" ? "call" : opcode;
        const value = operation === "call" ? `${opcode === "callvalue" ? "value" : "0"}, ` : "";
        return `function ${name}(uint256 target, ${opcode === "callvalue" ? "uint256 value, " : ""}bytes memory data) ${opcode === "staticcall" ? "view " : ""}returns (bool success, bytes memory output) { uint256 size; assembly { ${guard} success := ${operation}(gas(), target, ${value}add(data, 32), mload(data), 0, 0) size := returndatasize() } output = new bytes(size); assembly { returndatacopy(add(output, 32), 0, size) } }`;
      }
      if (opcode === "code") return `function ${name}(uint256 target) view returns (bytes memory value) { uint256 size; assembly { ${guard} size := extcodesize(target) } value = new bytes(size); assembly { extcodecopy(target, add(value, 32), 0, size) } }`;
      if (opcode === "balance" || opcode === "codehash") {
        return `function ${name}(uint256 target) view returns (${opcode === "codehash" ? "bytes32" : "uint256"} value) { assembly { ${guard} value := ${opcode === "codehash" ? "extcodehash" : "balance"}(target) } }`;
      }
      return `function ${name}() view returns (uint256 value) { assembly { ${guard} value := ${opcode}() } }`;
    }).join("\n");
    sources[path] = { content: content.toString("utf8") + "\n" + declarations };
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
