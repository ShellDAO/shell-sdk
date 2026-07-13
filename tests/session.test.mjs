/**
 * Tests for AA Phase 2 session key API (session.ts + deriveSessionKey).
 *
 * 7 integration test vectors covering:
 * 1. Session key derivation path is correct
 * 2. SessionAuth hash computation matches Rust spec
 * 3. createSessionAuth produces valid structure
 * 4. Session key expires (expiry validation)
 * 5. Value cap enforced (valueCap validation)
 * 6. Target restriction shape
 * 7. Multi-key isolation (different indices produce different keys)
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  mnemonicToSeed,
  deriveSessionKey,
  deriveAccount,
  HD_SESSION_ACCOUNT,
  HD_SESSION_SUBTREE,
} from "../dist/hdwallet.js";

import {
  PQTX_SESSION_DOMAIN,
  MAX_SESSION_PUBKEY_BYTES,
  MAX_SESSION_SIGNATURE_BYTES,
  computeSessionAuthHash,
  createSessionAuth,
  finalizeSessionAuth,
  validateSessionAuthShape,
} from "../dist/session.js";

import { MlDsa65Adapter } from "../dist/adapters.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TEST_CHAIN_ID = 12345n;

function getSeed() {
  return mnemonicToSeed(TEST_MNEMONIC, "");
}

// ── Vector 1: Derive session key path ────────────────────────────────────────

test("session-1: deriveSessionKey path is m/1'/1'/k'", () => {
  const seed = getSeed();
  const s0 = deriveSessionKey(seed, "ml-dsa-65", 0);
  assert.equal(s0.path, "m/1'/1'/0'", "session key 0 path");
  assert.equal(s0.algoId, 1, "ML-DSA-65 algoId");
  assert.equal(s0.publicKey.length, 1952, "ML-DSA-65 pk length");

  const s1 = deriveSessionKey(seed, "ml-dsa-65", 1);
  assert.equal(s1.path, "m/1'/1'/1'", "session key 1 path");

  const s100 = deriveSessionKey(seed, "ml-dsa-65", 100);
  assert.equal(s100.path, "m/1'/1'/100'", "session key 100 path");
});

// ── Vector 2: SessionAuth hash computation ───────────────────────────────────

test("session-2: computeSessionAuthHash produces 32-byte BLAKE3 output", () => {
  const seed = getSeed();
  const session = deriveSessionKey(seed, "ml-dsa-65", 0);
  const config = {
    chainId: TEST_CHAIN_ID,
    expiryBlock: 1000,
    valueCap: 1_000_000_000_000_000_000n, // 1 ETH
    target: null,
  };

  const hash = computeSessionAuthHash(session.publicKey, session.algoId, config);
  assert.equal(hash.length, 32, "auth_hash must be 32 bytes");

  // Hash must be deterministic
  const hash2 = computeSessionAuthHash(session.publicKey, session.algoId, config);
  assert.deepEqual(hash, hash2, "auth_hash must be deterministic");

  // Different session algorithm must produce different hash
  const hashDifferentAlgo = computeSessionAuthHash(session.publicKey, 0, config);
  assert.notDeepEqual(hash, hashDifferentAlgo, "different sessionAlgoId must produce different hash");

  // Different chain ID must produce different hash
  const hashDifferentChain = computeSessionAuthHash(session.publicKey, session.algoId, { ...config, chainId: 99999n });
  assert.notDeepEqual(hash, hashDifferentChain, "different chainId must produce different hash");

  // Different expiry must produce different hash
  const hashDifferentExpiry = computeSessionAuthHash(session.publicKey, session.algoId, { ...config, expiryBlock: 2000 });
  assert.notDeepEqual(hash, hashDifferentExpiry, "different expiryBlock must produce different hash");

  const zeroTarget = `0x${"00".repeat(32)}`;
  const hashZeroTarget = computeSessionAuthHash(session.publicKey, session.algoId, {
    ...config,
    target: zeroTarget,
  });
  assert.notDeepEqual(hash, hashZeroTarget, "unrestricted and zero-address targets must differ");
});

test("session-2b: PQTX_SESSION_DOMAIN is 16 bytes matching spec", () => {
  assert.equal(PQTX_SESSION_DOMAIN.length, 16, "domain must be 16 bytes");
  // b"PQTX_SESSION_V2\0"
  const expected = Buffer.from("PQTX_SESSION_V2\0");
  assert.deepEqual(Buffer.from(PQTX_SESSION_DOMAIN), expected, "domain bytes mismatch");
});

test("session-2c: target-presence hashes match Shell Chain vectors", () => {
  const sessionPubkey = new Uint8Array(32).fill(0x11);
  const base = {
    chainId: 1337n,
    expiryBlock: 500,
    valueCap: 100n,
    target: null,
  };
  const unrestricted = computeSessionAuthHash(sessionPubkey, 1, base);
  const zeroTarget = computeSessionAuthHash(sessionPubkey, 1, {
    ...base,
    target: `0x${"00".repeat(32)}`,
  });

  assert.equal(
    Buffer.from(unrestricted).toString("hex"),
    "3fceca0ef7542e4933a956618d2f94b663fb72be319e015a09f960409ed8e4f7",
  );
  assert.equal(
    Buffer.from(zeroTarget).toString("hex"),
    "43faa3987b61c88a5b0f758024f09fa549b10ec62979a7ba5c4ce6ff5ee65088",
  );
});

// ── Vector 3: createSessionAuth produces valid structure ─────────────────────

test("session-3: createSessionAuth returns well-formed SessionAuth", async () => {
  const seed = getSeed();
  const rootAccount = deriveAccount(seed, "ml-dsa-65", 0, 0, 0);
  const rootAdapter = MlDsa65Adapter.fromKeyPair(rootAccount.publicKey, rootAccount.secretKey);
  const session = deriveSessionKey(seed, "ml-dsa-65", 0);

  const config = {
    chainId: TEST_CHAIN_ID,
    expiryBlock: 1000,
    valueCap: 500_000_000_000_000_000n, // 0.5 ETH
    target: null,
  };

  const sessionAuth = await createSessionAuth(rootAdapter, session.publicKey, 1, config);

  // Verify structure
  assert.equal(sessionAuth.session_pubkey.length, 1952, "session pubkey length");
  assert.equal(sessionAuth.session_algo, 1, "session algo must be ML-DSA-65");
  assert.equal(sessionAuth.expiry_block, 1000, "expiry block");
  assert.equal(sessionAuth.value_cap, "0x6f05b59d3b20000", "value_cap hex (0.5 ETH)");
  assert.equal(sessionAuth.target, null, "target null");
  assert.ok(sessionAuth.root_signature.length > 0, "root_signature must not be empty");
  assert.equal(sessionAuth.session_signature.length, 0, "session_signature is empty until finalized");
});

// ── Vector 4: Session key expiry ──────────────────────────────────────────────

test("session-4: session key expiry block is configurable", async () => {
  const seed = getSeed();
  const rootAccount = deriveAccount(seed, "ml-dsa-65", 0, 0, 0);
  const rootAdapter = MlDsa65Adapter.fromKeyPair(rootAccount.publicKey, rootAccount.secretKey);
  const session = deriveSessionKey(seed, "ml-dsa-65", 0);

  // Create auth with expiry block 100
  const auth100 = await createSessionAuth(rootAdapter, session.publicKey, 1, {
    chainId: TEST_CHAIN_ID,
    expiryBlock: 100,
    valueCap: 1_000_000_000_000_000_000n,
    target: null,
  });
  assert.equal(auth100.expiry_block, 100, "expiry block 100");

  // Create auth with expiry block 9999
  const auth9999 = await createSessionAuth(rootAdapter, session.publicKey, 1, {
    chainId: TEST_CHAIN_ID,
    expiryBlock: 9999,
    valueCap: 1_000_000_000_000_000_000n,
    target: null,
  });
  assert.equal(auth9999.expiry_block, 9999, "expiry block 9999");

  // Different expiry → different root signatures (auth_hash differs)
  assert.notDeepEqual(
    auth100.root_signature,
    auth9999.root_signature,
    "different expiry blocks must produce different root signatures",
  );
});

// ── Vector 5: Value cap ───────────────────────────────────────────────────────

test("session-5: value_cap is encoded correctly in hex", async () => {
  const seed = getSeed();
  const rootAccount = deriveAccount(seed, "ml-dsa-65", 0, 0, 0);
  const rootAdapter = MlDsa65Adapter.fromKeyPair(rootAccount.publicKey, rootAccount.secretKey);
  const session = deriveSessionKey(seed, "ml-dsa-65", 0);

  const tests = [
    { valueCap: 0n, expectedHex: "0x0" },
    { valueCap: 1n, expectedHex: "0x1" },
    { valueCap: 1_000_000_000_000_000_000n, expectedHex: "0xde0b6b3a7640000" }, // 1 ETH
    { valueCap: 2_000_000_000_000_000_000n, expectedHex: "0x1bc16d674ec80000" }, // 2 ETH
  ];

  for (const { valueCap, expectedHex } of tests) {
    const auth = await createSessionAuth(rootAdapter, session.publicKey, 1, {
      chainId: TEST_CHAIN_ID,
      expiryBlock: 1000,
      valueCap,
      target: null,
    });
    assert.equal(auth.value_cap, expectedHex, `value_cap for ${valueCap}`);
  }
});

// ── Vector 6: Target restriction ─────────────────────────────────────────────

test("session-6: target restriction is set correctly in SessionAuth", async () => {
  const seed = getSeed();
  const rootAccount = deriveAccount(seed, "ml-dsa-65", 0, 0, 0);
  const rootAdapter = MlDsa65Adapter.fromKeyPair(rootAccount.publicKey, rootAccount.secretKey);
  const session = deriveSessionKey(seed, "ml-dsa-65", 0);

  const TARGET = "0x" + "aa".repeat(32);

  // Auth with target restriction
  const authWithTarget = await createSessionAuth(rootAdapter, session.publicKey, 1, {
    chainId: TEST_CHAIN_ID,
    expiryBlock: 1000,
    valueCap: 1_000_000_000_000_000_000n,
    target: TARGET,
  });
  assert.equal(authWithTarget.target, TARGET, "target must be set");

  // Auth without target restriction
  const authNoTarget = await createSessionAuth(rootAdapter, session.publicKey, 1, {
    chainId: TEST_CHAIN_ID,
    expiryBlock: 1000,
    valueCap: 1_000_000_000_000_000_000n,
    target: null,
  });
  assert.equal(authNoTarget.target, null, "target must be null");

  // Different target → different root signatures
  assert.notDeepEqual(
    authWithTarget.root_signature,
    authNoTarget.root_signature,
    "target vs no-target must produce different root signatures",
  );
});

// ── Vector 7: Multi-key isolation ────────────────────────────────────────────

test("session-7: different session indices produce isolated keys", () => {
  const seed = getSeed();

  // Derive 5 session keys
  const keys = [0, 1, 2, 10, 100].map(i => deriveSessionKey(seed, "ml-dsa-65", i));

  // All public keys must be unique
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      assert.notDeepEqual(
        Buffer.from(keys[i].publicKey),
        Buffer.from(keys[j].publicKey),
        `session key ${i} and ${j} must differ`,
      );
      assert.notEqual(keys[i].address, keys[j].address, `session key ${i} and ${j} addresses must differ`);
    }
  }

  // Session keys must differ from account key (namespace isolation)
  const accountKey = deriveAccount(seed, "ml-dsa-65", 0, 0, 0);
  for (const session of keys) {
    assert.notDeepEqual(
      Buffer.from(session.publicKey),
      Buffer.from(accountKey.publicKey),
      "session key must not collide with account key",
    );
    assert.notEqual(session.address, accountKey.address, "session address must not match account address");
  }
});

// ── validateSessionAuthShape ──────────────────────────────────────────────────

test("session-shape: validateSessionAuthShape rejects incomplete SessionAuth", async () => {
  const seed = getSeed();
  const rootAccount = deriveAccount(seed, "ml-dsa-65", 0, 0, 0);
  const rootAdapter = MlDsa65Adapter.fromKeyPair(rootAccount.publicKey, rootAccount.secretKey);
  const session = deriveSessionKey(seed, "ml-dsa-65", 0);

  const auth = await createSessionAuth(rootAdapter, session.publicKey, 1, {
    chainId: TEST_CHAIN_ID,
    expiryBlock: 1000,
    valueCap: 1_000_000_000_000_000_000n,
    target: null,
  });

  // Missing session_signature → must throw
  assert.throws(
    () => validateSessionAuthShape(auth),
    /session_signature is empty/,
    "should reject empty session_signature",
  );

  // After finalizing, should pass
  const sessionAdapter = MlDsa65Adapter.fromKeyPair(session.publicKey, session.secretKey);
  const fakeHash = new Uint8Array(32).fill(0xAB);
  const finalAuth = await finalizeSessionAuth(auth, sessionAdapter, fakeHash);
  assert.doesNotThrow(() => validateSessionAuthShape(finalAuth), "finalized auth should be valid");
});

test("session-shape: rejects fields above node size limits", () => {
  const valid = {
    session_pubkey: [1],
    session_algo: 1,
    target: null,
    value_cap: "0x0",
    expiry_block: 1,
    root_signature: [1],
    session_signature: [1],
  };

  assert.throws(
    () => validateSessionAuthShape({
      ...valid,
      session_pubkey: new Array(MAX_SESSION_PUBKEY_BYTES + 1).fill(0),
    }),
    /session_pubkey exceeds/,
  );
  assert.throws(
    () => validateSessionAuthShape({
      ...valid,
      root_signature: new Array(MAX_SESSION_SIGNATURE_BYTES + 1).fill(0),
    }),
    /root_signature exceeds/,
  );
  assert.throws(
    () => validateSessionAuthShape({
      ...valid,
      session_signature: new Array(MAX_SESSION_SIGNATURE_BYTES + 1).fill(0),
    }),
    /session_signature exceeds/,
  );
});

// ── Constants ─────────────────────────────────────────────────────────────────

test("session-constants: HD_SESSION_ACCOUNT and HD_SESSION_SUBTREE are 1", () => {
  assert.equal(HD_SESSION_ACCOUNT, 1);
  assert.equal(HD_SESSION_SUBTREE, 1);
});
