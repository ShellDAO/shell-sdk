# shell-sdk

**TypeScript / JavaScript SDK for Shell Chain** — build quantum-safe dApps on the first EVM chain secured before Q-Day.

[![Node ≥ 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![ESM only](https://img.shields.io/badge/module-ESM-blue)](https://nodejs.org/api/esm.html)

---

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
- **PQ addresses** — bech32m-encoded `pq1…` addresses derived from PQ public keys via BLAKE3
- **Native account abstraction** — key rotation and custom validation code via system contracts
- **viem integration** — standard Ethereum JSON-RPC methods via a typed `PublicClient`
- **Shell-specific RPC** — `shell_getPqPubkey`, `shell_sendTransaction`, `shell_getTransactionsByAddress`, `shell_getNodeInfo`, `shell_getWitness`
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
import { buildTransferTransaction, hashTransaction } from "shell-sdk/transactions";
import { parseEther } from "viem";

const adapter = MlDsa65Adapter.generate();
const signer  = new ShellSigner("MlDsa65", adapter);
const from    = signer.getAddress(); // pq1…

const provider = createShellProvider();
const nonce    = await provider.client.getTransactionCount({ address: from });

const tx       = buildTransferTransaction({ chainId: 424242, nonce, to: "pq1recipient…", value: parseEther("1") });
const txHash   = hashTransaction(tx);
const signed   = await signer.buildSignedTransaction({ tx, txHash });
const hash     = await provider.sendTransaction(signed);
console.log("tx hash:", hash);
```

---

## Architecture overview

### PQ addresses

Shell Chain uses **bech32m**-encoded addresses (prefix `pq`) instead of Ethereum's hex checksummed format. A `pq1…` address encodes:

```
bech32m( hrp="pq", payload = [ version_byte(0x01) | address_bytes(20) ] )
```

The 20 address bytes are derived deterministically:

```
blake3( version(1) || algo_id(1) || public_key )[0..20]
```

Algorithm IDs: `Dilithium3=0`, `MlDsa65=1`, `SphincsSha2256f=2`.

Shell Chain v0.21.0+ accepts `pq1…` addresses at user-facing RPC and SDK boundaries. Legacy `0x…` address inputs are rejected.

### Native account abstraction (AA)

Every account on Shell Chain supports two system-contract operations via the **AccountManager** (`0x…0002`):

| Operation | Description |
|---|---|
| `rotateKey` | Replace the signing key associated with an address |
| `setValidationCode` | Attach a custom EVM validation contract (smart account) |
| `clearValidationCode` | Revert to the default PQ key validation |

These are sent as ordinary transactions whose `to` field is the AccountManager address.

### System contracts

| Name | Hex address | PQ address |
|---|---|---|
| ValidatorRegistry | `0x0000000000000000000000000000000000000001` | derived pq1 form |
| AccountManager | `0x0000000000000000000000000000000000000002` | derived pq1 form |

---

## Module reference

The package root (`shell-sdk`) is the **stable surface** for typical app usage. Lower-level constants and helpers that are more likely to change remain available from subpath imports such as `shell-sdk/signer` and `shell-sdk/transactions`.

### Types

Defined in `src/types.ts`. All types are re-exported from the package root.

| Type | Description |
|---|---|
| `HexString` | Template-literal type `0x${string}` |
| `AddressLike` | Any string accepted as an address |
| `SignatureTypeName` | `"Dilithium3" \| "MlDsa65" \| "SphincsSha2256f"` |
| `ShellTransactionRequest` | Wire format for a Shell transaction |
| `ShellSignature` | `{ sig_type, data: number[] }` |
| `SignedShellTransaction` | Complete signed transaction ready to broadcast |
| `ShellAccessListItem` | EIP-2930 access list entry |
| `ShellTxByAddressPage` | Paginated address history response |
| `ShellKdfParams` | argon2id parameters inside a keystore |
| `ShellCipherParams` | xchacha20-poly1305 nonce inside a keystore |
| `ShellEncryptedKey` | Full encrypted keystore file structure |

---

### Addresses

`import { … } from "shell-sdk/address"`

#### Constants

| Export | Value | Description |
|---|---|---|
| `PQ_ADDRESS_HRP` | `"pq"` | Human-readable part for bech32m encoding |
| `PQ_ADDRESS_LENGTH` | `20` | Address bytes (excluding version byte) |
| `PQ_ADDRESS_VERSION_V1` | `0x01` | Current address version |

#### Functions

| Function | Signature | Description |
|---|---|---|
| `bytesToPqAddress` | `(bytes: Uint8Array, version?) → string` | Encode 20 raw bytes as a `pq1…` bech32m address |
| `pqAddressToBytes` | `(address: string) → Uint8Array` | Decode a `pq1…` address to its 20 raw bytes |
| `pqAddressVersion` | `(address: string) → number` | Extract the version byte from a `pq1…` address |
| `normalizePqAddress` | `(address: string) → string` | Validate and return a `pq1…` address |
| `derivePqAddressFromPublicKey` | `(pk, algoId, version?) → string` | Derive pq1 address from a raw public key |
| `isPqAddress` | `(address: string) → boolean` | Return `true` if the string is a valid pq1 address |

**Examples:**

```typescript
import {
  derivePqAddressFromPublicKey,
  isPqAddress,
  normalizePqAddress,
} from "shell-sdk/address";

const address = derivePqAddressFromPublicKey(publicKey, 1 /* MlDsa65 */);
// → "pq1qx3f…"

console.log(isPqAddress(address)); // true

// Validation / normalisation
normalizePqAddress("pq1qx3f…");  // → "pq1qx3f…" (unchanged)
normalizePqAddress("0xabcdef…"); // throws: expected a pq1… bech32m address
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
| `getTransactionsByAddress(address, opts)` | `shell_getTransactionsByAddress` with optional `fromBlock/toBlock/page/limit` |
| `getBlockReceipts(block)` | `eth_getBlockReceipts` → array of receipts |
| `getNodeInfo()` | `shell_getNodeInfo` → `ShellNodeInfo` (version, block height, peer count, storage profile) |
| `getWitness(blockNumberOrHash)` | `shell_getWitness` → `ShellWitnessBundle` or `null` if pruned |
| `getStorageProfile()` | Convenience wrapper around `getNodeInfo()` → `ShellStorageProfile \| undefined` |

**Examples:**

```typescript
import { createShellProvider } from "shell-sdk/provider";

const provider = createShellProvider();

// Standard eth methods via viem
const block = await provider.client.getBlockNumber();
const balance = await provider.client.getBalance({ address: "0x…" });

// Shell-specific methods
const pubkeyHex = await provider.getPqPubkey("pq1…");
const txHash    = await provider.sendTransaction(signedTx);

const history = await provider.getTransactionsByAddress("pq1…", { page: 0, limit: 20 });
```

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
| `getAddress()` | `pq1…` bech32m address |
| `sign(message)` | Sign an arbitrary byte message → signature bytes |
| `buildSignedTransaction(options)` | Sign `txHash` and assemble a `SignedShellTransaction` |

`buildSignedTransaction` options:

| Field | Type | Description |
|---|---|---|
| `tx` | `ShellTransactionRequest` | The unsigned transaction |
| `txHash` | `Uint8Array` | RLP-encoded hash to sign |
| `includePublicKey?` | `boolean` | Embed `sender_pubkey` for first-time senders |

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
  to: "pq1recipient…",
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
  from: "pq1sender…",
  tx,
  signature: sigBytes,
  signatureType: "MlDsa65",
  senderPubkey: publicKey, // optional
});
```

#### `hashTransaction`

RLP-encode a `ShellTransactionRequest` using the Rust node's canonical field order and return its **keccak256** hash as a `Uint8Array`. This is the value you must pass as `txHash` to `signer.buildSignedTransaction`.

Shell Chain signs the full unsigned transaction payload in this order:

`[chainId, nonce, to, value, data, gasLimit, maxFeePerGas, maxPriorityFeePerGas, accessList, txType, blobFeeFlag, maxFeePerBlobGas, blobVersionedHashes]`

```typescript
import { buildTransferTransaction, hashTransaction } from "shell-sdk/transactions";

const tx     = buildTransferTransaction({ chainId: 424242, nonce: 0, to: "pq1…", value: 1n });
const txHash = hashTransaction(tx);              // Uint8Array (32 bytes)
const signed = await signer.buildSignedTransaction({ tx, txHash });
```

---

### System contracts

`import { … } from "shell-sdk/system-contracts"`

#### Addresses

| Export | Value |
|---|---|
| `validatorRegistryHexAddress` | `0x0000000000000000000000000000000000000001` |
| `accountManagerHexAddress` | `0x0000000000000000000000000000000000000002` |
| `validatorRegistryAddress` | pq1 bech32m form of above |
| `accountManagerAddress` | pq1 bech32m form of above |

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

isSystemContractAddress("0x0000000000000000000000000000000000000002"); // true
```

---

### Keystore

`import { … } from "shell-sdk/keystore"`

Shell keystore files are JSON objects encrypted with **argon2id** (KDF) and **xchacha20-poly1305** (cipher). The `shell` CLI generates compatible files.

#### Keystore format

```jsonc
{
  "version": 1,
  "address": "pq1…",
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
console.log(parsed.canonicalAddress); // pq1…
console.log(parsed.signatureType);    // "MlDsa65"

// Decrypt
const signer = await decryptKeystore(json, "my-passphrase");
console.log(signer.getAddress()); // pq1…
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
const from    = signer.getAddress();      // pq1…

console.log("Address:", from);

// 2. Connect to devnet
const provider = createShellProvider(); // defaults to http://127.0.0.1:8545

// 3. Get current nonce
const nonce = await provider.client.getTransactionCount({ address: from });

// 4. Build the transaction
const tx = buildTransferTransaction({
  chainId: 424242,
  nonce,
  to: "pq1recipientaddress…",
  value: parseEther("0.5"),
});

// 5. RLP-encode and hash for signing
//    (Shell uses the same EIP-1559 signing hash as Ethereum)
const txHash = hashTransaction(tx);

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
  to: "pq1dest…",
  value: parseEther("10"),
});

const txHash = hashTransaction(tx);
const signed = await signer.buildSignedTransaction({ tx, txHash });
const hash   = await provider.sendTransaction(signed);
console.log(hash);
```

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
  const txHash = hashTransaction(tx);
  const signed = await signer.buildSignedTransaction({ tx, txHash, includePublicKey: nonce === 0 });

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

const account = normalizePqAddress("pq1qx3f...");
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

const txHash = hashTransaction(tx);

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
| `expected 20 address bytes, got N` | Wrong-length bytes passed to address helpers |
| `expected pq address prefix, got X` | bech32m prefix is not `pq` |
| `invalid bech32m address` | String is not a valid bech32m address |
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

// Any value accepted as an address (pq1… or 0x…)
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
| [`@scure/base`](https://github.com/paulmillr/scure-base) | bech32m encoding |
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
| Address format | bech32m, prefix `pq`, version byte `0x01` |
| Default tx type | 2 (EIP-1559) |
| Default gas limit (transfer) | 21 000 |
| Default gas limit (system) | 100 000 |
| Default max fee per gas | 1 Gwei |

For full chain documentation, validator setup, and the Shell CLI reference, see the project wiki or official docs site.
