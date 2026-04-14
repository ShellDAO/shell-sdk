# Changelog

## [0.2.0] — 2026-04-14

### Added
- **API freeze**: `ShellSigner`, `ShellProvider`, and `ShellWallet` are now stable public APIs.
- ML-DSA-65 cross-validation tests confirming wire compatibility with `pqcrypto-dilithium` v0.5 (pk=1952 B, sk=4032 B, sig=3309 B).
- `examples/minimal-dapp`: Node.js (`node-demo.mjs`) and browser (`browser-demo.html`) integration examples.
- JSDoc complete for all public-facing exports.
- `MlDsa65Adapter` round-trip sign+verify test.

### Changed
- `adapters.ts`: both `"Dilithium3"` and `"MlDsa65"` aliases now explicitly document ML-DSA-65 (FIPS 204) wire compatibility with the chain's Dilithium3 verifier.
- `hashTransaction()` canonical RLP field ordering aligned with `shell-chain` deserialiser.
- Package root export surface narrowed to stable application-facing APIs.



- **Signing compatibility confirmed**: `pqcrypto-dilithium` v0.5 (shell-chain) implements FIPS 204 ML-DSA-65, byte-identical with `@noble/post-quantum` `ml_dsa65`. The `Dilithium3` alias in the SDK now documents this equivalence explicitly (pk=1952, sk=4032, sig=3309 bytes).
- add cross-validation tests verifying ML-DSA-65 key/signature sizes against chain expectations
- add `MlDsa65Adapter` round-trip sign+verify test
- clarify `adapters.ts` JSDoc: both `"Dilithium3"` and `"MlDsa65"` route to ML-DSA-65 (FIPS 204) which is wire-compatible with the chain's Dilithium3 verifier

## 0.2.0-rc.1

- add Browser and Node integration tests for signer, keystore, and provider flows
- add Rust compatibility vectors for address derivation and transaction hashing
- fix `hashTransaction()` to match the Rust node's canonical RLP field ordering
- fix `hashTransaction()` to accept canonical `pq1...` recipient addresses
- narrow the package root export surface to stable application-facing APIs
- document extension background flow, minimal dApp usage, and release checklist
