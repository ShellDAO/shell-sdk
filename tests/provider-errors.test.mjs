import assert from 'node:assert/strict';
import test from 'node:test';

import { createShellProvider } from '../dist/index.js';

const RPC_URL = 'https://rpc.devnet.shell.local';

test('ShellProvider returns JSON-RPC results from raw Shell methods', async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    return rpc({ jsonrpc: '2.0', id: body.id, result: '0x' + '11'.repeat(32) });
  };

  const provider = createShellProvider({ rpcHttpUrl: RPC_URL });

  assert.equal(await provider.getPqPubkey('0x' + '44'.repeat(32)), '0x' + '11'.repeat(32));
});

test('ShellProvider authenticates raw and viem HTTP requests with the RPC API key', async () => {
  const authorizationHeaders = [];
  globalThis.fetch = async (_url, init) => {
    authorizationHeaders.push(new Headers(init.headers).get('authorization'));
    const body = JSON.parse(init.body);
    const result = body.method === 'eth_blockNumber' ? '0x1' : '0x' + '11'.repeat(32);
    return rpc({ jsonrpc: '2.0', id: body.id, result });
  };

  const provider = createShellProvider({ rpcHttpUrl: RPC_URL, rpcApiKey: 'secret' });

  await provider.getPqPubkey('0x' + '44'.repeat(32));
  assert.equal(await provider.client.getBlockNumber(), 1n);
  assert.deepEqual(authorizationHeaders, ['Bearer secret', 'Bearer secret']);
});

test('ShellProvider rejects unsafe RPC API keys', () => {
  assert.throws(
    () => createShellProvider({ rpcHttpUrl: RPC_URL, rpcApiKey: '' }),
    /rpcApiKey must not be empty/,
  );
  assert.throws(
    () => createShellProvider({ rpcHttpUrl: RPC_URL, rpcApiKey: 'secret\r\ninjected' }),
    /rpcApiKey must not contain newline characters/,
  );
});

test('ShellProvider surfaces JSON-RPC error codes and messages', async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    return rpc({
      jsonrpc: '2.0',
      id: body.id,
      error: { code: -32601, message: 'Method not found' },
    });
  };

  const provider = createShellProvider({ rpcHttpUrl: RPC_URL });

  await assert.rejects(
    provider.getPqPubkey('0x' + '44'.repeat(32)),
    (error) => error.name === 'RpcRequestError' && error.message === '[-32601] Method not found',
  );
});

test('ShellProvider rejects empty RPC responses', async () => {
  globalThis.fetch = async () => new Response('', { status: 200 });
  const provider = createShellProvider({ rpcHttpUrl: RPC_URL });

  await assert.rejects(
    provider.getPqPubkey('0x' + '44'.repeat(32)),
    /rpc response body is empty/,
  );
});

test('ShellProvider rejects non-JSON RPC responses', async () => {
  globalThis.fetch = async () => new Response('not json', { status: 200 });
  const provider = createShellProvider({ rpcHttpUrl: RPC_URL });

  await assert.rejects(
    provider.getPqPubkey('0x' + '44'.repeat(32)),
    /rpc response body is not valid JSON/,
  );
});

test('ShellProvider rejects non-object RPC responses', async () => {
  globalThis.fetch = async () => rpc([]);
  const provider = createShellProvider({ rpcHttpUrl: RPC_URL });

  await assert.rejects(
    provider.getPqPubkey('0x' + '44'.repeat(32)),
    /rpc response body must be a JSON-RPC object/,
  );
});

test('ShellProvider rejects RPC responses without result', async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    return rpc({ jsonrpc: '2.0', id: body.id });
  };
  const provider = createShellProvider({ rpcHttpUrl: RPC_URL });

  await assert.rejects(
    provider.getPqPubkey('0x' + '44'.repeat(32)),
    /rpc response body is missing result/,
  );
});

test('ShellProvider rejects malformed RPC error responses', async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    return rpc({ jsonrpc: '2.0', id: body.id, error: { code: 'bad', message: 123 } });
  };
  const provider = createShellProvider({ rpcHttpUrl: RPC_URL });

  await assert.rejects(
    provider.getPqPubkey('0x' + '44'.repeat(32)),
    /rpc error response is malformed/,
  );
});

function rpc(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
