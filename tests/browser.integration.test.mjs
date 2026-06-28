import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MlDsa65Adapter,
  ShellSigner,
  buildTransferTransaction,
  createShellProvider,
  generateMlDsa65KeyPair,
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
    includePublicKey: true,
  });
  const txHash = await provider.sendTransaction(signed);
  const pqPubkey = await provider.getPqPubkey(signer.getAddress());
  const capabilities = await provider.rpcCapabilities();
  const snapshot = await provider.getChainSnapshot();
  const blocks = await provider.getBlocksRange(42, { limit: 2, txDetail: 'none' });
  const addressSummary = await provider.getAddressSummary('0x' + '44'.repeat(32), {
    recentLimit: 1,
    includeTotal: true,
  });
  const addressHistory = await provider.getTransactionsByAddressV2('0x' + '44'.repeat(32), {
    limit: 10,
    detail: 'summary',
  });
  const txSummary = await provider.getTransactionSummary('0x' + '55'.repeat(32), {
    includeReceipt: false,
  });
  const validators = await provider.getValidatorSnapshot({ proposerWindow: 20 });
  const paymasterGas = await provider.estimatePaymasterGas({
    paymaster: '0x' + '22'.repeat(32),
    sender: signer.getAddress(),
    inner_calls_data: '0x',
    max_fee_per_gas: '0x3b9aca00',
    paymaster_context: '0x01',
  });

  assert.equal(txHash, '0x' + 'ab'.repeat(32));
  assert.equal(pqPubkey, '0x' + '11'.repeat(32));
  assert.equal(capabilities.rpcVersion, 'shell-rpc-v2');
  assert.equal(snapshot.chainId, '0x67932');
  assert.equal(blocks.blocks[0].number, '0x2a');
  assert.equal(addressSummary.pqPubkeyRegistered, true);
  assert.equal(addressHistory.hasMore, false);
  assert.equal(txSummary.gasUsed, '0x5208');
  assert.equal(validators.proposerWindow, 20);
  assert.equal(paymasterGas.simulation_status, 'cap_only');
  assert.equal(paymasterGas.paymaster_gas_cap, '0xc350');
  assert.equal(paymasterGas.within_cap, null);
  assert.equal(typeof signer.getAddress(), 'string');
  assert.ok(signer.getAddress().startsWith('0x'), 'signer address must be 0x hex format');
  assert.deepEqual(
    calls.map((call) => call.method),
    [
      'shell_sendTransaction',
      'shell_getPqPubkey',
      'shell_rpcCapabilities',
      'shell_getChainSnapshot',
      'shell_getBlocksRange',
      'shell_getAddressSummary',
      'shell_getTransactionsByAddressV2',
      'shell_getTransactionSummary',
      'shell_getValidatorSnapshot',
      'shell_estimatePaymasterGas',
    ],
  );
  assert.deepEqual(calls[4].params, ['0x2a', { direction: 'desc', limit: 2, txDetail: 'none', txLimit: null }]);
  assert.deepEqual(calls[5].params, [
    '0x' + '44'.repeat(32),
    { recentLimit: 1, includeTotal: true },
  ]);
  assert.deepEqual(calls[8].params, [{ proposerWindow: 20 }]);
});
