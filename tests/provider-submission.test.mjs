import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MlDsa65Adapter, ShellSigner, buildTransferTransaction, buildBatchTransaction,
  createShellProvider, generateMlDsa65KeyPair, hashTransaction,
} from '../dist/index.js';
import { acknowledgementHash, idFromSigningHash } from './helpers.mjs';

async function signedTransaction(batch = false) {
  const { publicKey, secretKey } = generateMlDsa65KeyPair();
  const signer = new ShellSigner('MlDsa65', MlDsa65Adapter.fromKeyPair(publicKey, secretKey));
  try {
    const built = batch
      ? buildBatchTransaction({ chainId: 1337, nonce: 0,
          innerCalls: [{ to: null, value: '0x0', data: '0x1234', gas_limit: '0x5208' }] })
      : { tx: buildTransferTransaction({ chainId: 1337, nonce: 0, to: signer.getAddress(), value: 1n }) };
    return await signer.buildSignedTransaction({ tx: built.tx, aaBundle: built.aa_bundle, includePublicKey: true });
  } finally { signer.dispose(); }
}

async function submit(signed, response) {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (_url, init) => {
    requests++;
    const body = JSON.parse(init.body);
    assert.equal(body.method, 'shell_sendTransaction');
    assert.deepEqual(body.params, [signed]);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...response }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    return await createShellProvider({ rpcHttpUrl: 'http://127.0.0.1:8545' }).sendTransaction(signed);
  } finally {
    globalThis.fetch = original;
    assert.equal(requests, 1, 'never automatically retransmit an ambiguous submission');
  }
}

test('submission rejects mismatched and malformed acknowledgements', async () => {
  const signed = await signedTransaction();
  const expected = acknowledgementHash(signed);
  for (const result of ['0x' + 'ab'.repeat(32), 'not-a-hash', '', '0x01', null, 42, {}]) {
    await assert.rejects(submit(signed, { result }), error =>
      error.message.includes(expected) && error.message.includes('may already have been submitted'));
  }
});

test('submission accepts canonical transfer and AA IDs in either hex letter case', async () => {
  for (const batch of [false, true]) {
    const signed = await signedTransaction(batch);
    const expected = acknowledgementHash(signed);
    for (const result of [expected, '0x' + expected.slice(2).toUpperCase()]) {
      assert.equal(await submit(signed, { result }), result);
    }
    const signingHash = '0x' + Buffer.from(hashTransaction(signed.tx, signed.signature.sig_type)).toString('hex');
    await assert.rejects(submit(signed, { result: signingHash }), /unexpected transaction hash/);
    await assert.rejects(submit({ ...signed, from: '0x' + '22'.repeat(32) }, { result: expected }), /unexpected transaction hash/);
    if (batch) {
      const changed = structuredClone(signed);
      changed.aa_bundle.inner_calls[0].data = '0xabcd';
      await assert.rejects(submit(changed, { result: expected }), /unexpected transaction hash/);
    }
    const referenced = { ...signed, sender_pubkey: null };
    assert.equal(await submit(referenced, { result: expected }), expected);
  }
});

test('submission preserves node rejection errors', async () => {
  await assert.rejects(submit(await signedTransaction(), {
    error: { code: -32000, message: 'rejected' },
  }), /rejected/);
});

test('AA acknowledgement agrees with the known chain signing vector', async () => {
  const { tx, aa_bundle } = buildBatchTransaction({ chainId: 1, nonce: 0,
    innerCalls: [{ to: null, value: '0x0', data: '0x1234', gas_limit: '0x5208' }] });
  const from = '0x' + '11'.repeat(32);
  const signed = { from, tx, aa_bundle, signature: { sig_type: 'Dilithium3', data: [] } };
  const expected = idFromSigningHash(from, Buffer.from('a464ebdf74146ce5528c5f69f931ec009033c0542d33db784462d91cf573e1d7', 'hex'));
  assert.equal(await submit(signed, { result: expected }), expected);
});
