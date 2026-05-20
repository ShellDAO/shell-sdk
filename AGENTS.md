# AGENTS.md — shell-sdk

Local single-source-of-truth for AI agents working inside this repository.
This file is fully self-contained; it does not reference any file outside
this submodule.

## What this repo is

TypeScript client SDK for **shell-chain** — a post-quantum-native Layer 1
node. The SDK currently ships at **v0.8.x** and tracks the **v0.22.x**
shell-chain RPC surface.

Provides:

- viem-based PQ signers (Dilithium3, ML-DSA-65)
- Account Abstraction bundle builders (AaBundle, tx_type `0x7E`)
- RPC provider helpers (mirroring the chain's JSON-RPC surface)
- Address utilities for Bech32m `pq1...` derivation

## Quick commands

```bash
npm install
npm run build      # tsc -> dist/
npm test           # vitest
npm run lint       # eslint
npm run typecheck
```

## Cardinal rules

1. **Wire-format fidelity**. PQ signing logic must produce the exact bytes
   that shell-chain accepts. Domain separation, Bech32m HRP (`pq1`), and
   AaBundle field order must match the chain's wire spec — never invent
   client-side variants. When in doubt, generate test vectors against a
   running shell-chain node and compare bytes.
2. **No private-key leakage**. Never log secret-key material; never embed
   secret keys in source. Keystores follow the chain's keystore JSON v1
   format (argon2id KDF + XChaCha20-Poly1305 AEAD; ciphertext is the
   secret key only).
3. **All public types re-exported from `src/index.ts`**. Downstream
   consumers import only from the package root.
4. **Versioning is paired with chain releases**. A breaking RPC change in
   shell-chain bumps the SDK minor; a breaking TypeScript API change bumps
   the SDK minor independently. Document the chain version this SDK
   release was verified against in CHANGELOG.md.

## Quality gates

A change is mergeable when:

- `npm run lint` passes (eslint clean)
- `npm run typecheck` passes (no `any` regressions in public types)
- `npm test` passes (vitest)
- `npm run build` produces a clean `dist/` with type declarations
- New public API has unit tests + a README usage example

## Commit / PR conventions

- **Conventional Commits**: `<type>(<scope>): <subject>` —
  `type ∈ {feat, fix, docs, test, refactor, chore, ci}`.
- Branches: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`,
  `release/v<version>`.
- Commit messages and code comments are **English**.
- AI-authored commits include a `Co-authored-by: Copilot
  <223556219+Copilot@users.noreply.github.com>` trailer; AI-authored
  PR/Issue bodies start with the line
  `🤖 本 [Issue/PR] 由 AI Agent 创建` (literal template — do not
  translate).

## Things to never commit

Secrets, `.env`, generated `dist/`, `node_modules/`, any keystore JSON,
any seed phrase or raw secret key in any encoding.

## Tool pointers (this file is the SSoT)

- `CLAUDE.md` → read this file
- `.cursor/rules/main.mdc` → read this file
- `.github/copilot-instructions.md` → read this file
