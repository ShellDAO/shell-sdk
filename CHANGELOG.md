# Changelog

## [0.4.0] — 2026-05-16

### Added
- **Native AA batch transactions** (`tx_type = 0x7E`): `buildBatchTransaction`, `buildSponsoredTransaction`, `buildInnerTransfer`, `buildInnerCall`, `hashBatchTransaction` in `transactions.ts`.
  - `hashBatchTransaction` computes the `batch_signing_hash` (domain `0x42 || RLP(tx) || RLP(bundle)`), required for signing AA bundle txs.
- **AA types** (`types.ts`): `AaInnerCall`, `AaBundle`, `ShellBatchInnerCallRequest`, `ShellEstimateBatchRequest`, `ShellEstimateBatchResult`, `ShellBatchInnerGas`, `ShellPaymasterPolicy`, `ShellIsSponsoredResult`.
  - Constants: `AA_BUNDLE_TX_TYPE = 0x7e`, `AA_MAX_INNER_CALLS = 16`.
  - `SignedShellTransaction` now has optional `aa_bundle?: AaBundle` field.
- **AA provider methods** (`provider.ts`): `estimateBatch`, `getPaymasterPolicy`, `isSponsored`, `verifyWitnessRoot`.
- **ML-DSA-65 canonical naming** (`signer.ts`): `"ML-DSA-65"` is now the first-class `SignatureTypeName` (FIPS 204). `"Dilithium3"` and `"MlDsa65"` remain as compatibility aliases, all mapping to algorithm ID `0`.
  - `KEY_TYPE_TO_SIGNATURE_TYPE` now maps all ML-DSA-65 variants (including `"dilithium3"`) to `"ML-DSA-65"`.
- **New exports** (`index.ts`): `SIGNATURE_TYPE_IDS`, `KEY_TYPE_TO_SIGNATURE_TYPE`, all new AA builders and types.

### Changed
- `SIGNATURE_TYPE_IDS`: `"MlDsa65"` now maps to `0` (was `1`) — aligns with chain algorithm ID; no wire-format change.

### Compatibility
- Fully backwards-compatible with `shell-chain v0.17.0` and prior SDK `0.3.x` usage.
- AA fields (`aa_bundle`, new RPC methods) are only active on `shell-chain v0.18.0+`.

## [0.3.1] — 2026-04-23

### Changed
- Publish a patch release to carry forward the current `shell-chain v0.17.0` compatibility surface.
- Keep sdk and chain versioning independent: the SDK now advances to `0.3.1` while remaining aligned with the chain's `0.17.0` RPC and signature behavior.

## [0.3.0] — 2026-04-22

### Added
- **API freeze**: `ShellSigner`, `ShellProvider`, and `ShellWallet` are now stable public APIs.
- ML-DSA-65 cross-validation tests confirming wire compatibility with `pqcrypto-dilithium` v0.5 (pk=1952 B, sk=4032 B, sig=3309 B).
- `examples/minimal-dapp`: Node.js (`node-demo.mjs`) and browser (`browser-demo.html`) integration examples.
- JSDoc complete for all public-facing exports.
- `MlDsa65Adapter` round-trip sign+verify test.
- `getNodeInfo()`, `getWitness()`, and `getStorageProfile()` helpers for Shell-specific node capabilities.

### Changed
- `adapters.ts`: both `"Dilithium3"` and `"MlDsa65"` aliases now explicitly document ML-DSA-65 (FIPS 204) wire compatibility with the chain's Dilithium3 verifier.
- `hashTransaction()` canonical RLP field ordering aligned with `shell-chain` deserialiser.
- Package root export surface narrowed to stable application-facing APIs.
- NodeInfo example version string now reflects current node naming (`shell-node/0.17.0`) without tying the SDK package version to the chain version.

## 0.2.0-rc.1

- add Browser and Node integration tests for signer, keystore, and provider flows
- add Rust compatibility vectors for address derivation and transaction hashing
- fix `hashTransaction()` to match the Rust node's canonical RLP field ordering
- fix `hashTransaction()` to accept canonical `pq1...` recipient addresses
- narrow the package root export surface to stable application-facing APIs
- document extension background flow, minimal dApp usage, and release checklist
