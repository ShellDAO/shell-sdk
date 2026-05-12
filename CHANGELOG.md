# Changelog

## [0.8.2] — 2026-05-12

### Changed
- Compatibility release aligned with `shell-chain v0.22.2`.
- No public API changes; version bump ensures npm consumers receive the
  latest wire-format fixes shipped in `shell-chain v0.22.2` (STARK
  drain-frontier loop fix, contiguous-frontier reseed anchor).

## [0.8.1] — 2026-05-10

### Changed
- Version bump for the next coordinated ShellDAO release cut.

## [0.8.0] — 2026-05-06

### Added
- `ShellDecodedProofInput` type: structured proof amendment payload decoded
  from `starkReward` settlement transactions (requires `shell-chain v0.22+`).
  Fields: `layer`, `blockNumber`, `startBlock`, `endBlock`, `nSigs`,
  `compressedSize`, `originalSize`, `settlementTxHash`.
- `ShellRpcTransaction.decodedInput?: ShellDecodedProofInput | null` — filled
  by the node for `starkReward` system transactions; `null`/absent otherwise.
- `ShellDecodedProofInput` exported from the package root.

### Changed
- Aligned with `shell-chain v0.22.0` RPC surface.

## [0.7.1] — 2026-05-06

### Added
- Typed Shell RPC reward metadata for address-history and transaction-summary
  responses, including block gas rewards, STARK rewards, reward layers,
  source hashes, and compression accounting fields.

### Changed
- Preserve pq1-only compatibility from `0.7.0` while aligning the SDK type
  surface with `shell-chain v0.21.1`.

## [0.7.0] — 2026-04-30 ⚠️ BREAKING

### Breaking Changes — F-PQ1-ONLY (pq1 bech32m addresses everywhere)

This is a **breaking release**. All `0x` hex address support has been removed.

#### Removed
- `hexAddress()` / `hexAddressFromPubkey()` exports deleted — use `pq1Address()` instead.
- `normalizePqAddress()` no longer accepts `0x...` hex strings — only `pq1...` bech32m.
- Keystore `address` field: `encryptKeystore()` now always emits `pq1...` bech32m (was `0x...` hex).
- `decryptKeystore()` rejects keystores with `0x` address fields (use `shell-node key migrate` first).

#### Added
- `pq1Address(pubkey, sigType)` — canonical address derivation returning `pq1...` bech32m string.
- SK-only keystore format: `encryptKeystore` stores only the secret key in ciphertext (no pk concatenation), matching `shell-node key generate` output for full cross-language compatibility.
- Full cross-format compatibility: SDK keystores are now byte-for-byte compatible with Rust CLI keystores.

#### Updated
- All SDK test fixtures regenerated with `pq1` addresses.
- `SIGNATURE_TYPE_IDS.MlDsa65 = 1` (was incorrectly aliased to `0` in v0.6.x).
- ML-DSA-65 (FIPS 204) via `@noble/post-quantum` — real implementation, not a Dilithium3 alias.

### Migration Guide
```js
// Before (0.6.x)
import { hexAddress } from 'shell-sdk';
const addr = hexAddress(pubkey, sigType); // "0x..."

// After (0.7.0)
import { pq1Address } from 'shell-sdk';
const addr = pq1Address(pubkey, sigType); // "pq1..."
```

For existing keystores with `0x` addresses: run `shell-node key migrate <keystore.json>` to upgrade to pq1 format.

### Compatibility
- Requires `shell-chain v0.21.0+` (pq1-only RPC).
- Not backwards-compatible with SDK `0.6.x` address handling.

## [0.6.0] — 2026-04-27

### Added — ML-DSA-65 (FIPS 204) + Keystore SK-only format

#### Crypto (`keystore.ts`, `address.ts`)
- **`MlDsa65Adapter`**: real FIPS 204 ML-DSA-65 implementation via `@noble/post-quantum`.
- **`SIGNATURE_TYPE_IDS.MlDsa65 = 1`**: ML-DSA-65 is now a distinct algorithm (was aliased to Dilithium3=0).
- **SK-only keystore**: `encryptKeystore` stores only secret key bytes in ciphertext, matching `shell-node` CLI format. Cross-language compatible.
- **`decryptCliKeystore`** helper removed — standard `decryptKeystore` now handles CLI keystores.

#### Compatibility
- Fully cross-language compatible: Rust CLI keystores decryptable by SDK and vice versa.
- `shell-chain v0.20.0+` required for ML-DSA-65 transaction signing.

## [0.5.0] — 2026-04-26

### Added — AA Phase 2 (matches `shell-chain v0.19.0`)

#### Types (`types.ts`)
- **`SessionAuth`** interface: session PQ key authorization struct with `session_pubkey`, `session_algo`, `target?`, `value_cap`, `expiry_block`, `root_signature`, `session_signature`.
- **`GuardianConfig`** interface: on-chain guardian set descriptor.
- **`RecoveryProposal`** interface: active recovery proposal with votes and maturity block.
- **`AaBundle`** extended: added `paymaster_context?: number[] | null` (contract paymaster opaque bytes) and `session_auth?: SessionAuth | null` (session key authorization).
- Constants: `AA_MAX_PAYMASTER_CONTEXT = 256`, `AA_SESSION_KEY_GAS_SURCHARGE = 20_000`.

#### Transaction builders (`transactions.ts`)
- **`buildContractPaymasterTransaction`**: builds an AA batch tx with a contract paymaster (sets `paymaster_context`). Mutually exclusive with `paymaster_signature`.
- **`buildSessionKeyTransaction`**: builds an AA batch tx authorized by a session key (sets `session_auth`).
- **`hashBatchTransaction`**: updated signing hash to include `paymaster_context` as the 3rd RLP field in `bundleSigningFields`, matching `shell-chain` `AaBundle::encode_for_signing`.

#### System contract calldata (`system-contracts.ts`)
- **`setGuardiansSelector`** + **`encodeSetGuardiansCalldata`**: `setGuardians(address[],uint8,uint64)`.
- **`submitRecoverySelector`** + **`encodeSubmitRecoveryCalldata`**: `submitRecovery(address,bytes,uint8)`.
- **`executeRecoverySelector`** + **`encodeExecuteRecoveryCalldata`**: `executeRecovery(address)`.
- **`cancelRecoverySelector`** + **`encodeCancelRecoveryCalldata`**: `cancelRecovery(address)`.

### Compatibility
- Fully backwards-compatible with SDK `0.4.x` usage. All new fields are optional.
- New AA Phase 2 features require `shell-chain v0.19.0+`.

## [0.4.1] — 2026-04-25

### Changed
- `estimateBatch` JSDoc updated to reflect snake_case field names (`total_gas`, `inner_gas`) aligning with `shell-chain v0.18.1` wire format.

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
