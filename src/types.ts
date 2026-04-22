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
  /** Transaction type; defaults to `2` (EIP-1559). */
  tx_type?: number;
  /** EIP-4844 max fee per blob gas unit. */
  max_fee_per_blob_gas?: number | null;
  /** EIP-4844 blob versioned hashes. */
  blob_versioned_hashes?: HexString[] | null;
}

/**
 * The name of a supported post-quantum signature algorithm.
 *
 * - `"Dilithium3"` — Round-3 Dilithium (algorithm ID 0); uses the ML-DSA-65 implementation as a stand-in.
 * - `"MlDsa65"` — NIST FIPS 204 ML-DSA-65 (algorithm ID 1).
 * - `"SphincsSha2256f"` — NIST FIPS 205 SLH-DSA-SHA2-256f (algorithm ID 2).
 */
export type SignatureTypeName = "Dilithium3" | "MlDsa65" | "SphincsSha2256f";

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
}

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
  /** Node software version string, e.g. `"shell-node/0.17.0"`, independent of the SDK package version. */
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
