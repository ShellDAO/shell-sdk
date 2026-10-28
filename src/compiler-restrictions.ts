/** Reject unsupported Solidity builtins before returning a Shell artifact. */
export function rejectUnsupportedBuiltins(sources: Record<string, { ast?: unknown }>): void {
  for (const [path, source] of Object.entries(sources)) {
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      const type = node.typeDescriptions as { typeIdentifier?: string } | undefined;
      // Resolved types distinguish builtins from shadowed user functions;
      // comments and string literals are harmless.
      if (node.nodeType === "Identifier") {
        const builtin = ["ecrecover", "sha256", "ripemd160"].find((name) =>
          type?.typeIdentifier?.startsWith(`t_function_${name}_`));
        if (builtin) {
          const offset = String(node.src).split(":")[0];
          throw new Error(`Shell Chain does not support the Solidity ${builtin} builtin (${path}, byte ${offset}). Use Shell's PQ precompiles explicitly instead.`);
        }
      }
      for (const child of Object.values(node)) visit(child);
    };
    visit(source.ast);
  }
}
