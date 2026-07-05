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

test('getTransactionsByAddressV2 does not fall back for non-method-not-found errors', async () => {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return rpc({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'invalid params' } });
  };

  const provider = createShellProvider({ rpcHttpUrl: 'https://rpc.devnet.shell.local' });

  await assert.rejects(
    provider.getTransactionsByAddressV2('0x' + '44'.repeat(32), { limit: 25 }),
    /invalid params/,
  );
  assert.deepEqual(calls.map((call) => call.method), ['shell_getTransactionsByAddressV2']);
});

test('getTransactionsByAddressV2 legacy fallback rejects ascending order', async () => {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return rpc({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
  };

  const provider = createShellProvider({ rpcHttpUrl: 'https://rpc.devnet.shell.local' });

  await assert.rejects(
    provider.getTransactionsByAddressV2('0x' + '44'.repeat(32), {
      limit: 25,
      direction: 'asc',
    }),
    /ascending cursor pagination/,
  );
  assert.deepEqual(calls.map((call) => call.method), ['shell_getTransactionsByAddressV2']);
});

test('getValidatorSnapshot rejects proposer windows outside node bounds before RPC', async () => {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return rpc({ jsonrpc: '2.0', id: 1, result: {} });
  };

  const provider = createShellProvider({ rpcHttpUrl: 'https://rpc.devnet.shell.local' });

  for (const proposerWindow of [0, -1, 1001, 1.5, Number.NaN]) {
    await assert.rejects(
      provider.getValidatorSnapshot({ proposerWindow }),
      /proposerWindow must be a safe integer in \[1, 1000\]/,
    );
  }
  assert.deepEqual(calls, []);
});

test('getStorageProfile reads the canonical shell_getStorageProfile descriptor', async () => {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return rpc({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        profile: 'pruned',
        bodyRetention: 4096,
        witnessRetention: 64,
        keepRecent: 4096,
        proofReplacementGrace: 128,
        statePruningExperimental: false,
      },
    });
  };

  const provider = createShellProvider({ rpcHttpUrl: 'https://rpc.devnet.shell.local' });

  assert.equal(await provider.getStorageProfile(), 'pruned');
  assert.deepEqual(calls.map((call) => call.method), ['shell_getStorageProfile']);
});

test('getStorageProfile returns undefined when the node has no profile descriptor', async () => {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return rpc({
      jsonrpc: '2.0',
      id: body.id,
      error: { code: -32003, message: 'storage profile not configured on this node' },
    });
  };

  const provider = createShellProvider({ rpcHttpUrl: 'https://rpc.devnet.shell.local' });

  assert.equal(await provider.getStorageProfile(), undefined);
  assert.deepEqual(calls.map((call) => call.method), ['shell_getStorageProfile']);
});

function rpc(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
