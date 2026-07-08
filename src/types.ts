/** A `0x`-prefixed hex string, e.g. `"0xdeadbeef"`. */
export type HexString = `0x${string}`;

/**
 * A `0x`-prefixed hex-encoded unsigned integer quantity (JSON-RPC "QUANTITY"
 * type), e.g. `"0x0"`, `"0x5208"`. No leading zeros (except `"0x0"` itself).
 * Assignable to `HexString`; use where the value is always a non-negative
 * integer (gas limits, values, nonces).
 */
export type HexQuantity = HexString;

/** A `0x`-prefixed 64-char hex address string (Shell Chain canonical address format). */
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
  /** Recipient address (`0x…` hex format), or `null` for contract deployment. */
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
 * - `"ML-DSA-65"` — NIST FIPS 204 ML-DSA-65 (canonical name, algorithm ID 1); preferred.
 * - `"Dilithium3"` — Round-3 Dilithium compatibility scheme (algorithm ID 0).
 * - `"MlDsa65"` — Legacy camelCase alias for `"ML-DSA-65"` (algorithm ID 1); still accepted.
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
  /** Gas limit for this inner call as a hex-quantity string (e.g. `"0x5208"` for 21 000). Must be a non-negative integer encoded per JSON-RPC QUANTITY rules. */
  gas_limit: HexQuantity;
}

/**
 * The AA bundle payload attached to a `tx_type = 0x7E` transaction.
 *
 * All inner calls execute atomically under a single PQ signature covering
 * the outer envelope + bundle (via `batch_signing_hash`).
 *
 * ## AA Phase 2 extensions (v0.19.0-dev)
 *
 * - **Contract paymaster** (`paymaster_context`): pass opaque bytes to a
 *   contract paymaster's `validatePaymasterOp` on-chain. Mutually exclusive
 *   with `paymaster_signature` (off-chain/EOA paymaster).
 * - **Session keys** (`session_auth`): attach a short-lived sub-key
 *   authorization instead of the root PQ key.
 */
export interface AaBundle {
  /** Ordered list of inner calls to execute. Max {@link AA_MAX_INNER_CALLS}. */
  inner_calls: AaInnerCall[];
  /**
   * Optional paymaster address paying the gas cost.
   *
   * - EOA/off-chain paymaster: set `paymaster_signature` (not `paymaster_context`).
   * - Contract paymaster: set `paymaster_context` (not `paymaster_signature`).
   */
  paymaster?: AddressLike | null;
  /**
   * Paymaster's PQ signature over the `paymaster_signing_hash`.
   * Required for EOA/off-chain paymaster. Mutually exclusive with `paymaster_context`.
   */
  paymaster_signature?: number[] | null;
  /**
   * Opaque context bytes forwarded to `IPaymaster.validatePaymasterOp`.
   * Required for contract paymaster. Mutually exclusive with `paymaster_signature`.
   * Max 4096 bytes.
   */
  paymaster_context?: number[] | null;
  /**
   * Session key authorization. When set the root signature field belongs to
   * the session `root_signature` and `session_signature` pair, not the root
   * key signing the tx directly.
   */
  session_auth?: SessionAuth | null;
}

// ---------------------------------------------------------------------------
// AA Phase 2 types (v0.19.0-dev)
// ---------------------------------------------------------------------------

/**
 * Maximum length of `paymaster_context` bytes (4096 bytes).
 */
export const AA_MAX_PAYMASTER_CONTEXT = 4096;

/**
 * Extra PQ verify gas cost per session key authorization (2 × PQ_VERIFY_GAS = 20 000).
 * Added to intrinsic gas when a session key is used.
 */
export const AA_SESSION_KEY_GAS_SURCHARGE = 20_000;

/**
 * Session key authorization attached to an AA bundle.
 *
 * Allows a short-lived sub-key to authorize a transaction on behalf of the
 * root account, with optional restrictions on target address and value cap.
 *
 * ## Spec (AA_PHASE2_SPEC.md §4)
 *
 * 1. `session_pubkey` and `session_algo` are authorized by the root key's
 *    `root_signature` over
 *    `auth_hash = blake3(PQTX_SESSION_V1\0 (16B) || session_pubkey || session_algo(1B) || target(32B|zero) || value_cap(32B BE) || expiry_block(8B BE) || chain_id(8B BE))`.
 * 2. The transaction is signed by `session_pubkey` via `session_signature`.
 * 3. `expiry_block` must be > current block at validation time.
 * 4. Σ(inner_call.value) ≤ `value_cap`.
 * 5. If `target` is set, all inner calls must target that address.
 *
 * @example
 * ```typescript
 * const sessionAuth: SessionAuth = {
 *   session_pubkey: Array.from(sessionPubkeyBytes),
 *   session_algo: 1, // ML-DSA-65
 *   target: null,
 *   value_cap: "0xde0b6b3a7640000",
 *   expiry_block: 500,
 *   root_signature: Array.from(rootSigBytes),
 *   session_signature: Array.from(sessionSigBytes),
 * };
 * ```
 */
export interface SessionAuth {
  /** Raw bytes of the session public key. */
  session_pubkey: number[];
  /** Algorithm ID of the session key (Dilithium3 = 0, ML-DSA-65 = 1, SphincsSha2256f = 2). */
  session_algo: number;
  /** If set, every inner call in the bundle must target this address. */
  target?: AddressLike | null;
  /** Maximum total value (Σ inner_call.value) permitted in wei as a hex string. */
  value_cap: HexString;
  /** Block number after which the session key is no longer valid (exclusive). */
  expiry_block: number;
  /**
   * Root account's PQ signature over the session key authorization hash.
   * `auth_hash = blake3(PQTX_SESSION_V1\0 (16B) || session_pubkey || session_algo(1B) || target(32B|zero) || value_cap || expiry_block || chain_id)`.
   */
  root_signature: number[];
  /** Session key's PQ signature over the tx `sender_signing_hash()`. */
  session_signature: number[];
}

/**
 * Guardian recovery configuration stored on-chain for an account.
 *
 * Set via `setGuardians` calldata (use {@link encodeSetGuardiansCalldata}).
 */
export interface GuardianConfig {
  /** Guardian addresses (1..=5). */
  guardians: AddressLike[];
  /** Required votes (k-of-n). */
  threshold: number;
  /** Minimum blocks between threshold-reach and execution (≥ 100). */
  timelock: number;
}

/**
 * Active recovery proposal returned by the `shell_getRecoveryProposal` RPC method
 * (if implemented by the node).
 */
export interface RecoveryProposal {
  /** Proposed new PQ public key as a hex string. */
  new_pubkey: HexString;
  /** Algorithm ID of the new public key. */
  new_algo: number;
  /** Guardian addresses that have voted for this proposal. */
  votes: AddressLike[];
  /** Block after which `executeRecovery` may be called (0 = threshold not yet met). */
  maturity_block: number;
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
  /** Sender address (0x… hex form). */
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
// RPC transaction / reward types
// ---------------------------------------------------------------------------

/** Product-level transaction kind emitted by Shell Chain RPC. */
export type ShellKnownRpcTxType =
  | "transfer"
  | "contractCreate"
  | "contractCall"
  | "aaBatch"
  | "blockGasReward"
  | "starkReward";

export type ShellRpcTxType = ShellKnownRpcTxType | (string & {});

/** Reward kind emitted for first-class system reward transactions. */
export type ShellRewardKind = "blockGasReward" | "starkReward";

/** Human-readable transaction label for wallets, explorers, and apps. */
export type ShellReadableTxType =
  | "Transfer"
  | "Contract Create"
  | "Contract Call"
  | "AA Batch"
  | "Block Reward"
  | "STARK Reward"
  | "System"
  | "Transaction";

/**
 * Decoded proof amendment payload for `starkReward` settlement transactions.
 *
 * Populated by the node when `system_tx_to_rpc` decodes the `StarkReward`
 * proof payload; `null` for non-settlement or non-StarkReward transactions.
 */
export interface ShellDecodedProofInput {
  /** STARK compression layer (1 = L1, 2 = L2, …). */
  layer: number;
  /** Terminal block number of the proof range. */
  blockNumber: number;
  /** First block number in the proof range. */
  startBlock: number;
  /** Last block number in the proof range (= blockNumber). */
  endBlock: number;
  /** Number of transaction entries (signatures) compressed. */
  nSigs: number;
  /** Size of the stored proof in bytes. */
  compressedSize: number;
  /** Original (pre-compression) witness size in bytes. */
  originalSize: number;
  /** Hash of the settlement transaction that carried this proof, if finalized. */
  settlementTxHash?: HexString | null;
}

/** Shell Chain `eth_getTransactionByHash` transaction shape. */
export interface ShellRpcTransaction {
  hash: HexString;
  blockHash?: HexString | null;
  blockNumber?: HexString | null;
  transactionIndex?: HexString | null;
  from: AddressLike;
  to?: AddressLike | null;
  value: HexString;
  gas: HexString;
  gasPrice: HexString;
  maxFeePerGas?: HexString;
  maxPriorityFeePerGas?: HexString;
  nonce: HexString;
  input: HexString;
  chainId: HexString;
  type: HexString;
  shellType?: ShellRpcTxType | null;
  rewardKind?: ShellRewardKind | null;
  rewardLayer?: HexString | null;
  rewardSourceHash?: HexString | null;
  originalSize?: HexString | null;
  compressedSize?: HexString | null;
  /** Decoded proof payload for `starkReward` settlement transactions (v0.22+). */
  decodedInput?: ShellDecodedProofInput | null;
}

/** Shell Chain transaction summary returned in block/address transaction lists. */
export interface ShellRpcTransactionSummary {
  hash: HexString;
  blockHash?: HexString | null;
  blockNumber?: HexString | null;
  transactionIndex?: HexString | null;
  from?: AddressLike;
  to?: AddressLike | null;
  value?: HexString;
  type?: HexString;
  hasInput?: boolean;
  shellType?: ShellRpcTxType | null;
  rewardKind?: ShellRewardKind | null;
  rewardLayer?: HexString | null;
  rewardSourceHash?: HexString | null;
  originalSize?: HexString | null;
  compressedSize?: HexString | null;
}

/** Shell Chain transaction receipt shape, including system reward metadata. */
export interface ShellRpcReceipt {
  transactionHash: HexString;
  blockHash: HexString;
  blockNumber: HexString;
  transactionIndex: HexString;
  from: AddressLike;
  to?: AddressLike | null;
  status: HexString;
  gasUsed: HexString;
  cumulativeGasUsed: HexString;
  effectiveGasPrice: HexString;
  contractAddress?: AddressLike | null;
  logs: unknown[];
  logsBloom: HexString;
  type: HexString;
  shellType?: ShellRpcTxType | null;
  rewardKind?: ShellRewardKind | null;
}

/** Return a user-facing transaction type label without leaking EIP wire labels. */
export function formatShellRpcTxType(tx: {
  type?: string | null;
  to?: AddressLike | null;
  hasInput?: boolean;
  input?: string | null;
  shellType?: ShellRpcTxType | null;
  rewardKind?: ShellRewardKind | null;
}): ShellReadableTxType {
  const shellType = tx.shellType ?? tx.rewardKind;
  if (shellType === "blockGasReward") return "Block Reward";
  if (shellType === "starkReward") return "STARK Reward";
  if (shellType === "aaBatch") return "AA Batch";
  if (shellType === "contractCreate") return "Contract Create";
  if (shellType === "contractCall") return "Contract Call";
  if (shellType === "transfer") return "Transfer";
  if (shellType) return "System";
  if (tx.type === "0x7e") return "AA Batch";
  if (tx.to === null) return "Contract Create";
  if (tx.hasInput || (tx.input && tx.input !== "0x")) return "Contract Call";
  if (tx.type === "0x80") return "System";
  if (
    tx.type == null &&
    tx.to === undefined &&
    tx.hasInput === undefined &&
    tx.input === undefined
  ) {
    return "Transaction";
  }
  return "Transfer";
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
 * Request body for `shell_estimatePaymasterGas`.
 */
export interface ShellEstimatePaymasterGasRequest {
  /** Paymaster contract address to query. */
  paymaster: AddressLike;
  /** Bundle sender address. */
  sender: AddressLike;
  /** Raw inner-call bytes forwarded to the future validator simulation. */
  inner_calls_data?: HexString | null;
  /** Max fee per gas as a hex wei quantity. */
  max_fee_per_gas?: string | null;
  /** Opaque context bytes forwarded to `validatePaymasterOp`. */
  paymaster_context?: HexString | null;
}

export type ShellPaymasterSimulationStatus = "cap_only" | "simulated";

/**
 * Response from `shell_estimatePaymasterGas`.
 *
 * Current Shell Chain nodes return `simulation_status: "cap_only"`, which is
 * a versioned partial response exposing only the protocol gas cap. Clients must
 * not treat `validation_gas` or `within_cap` as available unless the status is
 * upgraded to `"simulated"`.
 */
export interface ShellEstimatePaymasterGasResult {
  /** Paymaster address echoed by the node. */
  paymaster: AddressLike;
  /** Sender address echoed by the node. */
  sender: AddressLike;
  /** Estimated validation gas as hex, or null for cap-only responses. */
  validation_gas: string | null;
  /** Protocol gas cap as hex. */
  paymaster_gas_cap: string;
  /** Whether validation gas is within cap, or null for cap-only responses. */
  within_cap: boolean | null;
  /** Capability status for this response. */
  simulation_status: ShellPaymasterSimulationStatus;
  /** Version of the response contract. */
  simulation_version: number;
  /** Node capability string. */
  capability: "paymaster_cap_only" | "paymaster_simulation";
  /** Machine-readable or human-readable reason when partial. */
  reason?: string;
  /** Additional operator/client guidance. */
  note?: string;
}

/**
 * Paymaster policy returned by `shell_getPaymasterPolicy`.
 */
export interface ShellPaymasterPolicy {
  /** Paymaster address (0x… hex form). */
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

/** Result returned by `shell_getBlockWitnesses`. */
export interface ShellBlockWitnessesResult {
  blockHash: HexString;
  witnessRoot: HexString | null;
  witnessRootVerified?: boolean | null;
  witnessCount: number | null;
  witnesses: Array<{
    txIndex: number;
    sigType: SignatureTypeName | string;
    signature: HexString;
    pubkey?: HexString;
  }> | null;
  error?: string;
}

/** Validator status returned by `shell_getValidatorStatus`. */
export interface ShellValidatorStatus {
  address?: AddressLike;
  isValidator?: boolean;
  is_validator?: boolean;
  [key: string]: unknown;
}

/** Governance summary returned by `shell_getGovernanceInfo`. */
export interface ShellGovernanceInfo {
  validatorCount?: number;
  validator_count?: number;
  validators?: AddressLike[];
  systemContractAddress?: AddressLike;
  system_contract_address?: AddressLike;
  proposalGasLimit?: number;
  gasLimit?: HexString | string | number;
  gas_limit?: HexString | string | number;
  [key: string]: unknown;
}

/** Network dashboard payload returned by `shell_getNetworkStats`. */
export interface ShellNetworkStats {
  peerCount?: number;
  peer_count?: number;
  listeningAddress?: string;
  listenAddr?: string;
  listen_addr?: string;
  protocolVersion?: string;
  protocols?: string[];
  [key: string]: unknown;
}

/** Chain dashboard payload returned by `shell_getChainStats`. */
export interface ShellChainStats {
  blockHeight?: number;
  block_height?: number;
  totalTransactions?: number;
  total_transactions?: number;
  avgBlockTime?: number;
  avg_block_time?: number;
  gasUsedTotal?: HexString;
  latestBaseFee?: HexString;
  [key: string]: unknown;
}

/** Finality status returned by `shell_getFinalityInfo`. */
export interface ShellFinalityInfo {
  lastFinalizedBlock?: HexString;
  lastFinalizedHash?: HexString;
  currentHead?: HexString;
  finalityLag?: number;
  pendingAttestations?: number;
  finalizedBlock?: HexString | number | null;
  finalized_block?: HexString | number | null;
  headBlock?: HexString | number | null;
  head_block?: HexString | number | null;
  pending_attestations?: number;
  [key: string]: unknown;
}

/** Commit certificate returned by `shell_finalityProof`. */
export interface ShellFinalityProof {
  blockHash: HexString;
  certificate: Record<AddressLike, HexString> | null;
  [key: string]: unknown;
}

/** Consensus engine status returned by `shell_consensusInfo`. */
export interface ShellConsensusInfo {
  engine?: string;
  validators?: Array<{ address: AddressLike; weight?: number | string; [key: string]: unknown }>;
  current_proposer?: AddressLike | null;
  currentProposer?: AddressLike | null;
  block_number?: number;
  blockNumber?: number;
  epoch?: number | string | null;
  epoch_length?: number | string;
  epochLength?: number | string;
  epoch_progress?: number | string | null;
  epochProgress?: number | string | null;
  [key: string]: unknown;
}

/** STARK proof amendment returned by `shell_getProofAmendment`. */
export interface ShellProofAmendment {
  block_hash?: HexString;
  blockHash?: HexString;
  block_number?: number;
  blockNumber?: number;
  start_block?: number;
  end_block?: number;
  source_hash?: HexString;
  source_block?: number;
  target_hash?: HexString;
  targetHash?: HexString;
  target_block?: number;
  targetBlock?: number;
  source_count?: number;
  layer?: number;
  proof_entries?: number;
  original_size?: number | null;
  compressed_size?: number | null;
  proof_version?: number;
  prover?: AddressLike;
  settlement_tx_hash?: HexString | null;
  proof?: HexString | null;
  [key: string]: unknown;
}

export type ShellProofAmendmentResult = ShellProofAmendment | null;

export type ShellAlgorithmStatus = "active" | "deprecated" | "pending_activation";

/** One algorithm registry row returned by `shell_getAlgorithmRegistry`. */
export interface ShellAlgorithmRegistryEntry {
  algo: SignatureTypeName | string;
  status: ShellAlgorithmStatus | string;
  description?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Node / storage types (carried over from 0.3.x, updated)
// ---------------------------------------------------------------------------

/**
 * Node storage profile name.
 *
 * - `"archive"` — all TX bodies and PQ witnesses kept forever; STARK proofs never replace witnesses.
 * - `"full"` — TX bodies kept forever; PQ witnesses replaced by STARK proofs when they arrive.
 * - `"pruned"` — canonical RPC name for the rolling ~4096-block window.
 * - `"light"` — legacy CLI/P2P alias for the rolling profile.
 */
export type ShellStorageProfile = "archive" | "full" | "pruned" | "light";

/**
 * Effective storage profile descriptor returned by `shell_getStorageProfile`
 * and embedded in capability/snapshot responses.
 */
export interface ShellStorageProfileInfo {
  profile: Exclude<ShellStorageProfile, "light">;
  bodyRetention: number;
  witnessRetention: number;
  keepRecent: number;
  proofReplacementGrace: number;
  statePruningExperimental: boolean;
}

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
  /** Inclusive lower block bound used for the query, hex-encoded. */
  from_block?: HexString;
  /** Inclusive upper block snapshot used for the query, hex-encoded. */
  to_block?: HexString;
  /** Inclusive lower block bound used for the query, hex-encoded. */
  fromBlock?: HexString;
  /** Inclusive upper block snapshot used for the query, hex-encoded. */
  toBlock?: HexString;
  page: number;
  limit: number;
  total: number;
  transactions: ShellRpcTransactionSummary[];
}

export interface ShellTxByAddressV2Options {
  fromBlock?: number | HexString;
  toBlock?: number | HexString;
  cursor?: string | null;
  limit?: number;
  direction?: "asc" | "desc";
  detail?: "summary" | "full" | "hashes" | "none";
  includeTotal?: boolean;
}

/** Cursor-paginated response from `shell_getTransactionsByAddressV2`. */
export interface ShellTxByAddressV2Page {
  address: AddressLike;
  fromBlock: HexString;
  toBlock: HexString;
  limit: number;
  direction: "asc" | "desc";
  total?: number | null;
  nextCursor?: string | null;
  hasMore: boolean;
  items: Array<ShellRpcTransactionSummary | ShellRpcTransaction | HexString>;
}

export type ShellRpcListDirection = "asc" | "desc";
export type ShellRpcV2TxDetail = "none" | "hashes" | "summary" | "full";

/** Options for `shell_getBlocksRange`. */
export interface ShellBlocksRangeOptions {
  direction?: ShellRpcListDirection;
  limit?: number;
  txDetail?: ShellRpcV2TxDetail;
  txLimit?: number;
}

/** Compact block shape returned by Shell RPC v2 aggregate endpoints. */
export interface ShellRpcBlock {
  number?: HexString | null;
  hash?: HexString | null;
  parentHash?: HexString | null;
  timestamp?: HexString | null;
  miner?: AddressLike | null;
  proposer?: AddressLike | null;
  gasUsed?: HexString | null;
  gasLimit?: HexString | null;
  baseFeePerGas?: HexString | null;
  transactionCount?: number;
  transactions?: Array<ShellRpcTransactionSummary | ShellRpcTransaction | HexString>;
  [key: string]: unknown;
}

/** Response from `shell_getBlocksRange`. */
export interface ShellBlocksRange {
  start: string;
  direction: ShellRpcListDirection;
  limit: number;
  blocks: ShellRpcBlock[];
  nextStart?: HexString | null;
}

/** Options for `shell_getAddressSummary`. */
export interface ShellAddressSummaryOptions {
  recentLimit?: number;
  includeTotal?: boolean;
}

/** Account state plus a small cursor-paginated recent transaction page. */
export interface ShellAddressSummary {
  address: AddressLike;
  balance: HexString;
  nonce: HexString;
  exists: boolean;
  hasCode: boolean;
  codeHash?: HexString | null;
  pqPubkeyRegistered: boolean;
  totalTransactions?: number | null;
  recentTransactions: ShellTxByAddressV2Page;
}

export interface ShellRpcCapabilities {
  rpcVersion: string;
  methods: string[];
  maxPageSize: number;
  maxBlocksRange: number;
  maxTxSummaryPerBlock: number;
  supportsCursorPagination: boolean;
  supportsAddressHistoryIndex: boolean;
  witnessStore: boolean;
  storageProfile?: ShellStorageProfileInfo;
  fallbackMethods: string[];
}

export interface ShellTransactionSummaryResult {
  transaction?: ShellRpcTransactionSummary | ShellRpcTransaction | null;
  receipt?: ShellRpcReceipt | null;
  status?: HexString | null;
  gasUsed?: HexString | null;
  logCount?: number | null;
  timestamp?: HexString | null;
}

export interface ShellChainSnapshot {
  chainId: HexString;
  head?: unknown;
  finalized?: unknown;
  finalityLag: number;
  pendingTransactions: HexString;
  peerCount: number;
  isMining: boolean;
  uptime: number;
  baseFee: HexString;
  gasPrice: HexString;
  totalTransactions: number;
  gasUsedTotal: HexString;
  avgBlockTime: number;
  consensus: unknown;
  validators: unknown;
  storageProfile?: ShellStorageProfileInfo;
}

export interface ShellValidatorSnapshotOptions {
  /** Recent proposer stats window. The node defaults to 200 and accepts 1..1000. */
  proposerWindow?: number;
}

export interface ShellProposerStats {
  address: AddressLike;
  blocksProposed: number;
  lastSeenBlock: number;
  [key: string]: unknown;
}

/** Validator/proposer aggregate returned by `shell_getValidatorSnapshot`. */
export interface ShellValidatorSnapshot {
  validators: unknown;
  currentProposer: unknown;
  blockNumber: number;
  epoch: unknown;
  epochLength: unknown;
  epochProgress: unknown;
  proposerWindow: number;
  proposerStats: ShellProposerStats[];
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
  /** `0x`-prefixed hex address corresponding to the encrypted key. */
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
