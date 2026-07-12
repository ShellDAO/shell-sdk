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
  assert.match(encodeSetGuardiansCalldata([account], 1, 100), /^0x/);
  assert.match(encodeExecuteRecoveryCalldata(account), /^0x/);
  assert.match(encodeCancelRecoveryCalldata(account), /^0x/);
});
