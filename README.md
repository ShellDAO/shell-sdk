# shell-sdk

**TypeScript / JavaScript SDK for Shell Chain** — build quantum-safe dApps on the PQVM-native post-quantum blockchain secured before Q-Day.

[![Node ≥ 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![ESM only](https://img.shields.io/badge/module-ESM-blue)](https://nodejs.org/api/esm.html)

---

> **V2 signing release candidate: 0.14.0-rc.3**
>
> This source uses V2 transaction signing with canonical access-list commitments.
> The published `shell-sdk@0.13.0` package uses V1. Match the SDK to the node's
> signing format; mixing these versions causes signature rejection. This candidate
> was verified against [shell-chain source `e5e759c`](https://github.com/ShellDAO/shell-chain/commit/e5e759c68948e30ccff671bfe9cb7041f0bbec10),
> not the older `v0.27.4` release tag or the public testnet. See the
> [compatibility notes](CHANGELOG.md#0140-rc2--unreleased) and
> [PQ-HD recovery correction](CHANGELOG.md#0140-rc3--2026-10-23) before upgrading.


## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Architecture overview](#architecture-overview)
- [Module reference](#module-reference)
  - [Types](#types)
  - [Addresses](#addresses)
  - [Provider / RPC](#provider--rpc)
  - [Signer & Adapters](#signer--adapters)
  - [Transaction builders](#transaction-builders)
  - [Contract development](#contract-development)
  - [System contracts](#system-contracts)
  - [Keystore](#keystore)
- [End-to-end examples](#end-to-end-examples)
  - [Wallet extension background flow](#wallet-extension-background-flow)
  - [Minimal dApp flow](#minimal-dapp-flow)
- [Key rotation](#key-rotation)
- [Error handling](#error-handling)
- [TypeScript types reference](#typescript-types-reference)
- [Compatibility](#compatibility)
- [Release checklist](#release-checklist)
- [Chain reference](#chain-reference)

---

## Features

- **Post-quantum signing** — ML-DSA-65 (FIPS 204) and SLH-DSA-SHA2-256f (FIPS 205)
- **Shell addresses** — `0x`-prefixed 64-character lowercase hex (full 32-byte BLAKE3) derived from PQ public keys
- **Native account abstraction** — key rotation and custom validation code via system contracts
- **viem integration** — standard Ethereum JSON-RPC methods via a typed `PublicClient`
- **Smart contract helpers** — compile Solidity, deploy Shell contracts, write transactions, read with `eth_call`, and wait for receipts
- **Shell-specific RPC** — `shell_getPqPubkey`, `shell_sendTransaction`, RPC v2 snapshot/range/summary helpers, governance/status wrappers, and witness/STARK proof inspection
- **Reward-aware history types** — block/address transaction summaries expose readable `shellType`, `rewardKind`, and STARK reward metadata (`rewardLayer`, `rewardSourceHash`, `originalSize`, `compressedSize`)
- **Node introspection** — `getNodeInfo()` returns version, block height, peer count, and storage profile; `getWitness()` fetches raw PQ signatures for any block
- **Encrypted keystore** — argon2id KDF + xchacha20-poly1305 cipher; compatible with the Shell CLI

---

## Installation

The default registry installation below currently selects the stable V1 release.
For a V2 node, opt in explicitly to the published candidate with
`npm install shell-sdk@0.14.0-rc.3`. Prereleases use the `next` channel and do not
replace `latest`. See the [contract guide](https://shell.org/zh/docs/smart-contracts)
for a verified source-build workflow.

```bash
# npm
npm install shell-sdk

# yarn
yarn add shell-sdk

# pnpm
pnpm add shell-sdk
```

> **Requires Node.js ≥ 18** for the built-in `fetch` API and `WebCrypto` (`crypto.getRandomValues`).

---

## Quick start

Send a SHELL transfer in ~10 lines:

```typescript
import { MlDsa65Adapter } from "shell-sdk/adapters";
import { createShellProvider } from "shell-sdk/provider";
import { ShellSigner } from "shell-sdk/signer";
import { buildTransferTransaction } from "shell-sdk/transactions";
import { parseEther } from "viem";

const adapter = MlDsa65Adapter.generate();
const signer  = new ShellSigner("MlDsa65", adapter);
const from    = signer.getAddress(); // 0x… (64-char hex)

const provider = createShellProvider();
const nonce    = await provider.client.getTransactionCount({ address: from });

const tx       = buildTransferTransaction({ chainId: 424242, nonce, to: "0x…", value: parseEther("1") });
const signed   = await signer.buildSignedTransaction({ tx });
const hash     = await provider.sendTransaction(signed);
console.log("tx hash:", hash);
```

---

## HD wallet recovery

Use `npm install shell-sdk@0.14.0-rc.3` for the corrected recovery behavior and
`mnemonicToSeedLegacy` helper below. This is a V2 signing package; match the
network signing format before sending transactions.

Shell PQ-HD v1 normalizes recovery phrases with NFKD, lowercase and single
spaces. BIP-39 passphrases use NFKD while preserving their case and spaces.
After securely collecting `recoveryPhrase` and `passphrase`, derive an account:

```ts
import { deriveAccount, mnemonicToSeed, mnemonicToSeedLegacy } from "shell-sdk";

const seed = mnemonicToSeed(recoveryPhrase, passphrase);
const account = deriveAccount(seed, "ml-dsa-65", 0, 0, 0);
seed.fill(0);
```

SDK 0.14.0-rc.2 and earlier retained boundary spaces in recovery phrases and
did not normalize Unicode passphrases. If those inputs created an existing
wallet, recover its previous address with the original input strings:

```ts
const previousSeed = mnemonicToSeedLegacy(originalPhrase, originalPassphrase);
const previousAccount = deriveAccount(previousSeed, "ml-dsa-65", 0, 0, 0);
previousSeed.fill(0);
```

Match the known wallet address before using the recovered account. This
compatibility function reproduces the previous SDK derivation; use
`mnemonicToSeed` for new wallets. Existing encrypted seeds and account keys
remain usable without conversion. Never log recovery phrases, seeds or account
secret keys.

## Architecture overview

### PQ addresses

Shell Chain uses **`0x`-prefixed 64-character lowercase hex** addresses — the full 32-byte BLAKE3 hash of the PQ public key with a one-byte algorithm tag:

```
address_bytes  = BLAKE3(algo_id || public_key)   // full 32 bytes, no truncation
address_string = "0x" + hex_lower(address_bytes)
```

Algorithm IDs: `Dilithium3=0`, `MlDsa65=1`, `SphincsSha2256f=2`.

There is no Bech32m/`pq1…` encoding and no separate version byte: Shell-Chain is a clean-slate chain with no backward bridge to any 20-byte Ethereum address model.

### Native account abstraction (AA)

Every account on Shell Chain supports two system-contract operations via the **AccountManager** (`0x…0002`):

| Operation | Description |
|---|---|
| `rotateKey` | Replace the signing key associated with an address |
| `setValidationCode` | Attach a custom EVM validation contract (smart account) |
| `clearValidationCode` | Revert to the default PQ key validation |

These are sent as ordinary transactions whose `to` field is the AccountManager address.

### System contracts

| Name | Address |
|---|---|
| ValidatorRegistry | `0x0000000000000000000000000000000000000000000000000000000000000001` |
| AccountManager   | `0x0000000000000000000000000000000000000000000000000000000000000002` |

---

## Module reference

The package root (`shell-sdk`) is the **stable surface** for typical app usage. Lower-level constants and helpers that are more likely to change remain available from subpath imports such as `shell-sdk/signer` and `shell-sdk/transactions`.

### Types

Defined in `src/types.ts`. All types are re-exported from the package root.

| Type | Description |
|---|---|
| `HexString` | Template-literal type `0x${string}` |
| `AddressLike` | Any string accepted as an address |
| `SignatureTypeName` | `"ML-DSA-65" \| "Dilithium3" \| "MlDsa65" \| "SphincsSha2256f"` |
| `ShellTransactionRequest` | Wire format for a Shell transaction |
| `ShellSignature` | `{ sig_type, data: number[] }` |
| `SignedShellTransaction` | Complete signed transaction ready to broadcast |
| `ShellAccessListItem` | EIP-2930 access list entry |
| `ShellKnownRpcTxType` | Literal union of known Shell RPC transaction kinds |
| `ShellRpcTransactionSummary` | Lightweight transaction summary with Shell reward metadata |
| `ShellTxByAddressPage` | Paginated address history response with effective `fromBlock`/`toBlock` range |
| `ShellKdfParams` | argon2id parameters inside a keystore |
| `ShellCipherParams` | xchacha20-poly1305 nonce inside a keystore |
| `ShellEncryptedKey` | Full encrypted keystore file structure |

---

### Addresses

`import { … } from "shell-sdk/address"`

#### Constants

| Export | Value | Description |
|---|---|---|
| `SHELL_ADDRESS_LENGTH` | `32` | Address bytes (full BLAKE3 output) |

#### Functions

| Function | Signature | Description |
|---|---|---|
| `bytesToShellAddress` | `(bytes: Uint8Array) → string` | Encode 32 raw bytes as a `0x`-prefixed 64-char hex address |
| `shellAddressToBytes` | `(address: string) → Uint8Array` | Decode a `0x…` Shell address to its 32 raw bytes |
| `normalizeShellAddress` | `(address: string) → string` | Validate and lowercase a `0x…` Shell address |
| `deriveShellAddressFromPublicKey` | `(pk, algoId) → string` | Derive a 32-byte `0x…` Shell address from a raw PQ public key |
| `isShellAddress` | `(address: string) → boolean` | Return `true` if the string is a valid 32-byte `0x…` Shell address |

Legacy aliases (`bytesToPqAddress`, `pqAddressToBytes`, `normalizePqAddress`, `derivePqAddressFromPublicKey`, `isPqAddress`) remain exported but are deprecated — they now operate on the same 32-byte `0x…` format.

**Examples:**

```typescript
import {
  deriveShellAddressFromPublicKey,
  isShellAddress,
  normalizeShellAddress,
} from "shell-sdk/address";

const address = deriveShellAddressFromPublicKey(publicKey, 1 /* MlDsa65 */);
// → "0x9a3f…" (64-char lowercase hex)

console.log(isShellAddress(address)); // true

// Validation / normalisation
normalizeShellAddress("0x9A3F…");  // → "0x9a3f…" (lowercased)
normalizeShellAddress("pq1abc…");  // throws: expected 0x + 64-char hex address, got: "pq1abc…"
```

---

### Provider / RPC

`import { … } from "shell-sdk/provider"`

#### Chain config

```typescript
import { shellDevnet } from "shell-sdk/provider";
// shellDevnet = { id: 424242, name: "Shell Devnet", nativeCurrency: { symbol: "SHELL", decimals: 18 }, … }
```

#### Factory functions

| Function | Description |
|---|---|
| `createShellProvider(options?)` | Create a `ShellProvider` (recommended entry point) |
| `createShellPublicClient(options?)` | Create a viem `PublicClient` over HTTP |
| `createShellWsClient(options?)` | Create a viem `PublicClient` over WebSocket |

`options: CreateShellPublicClientOptions`:

| Field | Type | Default |
|---|---|---|
| `chain` | `Chain` | `shellDevnet` |
| `rpcHttpUrl` | `string` | `http://127.0.0.1:8545` |
| `rpcApiKey` | `string` | — |
| `rpcWsUrl` | `string` | `ws://127.0.0.1:8546` |

`rpcApiKey` authenticates HTTP RPC requests with `Authorization: Bearer ...`.
Keep it in a server-side secret store; do not embed it in browser bundles.

#### `ShellProvider` class

| Member | Description |
|---|---|
| `.client` | Underlying viem `PublicClient` for all standard `eth_*` methods |
| `.rpcHttpUrl` | HTTP RPC URL in use |
| `getPqPubkey(address)` | `shell_getPqPubkey` → hex public key or `null` |
| `sendTransaction(signed)` | `shell_sendTransaction` → tx hash string |
| `getTransactionsByAddress(address, opts)` | `shell_getTransactionsByAddress` with optional `fromBlock/toBlock/page/limit`; pin `toBlock` from page 0 for stable full-history pagination |
| `rpcCapabilities()` | `shell_rpcCapabilities` → supported Shell RPC v2 methods and node limits |
| `getChainSnapshot(opts?)` | `shell_getChainSnapshot` → compact chain/node/consensus dashboard snapshot |
| `getBlocksRange(start, opts?)` | `shell_getBlocksRange` → bounded block list with configurable transaction detail |
| `getAddressSummary(address, opts?)` | `shell_getAddressSummary` → balance/nonce/code/pubkey state plus recent transaction page |
| `getTransactionsByAddressV2(address, opts?)` | `shell_getTransactionsByAddressV2` cursor pagination; falls back to legacy first-page history on older nodes |
| `getTransactionSummary(txHash, opts?)` | `shell_getTransactionSummary` → compact transaction and optional receipt metadata |
| `getValidatorSnapshot(opts?)` | `shell_getValidatorSnapshot` → validator/proposer aggregate and proposer window stats; `proposerWindow` defaults to 200 and accepts 1..1000 |
| `encodeSetValidatorStake(address, stake)` | `shell_encodeSetValidatorStake` → staking-mode governance calldata |
| `proposeSetValidatorStake(address, stake)` | `shell_proposeSetValidatorStake` → governance transaction hash; stake is a canonical hex quantity |
| `getBlockReceipts(block)` | `eth_getBlockReceipts` → `ShellRpcReceipt[]` |
| `getNodeInfo()` | `shell_getNodeInfo` → `ShellNodeInfo` (version, block height, peer count) |
| `getWitness(blockNumberOrHash)` | `shell_getWitness` → `ShellWitnessBundle` or `null` if pruned |
| `getStorageProfile()` | `shell_getStorageProfile` → canonical `ShellStorageProfile \| undefined` |

**Examples:**

```typescript
import { createShellProvider } from "shell-sdk/provider";

const provider = createShellProvider();

// Standard eth methods via viem
const block = await provider.client.getBlockNumber();
const balance = await provider.client.getBalance({ address: "0x…" });

// Shell-specific methods
const pubkeyHex = await provider.getPqPubkey("0x…");
const txHash    = await provider.sendTransaction(signedTx);

// Shell RPC v2 aggregate methods reduce fan-out for explorer, wallet and ops UI.
const capabilities = await provider.rpcCapabilities();
const snapshot = await provider.getChainSnapshot();
const latestBlocks = await provider.getBlocksRange("latest", {
  direction: "desc",
  limit: 20,
  txDetail: "summary",
  txLimit: 10,
});
const account = await provider.getAddressSummary("0x…", {
  recentLimit: 10,
  includeTotal: false,
});
const firstPage = await provider.getTransactionsByAddressV2("0x…", {
  limit: 50,
  direction: "desc",
  detail: "summary",
});
const nextPage = firstPage.nextCursor
  ? await provider.getTransactionsByAddressV2("0x…", { cursor: firstPage.nextCursor })
  : null;
const tx = await provider.getTransactionSummary(txHash, { includeReceipt: true });
const validators = await provider.getValidatorSnapshot({ proposerWindow: 200 });
```

For a validator RPC listener protected by `--rpc-api-key`, configure the same
key before calling signer-backed governance methods:

```typescript
const provider = createShellProvider({
  rpcHttpUrl: process.env.SHELL_RPC_URL,
  rpcApiKey: process.env.SHELL_RPC_API_KEY,
});

await provider.proposeAddValidator(validatorAddress);
```

RPC v2 list methods clamp page/range sizes to 100 items. The default
transaction detail is `summary`, which omits calldata, signatures, proof bytes,
and full logs. Request `detail: "full"` or `includeReceipt: true` only when the
client needs the larger payload. `getTransactionsByAddressV2` falls back only
when an older node returns `method not found`, and only for the first descending
page. Cursor requests and ascending history require v2 support and fail clearly
on legacy nodes. `getValidatorSnapshot` validates `proposerWindow` locally so
clients do not send values outside the node's 1..1000 proposer stats window.

**Custom endpoint:**

```typescript
const provider = createShellProvider({ rpcHttpUrl: "https://rpc.shellchain.example" });
```

---

### Signer & Adapters

`import { … } from "shell-sdk/signer"`
`import { … } from "shell-sdk/adapters"`

#### `SignerAdapter` interface

Any object satisfying this interface can be plugged into `ShellSigner`:

```typescript
interface SignerAdapter {
  sign(message: Uint8Array): Promise<Uint8Array>;
  getPublicKey(): Uint8Array;
}
```

#### Concrete adapters

| Class | Algorithm | Key sizes |
|---|---|---|
| `MlDsa65Adapter` | ML-DSA-65 (FIPS 204); also used as Dilithium3 stand-in | pk: 1952 B, sk: 4032 B |
| `SlhDsaAdapter` | SLH-DSA-SHA2-256f (FIPS 205) | pk: 64 B, sk: 128 B |

Both adapters expose the same API:

```typescript
// Generate a fresh key pair (optionally from a deterministic seed)
const adapter = MlDsa65Adapter.generate();
const adapter = MlDsa65Adapter.generate(seed /* Uint8Array(32) */);

// Load from an existing key pair (e.g. from a keystore)
const adapter = MlDsa65Adapter.fromKeyPair(publicKey, secretKey);
```

#### Key-pair generators

```typescript
import { generateMlDsa65KeyPair, generateSlhDsaKeyPair } from "shell-sdk/adapters";

const { publicKey, secretKey } = generateMlDsa65KeyPair();
const { publicKey, secretKey } = generateSlhDsaKeyPair(seed /* Uint8Array(96) */);
```

#### `generateAdapter` / `adapterFromKeyPair`

```typescript
import { generateAdapter, adapterFromKeyPair } from "shell-sdk/adapters";

const adapter = generateAdapter("MlDsa65");
const adapter = adapterFromKeyPair("SphincsSha2256f", pk, sk);
```

#### `ShellSigner` class

```typescript
import { ShellSigner } from "shell-sdk/signer";
import { MlDsa65Adapter } from "shell-sdk/adapters";

const signer = new ShellSigner("MlDsa65", MlDsa65Adapter.generate());
// After an on-chain rotation, bind the replacement key to the original address:
// const rotated = new ShellSigner("MlDsa65", replacementAdapter, accountAddress);
```

| Member | Description |
|---|---|
| `algorithmId` | Numeric algorithm ID (`0`, `1`, or `2`) |
| `getPublicKey()` | Raw public key bytes |
| `getAddress()` | `0x…` 64-char hex Shell address |
| `sign(message)` | Sign an arbitrary byte message → signature bytes |
| `buildSignedTransaction(options)` | Sign `txHash` and assemble a `SignedShellTransaction` |

`buildSignedTransaction` options:

| Field | Type | Description |
|---|---|---|
| `tx` | `ShellTransactionRequest` | The unsigned transaction |
| `txHash` | `Uint8Array` | RLP-encoded hash to sign |
| `includePublicKey?` | `boolean` | Embed `sender_pubkey` until the sender key is registered on-chain |

#### Helper functions

| Function | Description |
|---|---|
| `signatureTypeFromKeyType(keyType)` | Convert keystore `key_type` string to `SignatureTypeName` |
| `publicKeyFromHex(hex)` | Hex string → `Uint8Array` |
| `buildShellSignature(type, bytes)` | Build a `ShellSignature` object |

---

### Transaction builders

`import { … } from "shell-sdk/transactions"`

#### Constants

| Constant | Value |
|---|---|
| `DEFAULT_TX_TYPE` | `2` (EIP-1559) |
| `DEFAULT_TRANSFER_GAS_LIMIT` | `21_000` |
| `DEFAULT_SYSTEM_GAS_LIMIT` | `100_000` |
| `DEFAULT_MAX_FEE_PER_GAS` | `1_000_000_000` (1 Gwei) |
| `DEFAULT_MAX_PRIORITY_FEE_PER_GAS` | `100_000_000` (0.1 Gwei) |

#### `buildTransferTransaction`

Build a SHELL token transfer (type-2 EIP-1559 transaction):

```typescript
import { buildTransferTransaction, hashTransaction } from "shell-sdk/transactions";
import { parseEther } from "viem";

const tx = buildTransferTransaction({
  chainId: 424242,
  nonce: 0,
  to: "0x…",
  value: parseEther("1.5"),
});
```

#### `buildSystemTransaction`

Low-level builder for any call to the AccountManager system contract:

```typescript
const tx = buildSystemTransaction({
  chainId: 424242,
  nonce: 1,
  data: "0xdeadbeef…",
});
```

#### `buildRotateKeyTransaction`

Rotate the signing key for the sender's account:

```typescript
import { buildRotateKeyTransaction, hashTransaction } from "shell-sdk/transactions";

const tx = buildRotateKeyTransaction({
  chainId: 424242,
  nonce: 2,
  publicKey: newAdapter.getPublicKey(),
  algorithmId: 1, // MlDsa65
});
```

#### `buildSetValidationCodeTransaction` / `buildClearValidationCodeTransaction`

```typescript
const tx = buildSetValidationCodeTransaction({
  chainId: 424242,
  nonce: 3,
  codeHash: "0xabc123…", // bytes32 hash of custom validation contract
});

const tx = buildClearValidationCodeTransaction({ chainId: 424242, nonce: 4 });
```

#### `buildSignedTransaction`

Assemble a `SignedShellTransaction` directly (use `ShellSigner.buildSignedTransaction` in practice):

```typescript
import { buildSignedTransaction } from "shell-sdk/transactions";

const signed = buildSignedTransaction({
  from: "0x…",
  tx,
  signature: sigBytes,
  signatureType: "MlDsa65",
  senderPubkey: publicKey, // optional
});
```

#### `hashTransaction`

Compute the canonical shell-chain v0.27.5 signing hash as **BLAKE3** over the structured preimage:

`PQTX_SIGNING_V2\0(16B) || chain_id(8B BE) || nonce(8B BE) || to(32B|zero) || value(32B BE) || data || gas_limit(8B BE) || max_fee_per_gas(8B BE) || max_priority_fee_per_gas(8B BE) || rlp(access_list) || sig_type(1B) || tx_type(1B)`

For blob transactions (`tx_type === 3`), append `max_fee_per_blob_gas(8B BE)` and each 32-byte blob hash.

```typescript
import { buildTransferTransaction, hashTransaction } from "shell-sdk/transactions";

const tx     = buildTransferTransaction({ chainId: 424242, nonce: 0, to: "0x…", value: 1n });
const txHash = hashTransaction(tx, signer.signatureType); // Uint8Array (32 bytes)
const signed = await signer.buildSignedTransaction({ tx, txHash });
// Or simply: await signer.buildSignedTransaction({ tx })
```

---

### Contract development

Runtime helpers are available from `shell-sdk/contracts`; Node-only Solidity
compiler helpers are available from `shell-sdk/contracts/compiler`.

Use `contracts` in browser and Node apps. Use `contracts/compiler` only from
Node scripts. Compilation loads the optional `solc` peer on demand; install it
with `npm install solc@^0.8.30` before compiling. CLI help and artifact reads do
not require the compiler.

| Helper | Description |
|---|---|
| `compileSolidity(opts)` | Node-only Solidity compile helper that returns a normalized Shell artifact |
| `loadContractArtifact(path)` / `saveContractArtifact(path, artifact)` | Node-only artifact IO helpers |
| `buildDeployTransaction(opts)` | Build a Shell contract creation tx (`to: null`) |
| `deployContract(opts)` | Build, sign, broadcast, optionally wait, and validate the 32-byte contract address |
| `buildContractCallTransaction(opts)` | Build a Shell transaction targeting a deployed contract |
| `writeContract(opts)` | Build, sign, broadcast, and optionally wait for a state-changing call |
| `readContract(opts)` | Encode calldata, call `eth_call`, and decode the ABI result |
| `waitForTransactionReceipt(opts)` | Poll `eth_getTransactionReceipt` with timeout handling |
| `encodeFunctionData(opts)` / `decodeFunctionResult(opts)` | Stable SDK wrappers around viem ABI helpers |

Shell contract addresses are 32-byte Shell addresses. Contract source should
use Solidity's `address` keyword for account and owner fields; the Shell SDK
contract helpers encode and decode ABI `address` values as 32-byte Shell
addresses for this chain. Receipt polling defaults to 2 seconds and clamps
custom `pollIntervalMs` values below 100ms to 100ms so clients do not spin on
pending transactions.

```typescript
import { readFile } from "node:fs/promises";
import { createShellProvider, decryptKeystore } from "shell-sdk";
import {
  deployContract,
  readContract,
  writeContract,
} from "shell-sdk/contracts";
import {
  compileSolidity,
} from "shell-sdk/contracts/compiler";

const rpcHttpUrl = process.env.SHELL_RPC_URL ?? "http://127.0.0.1:8545";
const chainId = Number(process.env.SHELL_CHAIN_ID ?? "1337");
const keystore = JSON.parse(await readFile(process.env.SHELL_KEYSTORE_PATH!, "utf8"));
const signer = await decryptKeystore(keystore, process.env.SHELL_KEYSTORE_PASSWORD!);
const provider = createShellProvider({ rpcHttpUrl });

const artifact = await compileSolidity({
  sources: [{ path: "contracts/PqvmCounter.sol" }],
  contractName: "PqvmCounter",
  outputPath: "artifacts/PqvmCounter.json",
});

const deployed = await deployContract({
  provider,
  signer,
  chainId,
  artifact,
  gasLimit: 1_500_000,
  wait: true,
});

await writeContract({
  provider,
  signer,
  chainId,
  address: deployed.contractAddress!,
  abi: artifact.abi,
  functionName: "setNumber",
  args: [7n],
  gasLimit: 120_000,
  wait: true,
});

const value = await readContract({
  provider,
  address: deployed.contractAddress!,
  abi: artifact.abi,
  functionName: "getNumber",
});

console.log({ contract: deployed.contractAddress, value });
```

The package also ships a Node CLI that uses the same public API:

```bash
npx shell-sdk contract compile \
  --source contracts/PqvmCounter.sol \
  --contract PqvmCounter \
  --out artifacts/PqvmCounter.json

npx shell-sdk contract deploy \
  --artifact artifacts/PqvmCounter.json \
  --keystore my-key.json \
  --password "$SHELL_KEYSTORE_PASSWORD" \
  --rpc http://127.0.0.1:8545 \
  --chain-id 1337

npx shell-sdk contract write \
  --artifact artifacts/PqvmCounter.json \
  --address 0x... \
  --function setNumber \
  --args '["7n"]'

npx shell-sdk contract read \
  --artifact artifacts/PqvmCounter.json \
  --address 0x... \
  --function getNumber
```

CLI `--args` converts decimal strings ending in `n` to bigint at every level,
including arrays and named or positional tuples. For example,
`--args '[ ["9007199254740993n", "7n"] ]'` preserves both `uint256[]` elements;
signed integer arguments can use `"-7n"`. JSON numeric integers outside the safe
JavaScript range are rejected; use the string form to retain the exact value.
For overloads, pass the original signature, such as `--function 'set(uint256[])'`,
with the complete artifact ABI.

---

### System contracts

`import { … } from "shell-sdk/system-contracts"`

#### Addresses

| Export | Value |
|---|---|
| `validatorRegistryAddress` | `0x0000000000000000000000000000000000000000000000000000000000000001` |
| `accountManagerAddress`   | `0x0000000000000000000000000000000000000000000000000000000000000002` |

#### Function selectors

| Export | Selector for |
|---|---|
| `rotateKeySelector` | `rotateKey(bytes,uint8)` |
| `setValidationCodeSelector` | `setValidationCode(bytes32)` |
| `clearValidationCodeSelector` | `clearValidationCode()` |

#### Calldata encoders

```typescript
import {
  encodeRotateKeyCalldata,
  encodeSetValidationCodeCalldata,
  encodeClearValidationCodeCalldata,
  isSystemContractAddress,
} from "shell-sdk/system-contracts";

const data = encodeRotateKeyCalldata(newPublicKey, 1 /* MlDsa65 */);
const data = encodeSetValidationCodeCalldata("0xcodehash…");
const data = encodeClearValidationCodeCalldata(); // selector only

isSystemContractAddress("0x0000000000000000000000000000000000000000000000000000000000000002"); // true
```

---

### Keystore

`import { … } from "shell-sdk/keystore"`

Shell keystore files are JSON objects encrypted with **argon2id** (KDF) and **xchacha20-poly1305** (cipher). The `shell` CLI generates compatible files.

#### Keystore format

```jsonc
{
  "version": 1,
  "address": "0x…",
  "key_type": "mldsa65",
  "kdf": "argon2id",
  "kdf_params": { "m_cost": 65536, "t_cost": 3, "p_cost": 1, "salt": "hex…" },
  "cipher": "xchacha20-poly1305",
  "cipher_params": { "nonce": "hex…" },
  "ciphertext": "hex…",
  "public_key": "hex…"
}
```

Plaintext layout after decryption: `[secret_key_bytes][public_key_bytes]`.

#### API

| Function | Description |
|---|---|
| `parseEncryptedKey(input)` | Parse keystore JSON → `ParsedShellKeystore` (no decryption) |
| `validateEncryptedKeyAddress(input)` | Parse + verify `address` matches derived public-key address |
| `exportEncryptedKeyJson(input)` | Pretty-print keystore JSON string |
| `assertSignerMatchesKeystore(signer, keystore)` | Throw if signer algorithm or address doesn't match |
| `decryptKeystore(input, password)` | Full decryption → `Promise<ShellSigner>` |

**Examples:**

```typescript
import { decryptKeystore, parseEncryptedKey } from "shell-sdk/keystore";
import { readFileSync } from "fs";

const json  = readFileSync("./my-key.json", "utf8");

// Inspect without decrypting
const parsed = parseEncryptedKey(json);
console.log(parsed.canonicalAddress); // 0x…
console.log(parsed.signatureType);    // "MlDsa65"

// Decrypt
const signer = await decryptKeystore(json, "my-passphrase");
console.log(signer.getAddress()); // 0x…
```

---

## End-to-end examples

### Key generation → address → transfer → submit

```typescript
import { MlDsa65Adapter } from "shell-sdk/adapters";
import { createShellProvider } from "shell-sdk/provider";
import { ShellSigner } from "shell-sdk/signer";
import { buildTransferTransaction, hashTransaction } from "shell-sdk/transactions";


// 1. Generate keys
const adapter = MlDsa65Adapter.generate();
const signer  = new ShellSigner("MlDsa65", adapter);
const from    = signer.getAddress();      // 0x…

console.log("Address:", from);

// 2. Connect to devnet
const provider = createShellProvider(); // defaults to http://127.0.0.1:8545

// 3. Get current nonce
const nonce = await provider.client.getTransactionCount({ address: from });

// 4. Build the transaction
const tx = buildTransferTransaction({
  chainId: 424242,
  nonce,
  to: "0x…",
  value: parseEther("0.5"),
});

// 5. Compute the canonical BLAKE3 signing hash
const txHash = hashTransaction(tx, signer.signatureType);

// 6. Sign and build the complete signed transaction
//    includePublicKey=true is required for accounts that haven't been seen on-chain yet
const signed = await signer.buildSignedTransaction({
  tx,
  txHash: txHash,
  includePublicKey: true,
});

// 7. Broadcast
const hash = await provider.sendTransaction(signed);
console.log("Transaction hash:", hash);
```

### Load from keystore and send

```typescript
import { decryptKeystore } from "shell-sdk/keystore";
import { createShellProvider } from "shell-sdk/provider";
import { buildTransferTransaction, hashTransaction } from "shell-sdk/transactions";
import { readFileSync } from "fs";
import { parseEther } from "viem";

const signer   = await decryptKeystore(readFileSync("./key.json", "utf8"), process.env.PASSPHRASE!);
const provider = createShellProvider();
const nonce    = await provider.client.getTransactionCount({ address: signer.getAddress() });

const tx = buildTransferTransaction({
  chainId: 424242,
  nonce,
  to: "0x…",
  value: parseEther("10"),
});

const txHash = hashTransaction(tx, signer.signatureType);
const signed = await signer.buildSignedTransaction({ tx, txHash });
const hash   = await provider.sendTransaction(signed);
console.log(hash);
```

---

### Testnet smart contract + PQVM full flow (source → compile → deploy → write → read)

The SDK includes an optional testnet end-to-end test for contract execution on PQVM. The
test uses the public `shell-sdk/contracts` and `shell-sdk/contracts/compiler`
APIs:

1. Compile `contracts/PqvmCounter.sol` with `solc`
2. Deploy contract with SDK signer + `shell_sendTransaction`
3. Execute state-changing calls (`setNumber`, `increment`)
4. Verify reads via `eth_call` (`getNumber`)

#### Required environment

| Variable | Description |
|---|---|
| `SHELL_SDK_E2E_TESTNET=1` | Enables the testnet E2E test |
| `SHELL_SDK_RPC_URL` | Testnet RPC URL |
| `SHELL_SDK_CHAIN_ID` | Testnet chain ID |
| `SHELL_SDK_E2E_KEYSTORE_PATH` or `SHELL_SDK_E2E_KEYSTORE_JSON` | Funded test keystore |
| `SHELL_SDK_E2E_KEYSTORE_PASSWORD` | Keystore password |
| `SHELL_SDK_E2E_FAUCET_URL` *(optional)* | Faucet endpoint for low-balance top-up |

#### Run

```bash
npm install
npm run test:e2e:testnet
```

This command runs:

```bash
npm run contract:compile
SHELL_SDK_E2E_TESTNET=1 node --test tests/pqvm.contract.testnet.e2e.test.mjs
```

#### Troubleshooting

- `missing keystore`: set `SHELL_SDK_E2E_KEYSTORE_PATH` or `SHELL_SDK_E2E_KEYSTORE_JSON`.
- `insufficient balance`: fund test account or set `SHELL_SDK_E2E_FAUCET_URL`.
- `rpc request failed`: verify RPC reachability and chain health.
- `deploy transaction failed` / `increment transaction failed`: check node logs and receipt status.

---

### Wallet extension background flow

This is the recommended shape for a Chrome extension background worker: keep the decrypted signer only in memory, fetch the latest nonce from RPC, and use the stable root entrypoint for the common path.

```typescript
import { createShellProvider, buildTransferTransaction, hashTransaction } from "shell-sdk";

async function submitTransfer({ signer, to, value, rpcHttpUrl }: {
  signer: { getAddress(): string; buildSignedTransaction(args: { tx: unknown; txHash: Uint8Array; includePublicKey?: boolean }): Promise<unknown> };
  to: string;
  value: bigint;
  rpcHttpUrl: string;
}) {
  const provider = createShellProvider({ rpcHttpUrl });
  const nonce = await provider.client.getTransactionCount({ address: signer.getAddress() });

  const tx = buildTransferTransaction({
    chainId: 424242,
    nonce,
    to,
    value,
  });
  const txHash = hashTransaction(tx, signer.signatureType);
  const includePublicKey = await provider.getPqPubkey(signer.getAddress()) === null;
  const signed = await signer.buildSignedTransaction({ tx, txHash, includePublicKey });

  return provider.sendTransaction(signed);
}
```

### Minimal dApp flow

For a lightweight web app, keep the provider in the page and delegate signing to an injected wallet or background bridge:

```typescript
import { createShellProvider, normalizePqAddress } from "shell-sdk";

const provider = createShellProvider({
  rpcHttpUrl: "https://rpc.testnet.shell.network",
});

const account = normalizeShellAddress("0x9a3f…");
const history = await provider.getTransactionsByAddress(account, { page: 1, limit: 10 });

console.log("recent txs:", history.transactions);
console.log("total:", history.total);
```

---

## Key rotation

Shell Chain accounts support **key rotation** — replacing the signing key without changing the account address. This is a critical security feature for post-quantum safety.

This example uses a disposable funded local account on chain `1337`. It generates
an in-memory replacement key and disposes it at the end. For an account you need
to retain, load a securely persisted replacement key and keep the original account
address alongside it before rotating. Use a node compatible with this SDK's
signing version and submit no concurrent transactions from the account.

```typescript
import { readFile } from "node:fs/promises";
import { MlDsa65Adapter, ShellSigner, createShellProvider, decryptKeystore,
  buildRotateKeyTransaction, buildTransferTransaction } from "shell-sdk";
import { waitForTransactionReceipt } from "shell-sdk/contracts";

const password = process.env.SHELL_KEYSTORE_PASSWORD;
if (!password) throw new Error("Set SHELL_KEYSTORE_PASSWORD");
const provider = createShellProvider({ rpcHttpUrl: "http://127.0.0.1:8545" });
const currentSigner = await decryptKeystore(
  JSON.parse(await readFile(process.env.SHELL_KEYSTORE_PATH ?? "old-key.json", "utf8")),
  password,
);
const accountAddress = currentSigner.getAddress() as `0x${string}`;
const newAdapter = MlDsa65Adapter.generate();
const newSigner = new ShellSigner("MlDsa65", newAdapter, accountAddress);

try {
  const nonce = Number(BigInt(await provider.client.request({
    method: "eth_getTransactionCount", params: [accountAddress, "pending"],
  })));
  const tx = buildRotateKeyTransaction({
    chainId: 1337, nonce, publicKey: newAdapter.getPublicKey(),
    algorithmId: newSigner.algorithmId,
  });
  const signed = await currentSigner.buildSignedTransaction({ tx, includePublicKey: true });
  const hash = await provider.sendTransaction(signed);
  const receipt = await waitForTransactionReceipt({ provider, hash: hash as `0x${string}` });
  if (receipt.status !== "0x1") throw new Error(`Rotation failed: ${hash}`);

  // The new key signs for the same account, with its next nonce.
  const followup = buildTransferTransaction({
    chainId: 1337, nonce: nonce + 1, to: accountAddress, value: 0n,
  });
  const next = await newSigner.buildSignedTransaction({ tx: followup, includePublicKey: true });
  const nextHash = await provider.sendTransaction(next);
  const nextReceipt = await waitForTransactionReceipt({ provider, hash: nextHash as `0x${string}` });
  if (nextReceipt.status !== "0x1") throw new Error(`Follow-up failed: ${nextHash}`);
  console.log("Rotated account:", newSigner.getAddress(), "confirmed:", nextHash);
} finally {
  currentSigner.dispose();
  newSigner.dispose();
}
```

The optional third constructor argument is the existing account address. Omitting
it derives a fresh address from the replacement public key; that fresh address
does not inherit the original balance or nonce. Binding an address does not grant
authority: the node still checks the registered key. Wait for a successful rotation
receipt before using the new key, and include its public key in signed transactions.
If receipt waiting times out, check the same hash before retrying.

---

## Error handling

All SDK functions throw standard `Error` instances. Common error messages:

| Error message | Cause |
|---|---|
| `expected 32 address bytes, got N` | Wrong-length bytes passed to address helpers |
| `expected 0x prefix, got X` | Shell address must start with `0x` |
| `invalid Shell address length` | Address must be 32 raw bytes / 64 hex characters |
| `unsupported key type: X` | Keystore `key_type` not recognised |
| `unsupported kdf: X` | Only `argon2id` is supported |
| `unsupported cipher: X` | Only `xchacha20-poly1305` is supported |
| `keystore address mismatch` | Declared address ≠ derived address in the keystore |
| `decrypted public key mismatch` | Wrong password or corrupt keystore |
| `rpc request failed: 4XX/5XX` | HTTP-level RPC error |
| `[code] message` | JSON-RPC error returned by the node |

```typescript
try {
  const signer = await decryptKeystore(json, "wrong-password");
} catch (err) {
  if (err instanceof Error && err.message.includes("mismatch")) {
    console.error("Wrong password or corrupt keystore file");
  }
}
```

---

## TypeScript types reference

```typescript
// Branded hex string: "0x" + arbitrary hex chars
type HexString = `0x${string}`;

// Any value accepted as a Shell address (0x… 64-char hex)
type AddressLike = string;

// Post-quantum signature algorithm names
type SignatureTypeName = "Dilithium3" | "MlDsa65" | "SphincsSha2256f";

// Wire format sent to shell_sendTransaction
interface SignedShellTransaction {
  from: AddressLike;
  tx: ShellTransactionRequest;
  signature: ShellSignature;
  sender_pubkey?: number[] | null;
}

interface ShellTransactionRequest {
  chain_id: number;
  nonce: number;
  to: AddressLike | null;
  value: string;           // hex-encoded bigint, e.g. "0xde0b6b3a7640000"
  data: HexString;
  gas_limit: number;
  max_fee_per_gas: number;
  max_priority_fee_per_gas: number;
  access_list?: ShellAccessListItem[] | null;
  tx_type?: number;
  max_fee_per_blob_gas?: number | null;
  blob_versioned_hashes?: HexString[] | null;
}

interface ShellSignature {
  sig_type: SignatureTypeName;
  data: number[];          // raw signature bytes as a JS number array
}
```

---

## Compatibility

| Requirement | Version |
|---|---|
| Node.js | ≥ 18 (for `fetch` and `crypto.getRandomValues`) |
| TypeScript | ≥ 5.0 recommended |
| Module format | ESM only (`"type": "module"`) |
| Browser | Any modern browser with WebCrypto; bundler required (Vite/webpack/esbuild) |

**Key dependencies:**

| Package | Purpose |
|---|---|
| [`viem`](https://viem.sh) | Ethereum JSON-RPC client, ABI encoding |
| [`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum) | ML-DSA-65 and SLH-DSA-SHA2-256f |
| [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) | BLAKE3 |
| [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers) | xchacha20-poly1305 |
| [`hash-wasm`](https://github.com/nicowillis/hash-wasm) | argon2id (WASM) |

---

## Release checklist

Before publishing a `shell-sdk` release candidate:

1. Run `npm test` and `npm run typecheck`.
2. Confirm the stable root surface still excludes low-level helpers such as `hexBytes` and internal signer maps.
3. Verify Browser + Node integration tests both cover signer, keystore, and provider RPC flows.
4. Review README examples against the current public exports (`shell-sdk`, `shell-sdk/signer`, `shell-sdk/transactions`).
5. Check `package.json` `exports`, `files`, `version`, and repository metadata.
6. Build once from a clean tree and smoke-import the package root plus subpaths from `dist/`.
7. Test the packed package against the intended node signing format. Record the
   exact node revision and network; a source version string alone is insufficient.
8. Publish from a Git tag exactly matching `v` plus the package version. The
   Publish workflow also requires this tag for manual dispatch, checks the
   lockfile version, and selects `next` for prereleases or `latest` for stable
   releases. Merging a release-preparation PR does not publish a package.
9. Configure the npm package's **Trusted Publisher** for GitHub Actions with
   organization `ShellDAO`, repository `shell-sdk`, workflow filename
   `publish.yml`, no environment name, and permission to publish directly.
   The workflow uses OIDC; it does not require an npm token secret. A registry
   `E404` during publication can indicate a missing or mismatched publisher.
10. The workflow packs once, installs that archive in an isolated consumer,
    checks all public entry points, declarations and CLI, and publishes the
    same archive. After publication it installs the exact registry version
    again. For a manual retry, select the matching version tag in **Run workflow**.

---

## Chain reference

| Parameter | Value |
|---|---|
| Chain ID | `424242` |
| Network name | Shell Devnet |
| Native currency | SHELL (18 decimals) |
| HTTP RPC | `http://127.0.0.1:8545` |
| WebSocket RPC | `ws://127.0.0.1:8546` |
| Address format | `0x` + 64 lowercase hex chars (32-byte BLAKE3 hash of `algo_id ‖ pubkey`) |
| Default tx type | 2 (EIP-1559) |
| Default gas limit (transfer) | 21 000 |
| Default gas limit (system) | 100 000 |
| Default max fee per gas | 1 Gwei |

For full chain documentation, validator setup, and the Shell CLI reference, see the project wiki or official docs site.

### Contract-paymaster validation gas (unreleased source builds)

Use the bundle's actual outer gas limit and fee. `inner_calls_data` is its
canonical RLP inner-call list and `paymaster_context` is the policy context:

```typescript
const estimate = await provider.estimatePaymasterGas({
  paymaster, sender, inner_calls_data, paymaster_context,
  gas_limit: "0x493e0", max_fee_per_gas: "0x7",
});
if (estimate.simulation_status === "simulated") {
  console.log(estimate.validation_gas, estimate.max_gas_cost);
}
```

Updated node source executes the admission STATICCALL and returns measured gas
including intrinsic and wrapper costs. Failed policies reject the RPC request;
state is never committed. Existing public binaries and requests without
`gas_limit` return `cap_only`, with no measured gas. This SDK type addition is
also unreleased. Simulation does not validate the complete bundle, signatures,
nonce or funding and does not guarantee sponsorship at a later state or height.

### Experimental PQABI compiler target

In the development version, `compileSolidity({ ...options, target: "pqvm" })`
(or `shell-sdk contract compile ... --pqvm`) compiles Solidity `address` values
as full 32-byte ABI and storage words while retaining the original ABI types
and function selectors. The default target remains `evm`. Recompile contracts
for this target; its storage layout differs from a previously deployed contract
that packed 20-byte addresses. Do not replace bytecode in an existing account.

This initial target supports address values, comparisons, arrays, mappings,
storage and memory struct fields (including nested structs), events, explicit custom-error reverts and `require(bool, CustomError(...))`
(with Solidity 0.8.26 or newer). Event signature topics and
custom-error selectors retain their original `address` type signatures, with
full-word indexed topics, event data and error arguments. Integer
`type(T).min` and `type(T).max` preserve Solidity limits for every signed and
unsigned integer width, including the `int` and `uint` aliases.

Address and integer overloads retain their original Solidity type resolution,
ABI and selectors, including internal calls between overloaded functions.
Backend names also remain distinct when source declarations occupy every
short name; longer names preserve event/error signature recovery:

```solidity
pragma solidity ^0.8.35;
contract Overloads {
    function echo(address value) public pure returns (address) { return value; }
    function echo(uint256 value) public pure returns (uint256) { return value + 1; }
    function pick(address value) external pure returns (address) { return echo(value); }
    function pick(uint256 value) external pure returns (uint256) { return echo(value); }
}
```

Compile this unchanged source with `target: "pqvm"` to retain a full-word address
result alongside the integer result. Invalid or ambiguous original Solidity
still fails its original type check. This support is in the unreleased compiler
source; matching public package delivery remains pending.

For overloaded contract calls, pass the original canonical signature in
`functionName`, such as `"echo(address)"` or `"echo(uint256)"`. Encoding,
transaction building, reading, writing and result decoding all select the same
original ABI declaration. Bare names with ambiguous parameter counts reject;
reads with a unique parameter count retain the selected declaration for decoding.
This helper support is in the unreleased source.

```typescript
import { encodeFunctionData, decodeFunctionResult } from "shell-sdk";
import { parseAbi } from "viem";

const abi = parseAbi([
  "function echo(address value) pure returns (address)",
  "function echo(uint256 value) pure returns (uint256)",
]);
const value = `0x${"34".repeat(12)}${"12".repeat(20)}` as const;
const data = encodeFunctionData({ abi, functionName: "echo(address)", args: [value] });
// Decode a full-word address result using the same selected declaration.
const decoded = decodeFunctionResult({ abi, functionName: "echo(address)", data: value });
```

The isolated helper RPC regression creates its own genesis, temporary account,
node database and loopback port. After installing SDK dependencies, use a
compatible node source build with RocksDB and libp2p support. In the shell-chain
checkout, build it with `cargo build -p shell-cli --features libp2p`; then run
these commands in the SDK checkout:

```bash
npm run build
SHELL_NODE_BIN=/path/to/shell-node node --test --test-name-pattern='canonical overload real RPC' tests/contracts.test.mjs
```

It checks the original scalar overloads and inherited, internal, free-function
and array compositions through genuinely signed ML-DSA-65 and Dilithium3
ordinary writes, root-signed AA batches and actual CLI compile/write/read
commands using fresh encrypted keystores. CLI cases verify nested bigint arguments
and 32-byte address values. AA cases reject tampered inner
calldata, corrupt signatures and a mismatched algorithm identifier, and verify
that a later failing call rolls back earlier writes in the same batch while the
outer fee and nonce still apply. The original ABI is retained, and fixed
selectors and manually encoded words check SDK calldata. Assertions cover mined receipts and state,
zero/MAX/truncated-input rollback, empty-array rejection, independent fee and
nonce accounting, historical queries, P2P follower import, offline follower
catch-up, and crash recovery with a new write after restart.
It waits for finality before testing receipt identity across validator restart,
since startup may rewind and requeue an unfinalized suffix.
It generates a temporary
validator keystore and account, uses one-second isolated dev blocks, and removes
its own runtime after success. Failed runtimes are retained for diagnosis.
Genesis predeployment is used; native CREATE and public package acceptance
remain separate.

Unreleased `native-address-context-v1` nodes can also compile `msg.sender`,
`tx.origin`, `block.coinbase` and `address(this)` as full words. Set
`nativeAddressContextHeight` to the node's immutable activation height:

```typescript
const artifact = await compileSolidity({
  sources: [{ path: "Context.sol" }],
  contractName: "Context",
  target: "pqvm",
  nativeAddressContextHeight: 2,
});
```

The CLI equivalent is `--pqvm --native-address-context-height 2`.
The example height applies only to an isolated chain configured with activation
at block 2. Each generated context read reverts before that height. The compiler
cannot verify a remote node's schedule: the operator must match it explicitly.
Existing public node releases do not implement this profile. Omitting the option
keeps native context expressions rejected; setting it cannot activate a node.
With the same explicit profile, address variables also support `.balance`,
`.codehash` and `.code` against their complete 32-byte target. These reads return
zero balance, zero hash and empty bytes for nonexistent accounts. Context
receivers also support these reads, including `address(this).balance` and
`msg.sender.codehash`. Function-result, array and struct receivers still require
further compiler support.
This is source support for development validation, pending the complete node
profile and release.

With the explicit profile, low-level `target.call(data)` and
`target.call{value: amount}(data)`, `target.staticcall(data)` and
`target.delegatecall(data)` also preserve the full target and return
`(bool, bytes)`, including revert data. Static calls prohibit state writes;
delegate calls use the calling contract storage and original caller/value.
Receivers can be address variables or the context expressions `msg.sender`,
`tx.origin`, `block.coinbase` and `address(this)`, or a direct internal function
call that returns an address and takes identifier or literal arguments. That
receiver is evaluated once.
These forms require a bytes variable. Gas limits can be supplied with
`{gas: budget}` on CALL, STATICCALL and DELEGATECALL; CALL also accepts
`{value: amount, gas: budget}` in either order. Value and gas expressions can be
identifiers, literals, typed struct fields or integer type limits and are
evaluated once. The node applies its existing call-gas forwarding rules,
including the EIP-150 cap. Other receiver expressions remain unsupported.

Typed `I(target).echo(value)` calls also preserve the original selector and
complete address with zero or multiple `address`, integer,
fixed bytes (`bytes1` through `bytes32`) or `bool` arguments and results.
Integers retain their declared
width, including `uint8`, `uint112`, `int112` and `int256`. Signed values retain
two’s complement and sign extension. Negative numeric literals such as
`I(target).echo(-1)` and signed metatype limits such as `type(int112).min` can
be passed directly. Noncanonical sign extension in narrow signed ABI words
reverts the call and its state changes. Standard `block.timestamp` reads are
retained in source and in typed arguments and call options; they read the
executing block’s timestamp. Address fields remain
nonpayable. For example, `IERC20(token).transfer(msg.sender, amount)` retains
both input words and its boolean result; `IERC20(token).totalSupply()` takes no
arguments. A returned `false` remains false, while malformed boolean return data
reverts the caller rather than accepting a noncanonical value. Multiple results
retain their declared order, including complete native addresses; short return
data or a noncanonical boolean rejects the entire call and its state changes.
For example, an interface returning `(address, uint256, bool, bytes32)` can be
returned directly or assigned to four local variables. Fixed byte values retain
their declared length and left alignment, so `supportsInterface(bytes4)` keeps
its original selector and a 32-byte argument word with trailing zero padding.
Dirty padding in a fixed-byte argument or result rejects instead of truncating.
Static function selectors such as `IPay.pay.selector`, `instance.pay.selector`
and `this.invoke.selector` keep the original Solidity signature, including
`address` parameters. They can be combined with XOR in pure functions or passed
directly to a typed call, for example
`IRegistry(target).supportsInterface{gas:30000}(IPay.pay.selector)`.
Receivers in these expressions must be simple identifiers; dynamic function
pointers and receiver expressions with side effects remain outside this compiler
target’s supported subset. `type(I).interfaceId` retains the original EIP-165
identifier for an interface, including in constants and typed call arguments,
for example `IRegistry(target).supportsInterface(type(IAsset).interfaceId)`.
Only functions declared directly in the interface contribute to its XOR;
inherited functions, events and errors do not. An interface declaring no new
functions has ID `0x00000000`. Direct overrides and overloads contribute their
original ABI selectors, including `address` parameters.
Native-address inline assembly also requires an explicit
`nativeAddressContextHeight` matching the node profile. Each original assembly
block rejects before that height. Address parameters remain full words in Yul,
including targets passed to `staticcall`; the original assembly body and its
user-supplied constants are retained. The compiler adds a height guard and
preserves the original ABI mutability after original Solidity type checking.
Manual masks and storage offsets in assembly retain their written meaning;
recompile and review them for the target’s full-word address layout.
Assembly `create`, `create2`, `callcode` and `selfdestruct` remain outside this
native lowering path. Default EVM compilation and address-free arithmetic
assembly retain their existing behavior.

The adapted ERC-165 query in `tests/fixtures/ERC165Query.sol` preserves the
published query algorithm with only the legacy pragma and `constant` keyword
updated. Run its persistent ordinary/AA and two-node checks after building:

```bash
SHELL_NODE_BIN=/path/to/shell-node node --test --test-name-pattern 'native no-throw query' tests/pqabi.payable.test.mjs
```

This isolates fresh accounts on a Dev chain with native context at height 2.
It checks the original 36-byte queries and 30000-gas child budget, result
recording, child failure isolation, batch rollback, historical reads and physical
reopen. It does not validate deployment through CREATE or every malformed
return pattern.

Typed calls also retain dynamic or fixed-length arrays of these
scalar types, including `address[]`, `uint256[]` and `address[2]`, plus dynamic
`bytes`. Helper parameters/results use memory references while ABI decoding
keeps the original array and bytes value types. Address array elements remain
complete native addresses. Memory allocation such as `new address[](length)`
and `new bytes(length)` is supported; this does not enable contract CREATE.
For example, `IERC1155(token).balanceOfBatch(owners, ids)` retains its original
selector, array offsets/lengths and `uint256[]` result. Batch transfer calls can
pass IDs, amounts and bytes data through to an actual receiver callback.
Arrays may contain supported arrays, `bytes` or `string` values recursively.
Struct/tuple ABI fields remain outside this typed-call subset.
The scoped batch fixture has one manual entry after building:

```bash
SHELL_NODE_BIN=/path/to/shell-node node --test --test-name-pattern 'native batch arrays' tests/pqabi.payable.test.mjs
```

It uses fresh local accounts, two native token targets, actual receiver hooks
and persisted balances; it checks malformed dynamic ABI, receiver refusal and
atomic rollback through historical reads and physical database reopen. This
validates the batch call path rather than a complete ERC-1155 token or CREATE.


Typed `string` arguments and results use the same native target and memory
reference rules. `uri(uint256) returns (string)` preserves the original selector,
UTF-8 bytes and dynamic ABI result. Strings can also be passed to typed calls;
`new string(length)` allocates memory without enabling contract CREATE.
The metadata fixture checks actual short/long string storage, URI events,
empty and UTF-8 values, failure/AA rollback, historical reads and database reopen:

```bash
SHELL_NODE_BIN=/path/to/shell-node node --test --test-name-pattern 'native string metadata' tests/pqabi.payable.test.mjs
```

It validates the call and storage path. Metadata JSON retrieval, client-side
`{id}` substitution and a complete ERC-1155 token are separate concerns.

Nested forms such as `uint256[][]`, `address[][]`, `string[]` and `bytes[]`
retain their original ABI and relative offsets at each array level. Address
elements remain full native words throughout nested array arguments/results.
The focused manual acceptance entry after building is:

```bash
SHELL_NODE_BIN=/path/to/shell-node node --test --test-name-pattern 'native nested arrays' tests/pqabi.payable.test.mjs
```

It uses the published Solidity `g(uint256[][],string[])` encoding example,
actual persisted groups/labels, native address weights and returned bytes arrays.
It checks malformed nested offsets/results, partial-write and AA rollback,
historical reads, independent import and database reopen. Other depths and
array combinations still need runtime qualification. `abi.encode` of supported
values also retains complete address words, including nested address arrays.

`address payable` values keep the original ABI `address` type, full native
word and source-level Solidity checks in typed parameters/results, storage and
receiver variables. Supported `payable(...)` casts of existing address variables,
caller context or typed struct fields can be used as typed arguments. Arrays of
payable addresses follow the same recursive array rules. The qualifier itself
does not send funds. `msg.value` retains the incoming call amount as a standard
scalar in contract bodies, typed arguments and value options.

```bash
SHELL_NODE_BIN=/path/to/shell-node node --test --test-name-pattern 'native payable addresses' tests/pqabi.payable.test.mjs
```

This fixture verifies actual transferred value, incoming-amount events, full
owner words, partial AA/outer/callee rollback, fees/nonces, historical reads and
database reopen. Solidity `transfer`/`send` and general address conversions
remain separate unsupported paths. Cast/array combinations beyond the recorded
runtime cases still need qualification.

Narrow result lists such
as `getReserves() returns (uint112, uint112, uint32)` retain their original ABI;
noncanonical high bits in narrow arguments or results reject rather than truncate.
Decoded `uint32` fields use JavaScript numbers; `uint112`, `uint256`, `int112`
and `int256` use bigint. For example, `latestRoundData()` result lists retain
the signed `int256` answer alongside their unsigned round and time fields.
Calls with no
result, such as `INFT(nft).transferFrom(address(this), recipient, id)`, require
code at the complete target address. An absent or empty-code target reverts.
Successful void calls ignore return data without copying it; failed calls
propagate the callee’s revert bytes. Void calls retain the same activation
guard, value/gas options and CALL/STATICCALL mutability rules. The target can be
an address variable or a typed address field of a storage or memory struct, including nested fields such as `I(entries[id].owner)`.
The receiver expression is evaluated once, including any mapping index function.
Each argument can be an identifier, literal, native context read, typed struct
field, or integer `type(T).min` / `type(T).max` expression, such as `IOwner(target).ownerOf(type(uint256).max)` or
`IBalance(entries[id].token).balanceOf(entries[id].beneficiary)`. Struct field
arguments are evaluated once and retain the complete native address or integer word.
Native context reads also retain their complete address inside these expressions,
for example `IPay(entries[msg.sender].target).pay(entries[msg.sender].owner)`.
The same applies to nested `tx.origin`, `block.coinbase` and `address(this)` in
receivers, arguments and supported value/gas option fields, using the same
explicit activation profile.
View and pure declarations use STATICCALL;
pure callers of pure interfaces retain their original public ABI. The backend
uses view annotations for these calls after checking the original source's
purity, since the native STATICCALL helper requires view. Other declarations use
CALL. Callee revert data propagates, and an absent or
short return value reverts. Payable interface calls also accept
`IPay(target).pay{value: amount}(owner)`, sending the specified Wei through the
same full-width CALL path. The value can be an identifier, literal, typed struct
field, or integer type limit; it is evaluated once. Plain and value calls to the
same interface declaration can coexist. Typed calls also accept `{gas: budget}`
and both orders of `{gas: budget, value: amount}` for payable functions. View
and pure interfaces retain STATICCALL; other interfaces use CALL, with the
specified gas operand and the node’s existing forwarding rules. This support is
in unreleased source builds. After building the SDK, verify real signed ordinary
and AA calls, independent block import, token/NFT transfers through static ABI
parameters, nested caller-indexed mappings, historical reads and RocksDB reopen
with a compatible node (verified with v0.27.13):

```bash
npm run build
SHELL_NODE_BIN=/path/to/shell-node node --test tests/pqabi.payable.test.mjs
```

The test creates temporary keys, ports and isolated genesis allocations; it
retains its report and chain data for inspection. It does not deploy through
native CREATE or change any existing network’s activation schedule.
For the void-call, static return-list, integer and fixed byte tests,
`SHELL_PQABI_RESUME_DIR` can point to the retained test directory after an
assertion failure. Resume requires matching source, compiled
artifacts, node binary, isolated genesis and clean node exits. It rechecks the
accepted prefix and continues with the retained payer nonce; it does not replay
transactions. The original `report.json` is preserved and continuation results
are written to `report-resumed.json`, then numbered continuation reports without
overwriting earlier attempts.

Complex option expressions, named arguments, try/catch, contract variables and
other ABI shapes still require further compiler support. This form requires the same unreleased profile and explicit activation option.

Numeric results use the same form, for example:

```solidity
interface IBalance {
    function balanceOf(address owner) external view returns (uint256);
}
contract BalanceReader {
    function lookup(address token, address owner) external view returns (uint256) {
        return IBalance(token).balanceOf(owner);
    }
}
```

The token and owner retain their full native address; the returned balance is
decoded as a 256-bit integer. This source support requires the same unreleased
profile and does not establish support for other token operations.

For a full-width owner returned as `bytes32`, the same typed call form applies:

```solidity
interface IOwner {
    function ownerOf(uint256 tokenId) external view returns (bytes32);
}
contract Reader {
    function lookup(address target, uint256 tokenId) external view returns (bytes32) {
        return IOwner(target).ownerOf(tokenId);
    }
}
```

Compile with `target: "pqvm"` and `nativeAddressContextHeight` matching the
activated development node profile. This opt-in support is available in source;
it does not imply that the public package or testnet has activated the profile.

Other external calls, other member operations,
payable addresses, function types and inline assembly
require further support and fail compilation when an address-bearing source
uses them. This target does not yet fulfill the complete native-address
execution surface described in the whitepaper.

Run the isolated real-VM acceptance without submitting a transaction:

```bash
npm run build
SHELL_PQABI_RPC_URL=http://127.0.0.1:8545 node --test tests/pqabi.compiler.test.mjs tests/pqabi.events.test.mjs
```

The probe deploys a child contract inside `eth_call`, checks constructor storage,
full-width echo, a storage update and malformed-write rollback with original
selectors. The event/error probe also checks full-width revert data, rollback
and user constants equal to lowered signature values. Simulated state is discarded; restart and persistent-node acceptance
remain separate checks.

The self-contained derived-overload regression starts its own temporary memory
node and generates a fresh test authority. In the shell-chain checkout, build
`cargo build -p shell-cli --no-default-features`; then run in the SDK checkout:

```bash
npm run build
SHELL_NODE_BIN=/path/to/shell-node node --test --test-name-pattern='PQABI (derived|crowded) overload real VM' tests/pqabi.compiler.test.mjs
```

It runs the unchanged inherited, internal, free-function and array overload
sources through their original selectors, and repeats the dispatch checks with
all single-character names and several fallback names occupied. Native compilation preserves distinct
full-word address results and integer arithmetic; the default EVM control refuses
wide addresses. It checks SDK encoding and result decoding against independent
ABI words, malformed and unknown calls, overflow panic `0x11`, and empty-array
panic `0x32`. The live head and root stay unchanged. This is readonly source
acceptance; signed stateful execution, persistence and public package delivery
for these forms remain separate. Successful temporary runtimes are removed
after the child exits; failures retain their runtime for diagnosis.
