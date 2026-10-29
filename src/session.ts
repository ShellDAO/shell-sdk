/**
 * Shell AA Phase 2: Session Key support.
 *
 * Provides utilities for creating and using time-bounded delegated signing keys
 * (session keys) in AA bundles. Session keys let a root account authorize a
 * short-lived sub-key to sign transactions on its behalf, with optional
 * restrictions on target address and value cap.
 *
 * ## Usage flow
 *
 * ```typescript
 * import {
 *   mnemonicToSeed, deriveAccount, deriveSessionKey, MlDsa65Adapter,
 *   createSessionAuth, finalizeSessionAuth, buildBatchTransaction,
 *   buildSessionKeyTransaction, buildInnerCall, hashBatchTransaction,
 *   buildSignedTransaction,
 * } from "shell-sdk";
 *
 * // Run inside the wallet's privileged signer with an unlocked mnemonic.
 * const seed = mnemonicToSeed(mnemonic, passphrase);
 * const rootAccount = deriveAccount(seed, "ml-dsa-65");
 * const sessionAccount = deriveSessionKey(seed, "ml-dsa-65", 0);
 * const rootAdapter = MlDsa65Adapter.fromKeyPair(rootAccount.publicKey, rootAccount.secretKey);
 * const sessionAdapter = MlDsa65Adapter.fromKeyPair(sessionAccount.publicKey, sessionAccount.secretKey);
 * let signed;
 * try {
 *   const draftAuth = await createSessionAuth(rootAdapter, sessionAccount.publicKey, sessionAccount.algoId, {
 *     chainId: BigInt(chainId), expiryBlock, valueCap: 2n, target,
 *   });
 *   rootAdapter.dispose();
 *   rootAccount.secretKey.fill(0);
 *
 *   const options = {
 *     chainId, nonce, innerCalls: [buildInnerCall(target, calldata, 100000, 2n)],
 *     gasLimit: 500000, maxFeePerGas: 1000000000000, maxPriorityFeePerGas: 0,
 *   };
 *   const draft = buildBatchTransaction(options);
 *   draft.aa_bundle.session_auth = draftAuth;
 *   const signingHash = hashBatchTransaction(draft.tx, draft.aa_bundle, "MlDsa65");
 *   const finalAuth = await finalizeSessionAuth(draftAuth, sessionAdapter, signingHash);
 *   const { tx, aa_bundle } = buildSessionKeyTransaction({ ...options, sessionAuth: finalAuth });
 *   signed = buildSignedTransaction({
 *     from: rootAccount.address, tx, aaBundle: aa_bundle,
 *     signature: finalAuth.session_signature, signatureType: "MlDsa65",
 *     senderPubkey: rootAccount.publicKey,
 *   });
 * } finally {
 *   rootAdapter.dispose(); sessionAdapter.dispose();
 *   rootAccount.secretKey.fill(0); sessionAccount.secretKey.fill(0); seed.fill(0);
 * }
 * // Submit signed with provider.sendTransaction(signed).
 * ```
 *
 * @see AA-PHASE-2-SPEC.md §4 for the protocol specification
 * @module session
 */

import { blake3 } from "@noble/hashes/blake3";
import { concatBytes } from "@noble/hashes/utils";
import type { SessionAuth, AddressLike } from "./types.js";
import { shellAddressToBytes } from "./address.js";
import type { SignerAdapter } from "./signer.js";
import { validateNonNegativeBigInt, validateNonNegativeInteger } from "./validation.js";

// ── Domain separator ──────────────────────────────────────────────────────────

/**
 * Session key authorization domain separator (matches Rust `PQTX_SESSION_DOMAIN`).
 * `b"PQTX_SESSION_V2\0"` — 16 bytes.
 */
export const PQTX_SESSION_DOMAIN = new Uint8Array([
  0x50, 0x51, 0x54, 0x58, // PQTX
  0x5f, 0x53, 0x45, 0x53, // _SES
  0x53, 0x49, 0x4f, 0x4e, // SION
  0x5f, 0x56, 0x32, 0x00, // _V2\0
]); // b"PQTX_SESSION_V2\0"

/** Maximum session public-key size accepted by Shell Chain nodes. */
export const MAX_SESSION_PUBKEY_BYTES = 4 * 1024;

/** Maximum session or root signature size accepted by Shell Chain nodes. */
export const MAX_SESSION_SIGNATURE_BYTES = 51_200;

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Configuration for creating a session key authorization.
 */
export interface SessionKeyConfig {
  /** Chain ID of the target chain (prevents cross-chain replay). */
  chainId: bigint;
  /** First candidate block height at which the session key is invalid (exclusive upper bound). */
  expiryBlock: number;
  /** Maximum total native value (wei) across all inner calls per transaction. */
  valueCap: bigint;
  /**
   * If set, all inner calls in the bundle must target this address.
   * `null` means any target is allowed.
   */
  target: AddressLike | null;
}

// ── Auth hash ─────────────────────────────────────────────────────────────────

/**
 * Compute the session key authorization hash that the root key must sign.
 *
 * `auth_hash = blake3(PQTX_SESSION_V2\0(16B) || session_pubkey || session_algo(1B) || target_present(1B) || target(32B|zero) || value_cap(32B BE) || expiry_block(8B BE) || chain_id(8B BE))`
 *
 * This hash binds the session key to a specific chain, expiry, value cap,
 * and optional target, preventing unauthorized delegation.
 *
 * @param sessionPubkey - Raw bytes of the session public key.
 * @param sessionAlgoId - Session signature algorithm ID.
 * @param config - Session key constraints.
 * @returns 32-byte BLAKE3 hash for the root key to sign.
 */
export function computeSessionAuthHash(
  sessionPubkey: Uint8Array,
  sessionAlgoId: number,
  config: SessionKeyConfig,
): Uint8Array {
  if (sessionPubkey.length === 0 || sessionPubkey.length > MAX_SESSION_PUBKEY_BYTES) {
    throw new RangeError(`sessionPubkey must contain 1..${MAX_SESSION_PUBKEY_BYTES} bytes`);
  }
  if (!Number.isInteger(sessionAlgoId) || sessionAlgoId < 0 || sessionAlgoId > 255) {
    throw new RangeError(`sessionAlgoId must fit in one byte, got ${sessionAlgoId}`);
  }

  validateNonNegativeBigInt(config.chainId, "chainId");
  if (config.chainId >= (1n << 64n)) {
    throw new RangeError("chainId must fit in an unsigned 64-bit integer");
  }
  validateNonNegativeBigInt(config.valueCap, "valueCap");
  if (config.valueCap >= (1n << 256n)) {
    throw new RangeError("valueCap must fit in an unsigned 256-bit integer");
  }
  validateNonNegativeInteger(config.expiryBlock, "expiryBlock");

  // Target: explicit presence byte plus 32 bytes. The presence byte keeps an
  // unrestricted authorization distinct from one restricted to the zero address.
  const targetPresent = new Uint8Array([0]);
  const targetBytes = new Uint8Array(32);
  if (config.target !== null && config.target !== undefined) {
    targetPresent[0] = 1;
    const addrBytes = shellAddressToBytes(config.target);
    targetBytes.set(addrBytes.slice(0, 32));
  }

  // value_cap: 32-byte big-endian encoding.
  const valueCapBytes = new Uint8Array(32);
  let cap = config.valueCap;
  for (let i = 31; i >= 0; i--) {
    valueCapBytes[i] = Number(cap & 0xFFn);
    cap >>= 8n;
  }

  // expiry_block: 8-byte big-endian encoding.
  const expiryBytes = new Uint8Array(8);
  let expiry = BigInt(config.expiryBlock);
  for (let i = 7; i >= 0; i--) {
    expiryBytes[i] = Number(expiry & 0xFFn);
    expiry >>= 8n;
  }

  // chain_id: 8-byte big-endian encoding.
  const chainIdBytes = new Uint8Array(8);
  let chainId = config.chainId;
  for (let i = 7; i >= 0; i--) {
    chainIdBytes[i] = Number(chainId & 0xFFn);
    chainId >>= 8n;
  }

  return blake3(concatBytes(
    PQTX_SESSION_DOMAIN,
    sessionPubkey,
    new Uint8Array([sessionAlgoId]),
    targetPresent,
    targetBytes,
    valueCapBytes,
    expiryBytes,
    chainIdBytes,
  ));
}

// ── Session auth creation ────────────────────────────────────────────────────

/**
 * Create a `SessionAuth` by having the root key sign the session key authorization.
 *
 * The root key's signature authorizes the session key for use in AA bundles.
 * After calling this function, you still need to set `session_signature` once
 * you know the transaction signing hash (call `hashBatchTransaction` first,
 * then sign with the session adapter).
 *
 * @param rootAdapter - Root account's signing adapter (must match the account's pubkey).
 * @param sessionPubkey - Session public key bytes (from {@link deriveSessionKey}).
 * @param sessionAlgoId - Session key algorithm ID: `1` = ML-DSA-65, `2` = SLH-DSA.
 * @param config - Session key constraints (chain ID, expiry, value cap, target).
 * @returns Partially-filled `SessionAuth`; `session_signature` is empty, must be set after signing.
 *
 * @example
 * ```typescript
 * const sessionAuth = await createSessionAuth(rootAdapter, session.publicKey, 1, {
 *   chainId: 12345n,
 *   expiryBlock: 500,
 *   valueCap: BigInt("1000000000000000000"),
 *   target: null,
 * });
 * // Later, after building the tx:
 * bundle.session_auth = sessionAuth;
 * const signingHash = hashBatchTransaction(tx, bundle, "MlDsa65");
 * bundle.session_auth = await finalizeSessionAuth(sessionAuth, sessionAdapter, signingHash);
 * ```
 */
export async function createSessionAuth(
  rootAdapter: SignerAdapter,
  sessionPubkey: Uint8Array,
  sessionAlgoId: number,
  config: SessionKeyConfig,
): Promise<SessionAuth> {
  const authHash = computeSessionAuthHash(sessionPubkey, sessionAlgoId, config);
  const auth: SessionAuth = {
    session_pubkey: Array.from(sessionPubkey),
    session_algo: sessionAlgoId,
    target: config.target ?? null,
    value_cap: `0x${config.valueCap.toString(16)}`,
    expiry_block: config.expiryBlock,
    root_signature: [],
    session_signature: [], // caller must set this after signing the tx
  };
  const rootSig = await rootAdapter.sign(authHash);
  if (rootSig.length === 0 || rootSig.length > MAX_SESSION_SIGNATURE_BYTES) {
    throw new RangeError(`root signature must contain 1..${MAX_SESSION_SIGNATURE_BYTES} bytes`);
  }
  auth.root_signature = Array.from(rootSig);
  return auth;
}

/**
 * Finalize a `SessionAuth` by filling in the session signature.
 *
 * Call this after computing the transaction signing hash. The session adapter
 * signs the hash, and the signature is embedded in the returned `SessionAuth`.
 *
 * @param sessionAuth - Partially-filled session auth (from {@link createSessionAuth}).
 * @param sessionAdapter - Session key's signing adapter.
 * @param txSigningHash - The 32-byte batch transaction signing hash (from `hashBatchTransaction`).
 * @returns Updated `SessionAuth` with `session_signature` set.
 *
 * @example
 * ```typescript
 * bundle.session_auth = sessionAuth;
 * const signingHash = hashBatchTransaction(tx, bundle, "MlDsa65");
 * const finalAuth = await finalizeSessionAuth(sessionAuth, sessionAdapter, signingHash);
 * bundle.session_auth = finalAuth;
 * ```
 */
export async function finalizeSessionAuth(
  sessionAuth: SessionAuth,
  sessionAdapter: SignerAdapter,
  txSigningHash: Uint8Array,
): Promise<SessionAuth> {
  const auth: SessionAuth = {
    ...sessionAuth,
    session_pubkey: [...sessionAuth.session_pubkey],
    root_signature: [...sessionAuth.root_signature],
    session_signature: [],
  };
  const sessionSig = await sessionAdapter.sign(Uint8Array.from(txSigningHash));
  if (sessionSig.length === 0 || sessionSig.length > MAX_SESSION_SIGNATURE_BYTES) {
    throw new RangeError(`session signature must contain 1..${MAX_SESSION_SIGNATURE_BYTES} bytes`);
  }
  auth.session_signature = Array.from(sessionSig);
  return auth;
}

/**
 * Verify that a `SessionAuth` structure is well-formed (basic sanity checks).
 *
 * Does not perform cryptographic verification (that is done on-chain by the node).
 * Useful for client-side validation before submitting a bundle.
 *
 * @param sessionAuth - Session auth to validate.
 * @throws {Error} If any field is missing or malformed.
 */
export function validateSessionAuthShape(sessionAuth: SessionAuth): void {
  if (!sessionAuth.session_pubkey || sessionAuth.session_pubkey.length === 0) {
    throw new Error("sessionAuth.session_pubkey is empty");
  }
  if (sessionAuth.session_pubkey.length > MAX_SESSION_PUBKEY_BYTES) {
    throw new Error(`sessionAuth.session_pubkey exceeds ${MAX_SESSION_PUBKEY_BYTES} bytes`);
  }
  if (sessionAuth.session_algo !== 0 && sessionAuth.session_algo !== 1 && sessionAuth.session_algo !== 2) {
    throw new Error(`sessionAuth.session_algo must be 0, 1, or 2, got ${sessionAuth.session_algo}`);
  }
  if (!sessionAuth.root_signature || sessionAuth.root_signature.length === 0) {
    throw new Error("sessionAuth.root_signature is empty");
  }
  if (sessionAuth.root_signature.length > MAX_SESSION_SIGNATURE_BYTES) {
    throw new Error(`sessionAuth.root_signature exceeds ${MAX_SESSION_SIGNATURE_BYTES} bytes`);
  }
  if (!sessionAuth.session_signature || sessionAuth.session_signature.length === 0) {
    throw new Error("sessionAuth.session_signature is empty; call finalizeSessionAuth() after building the tx");
  }
  if (sessionAuth.session_signature.length > MAX_SESSION_SIGNATURE_BYTES) {
    throw new Error(`sessionAuth.session_signature exceeds ${MAX_SESSION_SIGNATURE_BYTES} bytes`);
  }
  if (sessionAuth.expiry_block <= 0) {
    throw new Error(`sessionAuth.expiry_block must be > 0, got ${sessionAuth.expiry_block}`);
  }
}
