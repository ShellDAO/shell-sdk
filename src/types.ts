/** A `0x`-prefixed hex string, e.g. `"0xdeadbeef"`. */
export type HexString = `0x${string}`;

/** Any string accepted as an address — either a `pq1…` bech32m address or a `0x…` hex address. */
export type AddressLike = string;

/** A single entry in an EIP-2930 access list. */
export interface ShellAccessListItem {
  address: AddressLike;
  storage_keys: HexString[];
}

/**
 * Wire format for a Shell Chain transaction, sent as part of a {@link SignedShellTransaction}.
 *
 * Mirrors the JSON structure expected by the `shell_sendTransaction` RPC method.
 * Use the builder helpers in `transactions.ts` rather than constructing this object manually.
 */
export interface ShellTransactionRequest {
  /** EIP-155 chain ID. Devnet = 424242. */
  chain_id: number;
  /** Sender account nonce. */
  nonce: number;
  /** Recipient address (pq1… or 0x…), or `null` for contract deployment. */
  to: AddressLike | null;
  /** Transfer value as a hex-encoded bigint string, e.g. `"0xde0b6b3a7640000"`. */
  value: string;
  /** ABI-encoded call data, or `"0x"` for plain transfers. */
  data: HexString;
  /** Maximum gas units the transaction may consume. */
  gas_limit: number;
  /** EIP-1559 maximum fee per gas unit (in wei). */
  max_fee_per_gas: number;
  /** EIP-1559 priority fee (tip) per gas unit (in wei). */
  max_priority_fee_per_gas: number;
  /** Optional EIP-2930 access list. */
  access_list?: ShellAccessListItem[] | null;
  /** Transaction type; defaults to `2` (EIP-1559). AA bundle uses `0x7E`. */
  tx_type?: number;
  /** EIP-4844 max fee per blob gas unit. */
  max_fee_per_blob_gas?: number | null;
  /** EIP-4844 blob versioned hashes. */
  blob_versioned_hashes?: HexString[] | null;
}

/**
 * The name of a supported post-quantum signature algorithm.
 *
 * - `"ML-DSA-65"` — NIST FIPS 204 ML-DSA-65 (canonical name, algorithm ID 0); preferred.
 * - `"Dilithium3"` — Compatibility alias for `"ML-DSA-65"` (same wire format, algorithm ID 0).
 * - `"MlDsa65"` — Legacy camelCase alias for `"ML-DSA-65"` (algorithm ID 0); still accepted.
 * - `"SphincsSha2256f"` — NIST FIPS 205 SLH-DSA-SHA2-256f (algorithm ID 2).
 */
export type SignatureTypeName = "ML-DSA-65" | "Dilithium3" | "MlDsa65" | "SphincsSha2256f";

/**
 * A post-quantum signature attached to a transaction.
 *
 * `data` contains the raw signature bytes serialised as a plain number array
 * to ensure JSON compatibility without base64 encoding overhead.
 */
export interface ShellSignature {
  /** Algorithm that produced this signature. */
  sig_type: SignatureTypeName;
  /** Raw signature bytes as a JS number array. */
  data: number[];
}

// ---------------------------------------------------------------------------
// Native AA types (v0.18.0)
// ---------------------------------------------------------------------------

/**
 * Transaction type byte for AA bundle transactions.
 *
 * `0x7E` — carries a {@link AaBundle} with N inner calls and an optional paymaster.
 */
export const AA_BUNDLE_TX_TYPE = 0x7e;

/**
 * Maximum number of inner calls per AA bundle.
 */
export const AA_MAX_INNER_CALLS = 16;

/**
 * A single call within an AA batch bundle.
 *
 * Mirrors `InnerCall` on the chain side.
 */
export interface AaInnerCall {
  /** Recipient address, or `null` for contract creation. */
  to: AddressLike | null;
  /** Value in wei as a hex string (e.g. `"0x0"`, `"0xde0b6b3a7640000"`). JSON-safe. */
  value: HexString;
  /** ABI-encoded calldata. */
  data: HexString;
  /** Gas limit for this inner call. */
  gas_limit: number;
}

/**
 * The AA bundle payload attached to a `tx_type = 0x7E` transaction.
 *
 * All inner calls execute atomically under a single PQ signature covering
 * the outer envelope + bundle (via `batch_signing_hash`).
 */
export interface AaBundle {
  /** Ordered list of inner calls to execute. Max {@link AA_MAX_INNER_CALLS}. */
  inner_calls: AaInnerCall[];
  /**
   * Optional paymaster address paying the gas cost.
   * When set, `paymaster_signature` must also be provided.
   */
  paymaster?: AddressLike | null;
  /**
   * Paymaster's PQ signature over the `paymaster_signing_hash`.
   * Required when `paymaster` is set.
   */
  paymaster_signature?: number[] | null;
}

/**
 * A fully-signed Shell Chain transaction ready to broadcast via `shell_sendTransaction`.
 *
 * @example
 * ```typescript
 * const signed: SignedShellTransaction = await signer.buildSignedTransaction({ tx, txHash });
 * const hash = await provider.sendTransaction(signed);
 * ```
 */
export interface SignedShellTransaction {
  /** Sender address (pq1… bech32m form). */
  from: AddressLike;
  /** The unsigned transaction payload. */
  tx: ShellTransactionRequest;
  /** PQ signature produced by the sender's private key. */
  signature: ShellSignature;
  /**
   * Raw public key bytes of the sender.
   * Required when the account has not yet appeared on-chain so the node can
   * verify the address derivation. Pass `null` for subsequent transactions.
   */
  sender_pubkey?: number[] | null;
  /**
   * AA bundle payload. Present only when `tx.tx_type === AA_BUNDLE_TX_TYPE`.
   */
  aa_bundle?: AaBundle | null;
}

// ---------------------------------------------------------------------------
// AA RPC types (v0.18.0)
// ---------------------------------------------------------------------------

/**
 * A single inner call entry in a `shell_estimateBatch` request.
 */
export interface ShellBatchInnerCallRequest {
  /** Recipient address, or `null`. */
  to?: AddressLike | null;
  /** Value as hex string (e.g. `"0x0"`). */
  value?: string | null;
  /** ABI-encoded calldata. */
  data?: HexString | null;
  /** Gas limit as hex string. If absent, the node simulates to estimate. */
  gas_limit?: string | null;
}

/**
 * Request body for `shell_estimateBatch`.
 */
export interface ShellEstimateBatchRequest {
  /** Nominal sender address for simulation. Defaults to zero address. */
  from?: AddressLike | null;
  /** Optional paymaster (informational; does not affect gas estimate). */
  paymaster?: AddressLike | null;
  /** Inner calls to estimate. */
  inner_calls: ShellBatchInnerCallRequest[];
}

/**
 * Per-inner-call estimate entry returned by `shell_estimateBatch`.
 */
export interface ShellBatchInnerGas {
  /** Gas limit as hex string. */
  gas_limit: string;
  /** `true` if the node simulated this call (no `gas_limit` was provided). */
  simulated: boolean;
}

/**
 * Response from `shell_estimateBatch`.
 */
export interface ShellEstimateBatchResult {
  /** Total gas (outer intrinsic + inner sum + surcharge) as hex string. */
  total_gas: string;
  /** Outer transaction intrinsic gas (always `"0x5208"` = 21 000). */
  outer_intrinsic: string;
  /** Sum of all inner gas limits as hex string. */
  inner_sum: string;
  /** Per-extra-inner-call intrinsic surcharge as hex string. */
  intrinsic_surcharge: string;
  /** Per-inner gas estimates. */
  per_inner: ShellBatchInnerGas[];
  /** Paymaster echoed back (if supplied in request). */
  paymaster?: AddressLike | null;
}

/**
 * Paymaster policy returned by `shell_getPaymasterPolicy`.
 */
export interface ShellPaymasterPolicy {
  /** Paymaster address (pq1… form). */
  address: AddressLike;
  /** `true` if a PQ pubkey has been registered on-chain for this address. */
  has_pq_pubkey: boolean;
  /** Pubkey byte length (if present). */
  pubkey_bytes?: number | null;
  /** SHELL balance of the paymaster as hex string. */
  balance: string;
  /** Policy type; currently always `"eoa-open"`. */
  policy: string;
  /** Maximum gas sponsorship cap (null = uncapped). */
  max_gas_sponsorship?: string | null;
}

/**
 * Response from `shell_isSponsored`.
 */
export interface ShellIsSponsoredResult {
  /** `true` if the transaction was found (mempool or chain). */
  found: boolean;
  /** `true` if the transaction is sponsored by a paymaster. */
  sponsored: boolean;
  /** Where the transaction was found: `"mempool"`, `"chain"`, or `null`. */
  location: "mempool" | "chain" | null;
  /** `true` if the transaction is a native AA bundle. */
  is_aa_bundle: boolean;
  /** Paymaster address, or `null` if not sponsored. */
  paymaster: AddressLike | null;
  /** Sender address. */
  sender: AddressLike | null;
  /** Number of inner calls in the bundle, or `null` for non-AA txs. */
  inner_call_count: number | null;
}

/**
 * Result returned by `shell_verifyWitnessRoot`.
 */
export interface ShellWitnessRootResult {
  /** The block number that was verified (as hex string). */
  block: string;
  /** The witness root stored in the block header (hex). */
  witness_root: string;
  /** The recomputed root from the bundle signatures (hex). */
  bundle_root: string;
  /** `true` if `witness_root === bundle_root`. */
  match: boolean;
}

// ---------------------------------------------------------------------------
// Node / storage types (carried over from 0.3.x, updated)
// ---------------------------------------------------------------------------

/**
 * Node storage profile as advertised via the `StorageCapability` P2P message.
 *
 * - `"archive"` — all TX bodies and PQ witnesses kept forever; STARK proofs never replace witnesses.
 * - `"full"` — TX bodies kept forever; PQ witnesses replaced by STARK proofs when they arrive.
 * - `"light"` — rolling ~4096-block window; older data pruned.
 */
export type ShellStorageProfile = "archive" | "full" | "light";

/**
 * Response from `shell_getNodeInfo`.
 *
 * Contains runtime metadata about the connected Shell Chain node.
 */
export interface ShellNodeInfo {
  /** Node software version string, e.g. `"shell-node/0.18.0"`. */
  version: string;
  /** Chain ID as a decimal string. */
  chain_id: string;
  /** Current head block number (decimal). */
  block_height: number;
  /** libp2p peer ID of this node. */
  peer_id: string;
  /** Number of currently connected peers. */
  peer_count: number;
  /** Active storage profile. */
  storage_profile?: ShellStorageProfile;
  /** Oldest block number for which this node has full body data. */
  oldest_body_block?: number;
}

/**
 * A single PQ transaction witness from `shell_getBlockWitnesses` / `shell_getWitness`.
 */
export interface ShellTxWitness {
  /** Zero-based transaction index within the block. */
  tx_index: number;
  /** Signature algorithm name. */
  sig_type: SignatureTypeName;
  /** Raw signature bytes as hex string. */
  signature: string;
  /** Raw public key bytes as hex string (only present on first-use txs). */
  public_key?: string;
}

/**
 * Response from `shell_getWitness` for a single block.
 */
export interface ShellWitnessBundle {
  /** Block hash (0x-prefixed). */
  block_hash: string;
  /** Block number. */
  block_number: number;
  /** Number of witnesses in this bundle. */
  witness_count: number;
  /** Individual transaction witnesses. */
  witnesses: ShellTxWitness[];
  /**
   * Merkle root of the witness bundle (stored in the block header).
   * Present on archive/full nodes.
   */
  witness_root?: string;
}

/** Paginated response from `shell_getTransactionsByAddress`. */
export interface ShellTxByAddressPage {
  address: AddressLike;
  page: number;
  limit: number;
  total: number;
  transactions: unknown[];
}

/** Parameters for `shell_sendTransaction`. */
export interface ShellSendTransactionParams {
  signedTransaction: SignedShellTransaction;
}

/** argon2id KDF parameters stored in a Shell keystore file. */
export interface ShellKdfParams {
  /** Memory cost in KiB (argon2id `m`). */
  m_cost: number;
  /** Time cost / iteration count (argon2id `t`). */
  t_cost: number;
  /** Parallelism factor (argon2id `p`). */
  p_cost: number;
  /** Hex-encoded random salt. */
  salt: string;
}

/** xchacha20-poly1305 cipher parameters stored in a Shell keystore file. */
export interface ShellCipherParams {
  /** Hex-encoded 24-byte nonce. */
  nonce: string;
}

/**
 * The JSON structure of an encrypted Shell keystore file.
 *
 * Generated by the Shell CLI (`shell key generate`). Decrypt with
 * {@link decryptKeystore} from `keystore.ts`.
 *
 * Plaintext layout after decryption: `[secret_key_bytes][public_key_bytes]`.
 */
export interface ShellEncryptedKey {
  /** Schema version (currently `1`). */
  version: number;
  /** bech32m `pq1…` address corresponding to the encrypted key. */
  address: string;
  /** Key algorithm identifier string, e.g. `"mldsa65"` or `"sphincs-sha2-256f"`. */
  key_type: string;
  /** KDF algorithm name; currently always `"argon2id"`. */
  kdf: string;
  /** argon2id parameters. */
  kdf_params: ShellKdfParams;
  /** Cipher algorithm name; currently always `"xchacha20-poly1305"`. */
  cipher: string;
  /** Cipher nonce. */
  cipher_params: ShellCipherParams;
  /** Hex-encoded authenticated ciphertext (includes poly1305 tag). */
  ciphertext: string;
  /** Hex-encoded raw public key bytes. */
  public_key: string;
}

