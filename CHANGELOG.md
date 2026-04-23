# Changelog

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
