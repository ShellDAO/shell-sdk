import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import * as sdk from "shell-sdk";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function checkExample(code) {
  const program = new AsyncFunction("sdk", "mnemonic", `
    const { mnemonicToSeed, deriveSessionKey, createSessionAuth,
      MlDsa65Adapter, hashBatchTransaction } = sdk;
    const chainId = 12345, currentBlock = 1, expiryBlock = 1001, nonce = 0, passphrase = "";
    const target = "0x" + "00".repeat(12) + "c5".repeat(20);
    const calldata = "0x" + "00".repeat(31) + "6f";
    const outerSeed = sdk.mnemonicToSeed(mnemonic);
    const outerRoot = sdk.deriveAccount(outerSeed, "ml-dsa-65");
    const rootAdapter = sdk.MlDsa65Adapter.fromKeyPair(outerRoot.publicKey, outerRoot.secretKey);
    const { tx, aa_bundle: aaBundle } = sdk.buildBatchTransaction({
      chainId, nonce, innerCalls: [sdk.buildInnerCall(target, calldata, 100000, 2n)],
      gasLimit: 500000, maxFeePerGas: 1000000000000, maxPriorityFeePerGas: 0,
    });
    try {
      {
        ${code.replace(/import\s+\{([\s\S]*?)\}\s+from\s+["']shell-sdk["'];?/g, "const {$1} = sdk;")}
        const result = typeof signed === "undefined"
          ? sdk.buildSignedTransaction({
              from: outerRoot.address, tx, aaBundle,
              signature: aaBundle.session_auth.session_signature,
              signatureType: "MlDsa65", senderPubkey: outerRoot.publicKey,
            })
          : signed;
        if (typeof sessionAdapter !== "undefined") sessionAdapter.dispose();
        if (typeof sessionAccount !== "undefined") sessionAccount.secretKey.fill(0);
        if (typeof seed !== "undefined") seed.fill(0);
        return result;
      }
    } finally {
      rootAdapter.dispose(); outerRoot.secretKey.fill(0); outerSeed.fill(0);
    }
  `);
  const packet = await program(sdk, sdk.generateMnemonic(128));
  const auth = packet.aa_bundle.session_auth;
  const config = {
    chainId: BigInt(packet.tx.chain_id), expiryBlock: auth.expiry_block,
    valueCap: BigInt(auth.value_cap), target: auth.target,
  };
  assert.ok(ml_dsa65.verify(
    Uint8Array.from(auth.root_signature),
    sdk.computeSessionAuthHash(Uint8Array.from(auth.session_pubkey), auth.session_algo, config),
    Uint8Array.from(packet.sender_pubkey),
  ), "documented root signature must authorize the actual session constraints");
  assert.deepEqual(packet.signature.data, auth.session_signature);
  assert.ok(ml_dsa65.verify(
    Uint8Array.from(auth.session_signature),
    sdk.hashBatchTransaction(packet.tx, packet.aa_bundle, packet.signature.sig_type),
    Uint8Array.from(auth.session_pubkey),
  ), "documented session signature must authorize the final bundle and declared algorithm");
}

test("session module usage signs its final authorization-bearing bundle", async () => {
  const source = await readFile(new URL("../src/session.ts", import.meta.url), "utf8");
  const block = source.match(/```typescript\n([\s\S]*?)\n \* ```/)[1];
  await checkExample(block.replace(/^ \* ?/gm, ""));
});


test("README session recipe signs the actual finalized wire envelope", async () => {
  const source = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const section = source.split("## Session-key transactions")[1].split("## Key rotation")[0];
  const code = section.match(/```typescript\n([\s\S]*?)\n```/)[1];
  await checkExample(code);
});
