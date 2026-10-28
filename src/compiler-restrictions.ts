/** Reject classical recovery before emitting bytecode for Shell Chain. */
export function rejectEcrecover(sources: Record<string, { ast?: unknown }>): void {
  for (const [path, source] of Object.entries(sources)) {
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      const type = node.typeDescriptions as { typeIdentifier?: string } | undefined;
      // Use the resolved builtin type, not its spelling: user functions may
      // shadow ecrecover, and comments/string literals are harmless.
      if (node.nodeType === "Identifier"
        && type?.typeIdentifier?.startsWith("t_function_ecrecover_")) {
        const offset = String(node.src).split(":")[0];
        throw new Error(`Shell Chain does not support the Solidity ecrecover builtin (${path}, byte ${offset}). Use post-quantum signature verification instead.`);
      }
      for (const child of Object.values(node)) visit(child);
    };
    visit(source.ast);
  }
}
