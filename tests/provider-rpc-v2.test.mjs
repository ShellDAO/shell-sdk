import assert from 'node:assert/strict';
import test from 'node:test';

import { createShellProvider } from '../dist/index.js';

test('getTransactionsByAddressV2 falls back to legacy only for the first page', async () => {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.method === 'shell_getTransactionsByAddressV2') {
      return rpc({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
    }
    if (body.method === 'shell_getTransactionsByAddress') {
      return rpc({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          address: '0x' + '44'.repeat(32),
          fromBlock: '0x0',
          toBlock: '0x2a',
          page: 0,
          limit: 25,
          total: 1,
          transactions: [{ hash: '0x' + '55'.repeat(32), blockNumber: '0x2a' }],
        },
      });
    }
    throw new Error(`unexpected method ${body.method}`);
  };

  const provider = createShellProvider({ rpcHttpUrl: 'https://rpc.devnet.shell.local' });
  const result = await provider.getTransactionsByAddressV2('0x' + '44'.repeat(32), {
    limit: 25,
    includeTotal: true,
  });

  assert.equal(result.total, 1);
  assert.equal(result.items.length, 1);
  assert.deepEqual(calls.map((call) => call.method), [
    'shell_getTransactionsByAddressV2',
    'shell_getTransactionsByAddress',
  ]);
  assert.deepEqual(calls[0].params[1], {
    fromBlock: null,
    toBlock: null,
    cursor: null,
    limit: 25,
    direction: 'desc',
    detail: 'summary',
    includeTotal: true,
  });
});

test('getTransactionsByAddressV2 with a cursor does not fall back to page offset', async () => {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return rpc({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
  };

  const provider = createShellProvider({ rpcHttpUrl: 'https://rpc.devnet.shell.local' });

  await assert.rejects(
    provider.getTransactionsByAddressV2('0x' + '44'.repeat(32), {
      cursor: '0x000000000000000000000001',
      limit: 25,
    }),
    /Method not found/,
  );
  assert.deepEqual(calls.map((call) => call.method), ['shell_getTransactionsByAddressV2']);
});

function rpc(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
