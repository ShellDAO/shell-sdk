import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_ACCOUNT_PUBLIC_KEY_BYTES,
  encodeCancelRecoveryCalldata,
  encodeExecuteRecoveryCalldata,
  encodeRotateKeyCalldata,
  encodeSetGuardiansCalldata,
  encodeSubmitRecoveryCalldata,
} from "../dist/index.js";

const account = `0x${"11".repeat(32)}`;

test("account public-key encoders accept the protocol maximum", () => {
  const publicKey = new Uint8Array(MAX_ACCOUNT_PUBLIC_KEY_BYTES);
  assert.match(encodeRotateKeyCalldata(publicKey, 1), /^0x/);
  assert.match(encodeSubmitRecoveryCalldata(account, publicKey, 1), /^0x/);
});

test("account public-key encoders reject oversized payloads", () => {
  const publicKey = new Uint8Array(MAX_ACCOUNT_PUBLIC_KEY_BYTES + 1);
  assert.throws(() => encodeRotateKeyCalldata(publicKey, 1), /public key is too large/);
  assert.throws(
    () => encodeSubmitRecoveryCalldata(account, publicKey, 1),
    /public key is too large/,
  );
});

test("account public-key encoders reject empty payloads", () => {
  const publicKey = new Uint8Array();
  assert.throws(() => encodeRotateKeyCalldata(publicKey, 1), /must not be empty/);
  assert.throws(() => encodeSubmitRecoveryCalldata(account, publicKey, 1), /must not be empty/);
});

test("guardian recovery encoders accept native 32-byte Shell addresses", () => {
  const nativeWord = "11".repeat(32);
  assert.ok(encodeSetGuardiansCalldata([account], 1, 100).endsWith(nativeWord));
  assert.equal(
    encodeSubmitRecoveryCalldata(account, new Uint8Array([1]), 1).slice(10, 74),
    nativeWord,
  );
  assert.equal(encodeExecuteRecoveryCalldata(account).slice(10, 74), nativeWord);
  assert.equal(encodeCancelRecoveryCalldata(account).slice(10, 74), nativeWord);
});
