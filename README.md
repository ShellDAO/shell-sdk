# shell-sdk

**TypeScript / JavaScript SDK for Shell Chain** — build quantum-safe dApps on the PQVM-native post-quantum blockchain secured before Q-Day.

[![Node ≥ 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![ESM only](https://img.shields.io/badge/module-ESM-blue)](https://nodejs.org/api/esm.html)

---

> **shell-chain v0.27.x aligned**
>
> Addresses, system-contract IDs, signing hashes, staking governance RPCs, and
> validator snapshot fields match shell-chain v0.27.x:
> 32-byte `0x…` BLAKE3 addresses, `algo_id` byte `Dilithium3=0`, `MlDsa65=1`,
> `SphincsSha2256f=2`, and BLAKE3-based transaction / AA signing hashes.


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
| `rpcWsUrl` | `string` | `ws://127.0.0.1:8546` |

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

Compute the canonical shell-chain v0.27.x signing hash as **BLAKE3** over the structured preimage:

`chain_id(8B BE) || nonce(8B BE) || to(32B|zero) || value(32B BE) || data || gas_limit(8B BE) || max_fee_per_gas(8B BE) || max_priority_fee_per_gas(8B BE) || sig_type(1B) || tx_type(1B)`

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
Node scripts because it imports `solc`.

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

```typescript
import { MlDsa65Adapter } from "shell-sdk/adapters";
import { ShellSigner } from "shell-sdk/signer";
import { createShellProvider } from "shell-sdk/provider";
import { buildRotateKeyTransaction, hashTransaction } from "shell-sdk/transactions";

const provider = createShellProvider();

// Current signer (must sign the rotation transaction)
const currentSigner = await decryptKeystore(readFileSync("old-key.json", "utf8"), passphrase);

// New key pair to rotate to
const newAdapter = MlDsa65Adapter.generate();
const newSigner  = new ShellSigner("MlDsa65", newAdapter);

const nonce = await provider.client.getTransactionCount({ address: currentSigner.getAddress() });

// Build the rotateKey system transaction
const tx = buildRotateKeyTransaction({
  chainId: 424242,
  nonce,
  publicKey: newAdapter.getPublicKey(),
  algorithmId: newSigner.algorithmId, // 1 for MlDsa65
});

const txHash = hashTransaction(tx, currentSigner.signatureType);

// Sign with the CURRENT key
const signed = await currentSigner.buildSignedTransaction({ tx, txHash });
const hash   = await provider.sendTransaction(signed);
console.log("Key rotated! tx:", hash);
// From the next transaction onwards, use newSigner
```

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
