import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MlDsa65Adapter,
  ShellSigner,
  buildTransferTransaction,
  createShellProvider,
  generateMlDsa65KeyPair,
  hashTransaction,
} from '../dist/index.js';
import { createJsonRpcFetchMock } from './helpers.mjs';

test('browser integration: dist exports work with fetch-based provider', async () => {
  const { fetchMock, calls } = createJsonRpcFetchMock();
  globalThis.fetch = fetchMock;

  const { publicKey, secretKey } = generateMlDsa65KeyPair();
  const signer = new ShellSigner('MlDsa65', MlDsa65Adapter.fromKeyPair(publicKey, secretKey));
  const provider = createShellProvider({
    rpcHttpUrl: 'https://rpc.devnet.shell.local',
  });

  const tx = buildTransferTransaction({
    chainId: 424242,
    nonce: 7,
    to: signer.getAddress(),
    value: 42n,
  });
  const signed = await signer.buildSignedTransaction({
    tx,
    txHash: hashTransaction(tx),
    includePublicKey: true,
  });
  const txHash = await provider.sendTransaction(signed);
  const pqPubkey = await provider.getPqPubkey(signer.getAddress());

  assert.equal(txHash, '0x' + 'ab'.repeat(32));
  assert.equal(pqPubkey, '0x' + '11'.repeat(32));
  assert.equal(typeof signer.getAddress(), 'string');
  assert.ok(signer.getAddress().startsWith('pq1'), 'signer address must be pq1 format');
  assert.deepEqual(
    calls.map((call) => call.method),
    ['shell_sendTransaction', 'shell_getPqPubkey'],
  );
});
