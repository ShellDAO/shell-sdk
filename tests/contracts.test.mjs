import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAbi } from 'viem';

import {
  buildContractCallTransaction,
  buildDeployTransaction,
  decodeFunctionResult,
  deployContract,
  encodeFunctionData,
  readContract,
  waitForTransactionReceipt,
  writeContract,
} from '../dist/contracts.js';
import { compileSolidity } from '../dist/contracts-compiler.js';

const ADDRESS = '0x' + '11'.repeat(32);
const CONTRACT = '0x' + '22'.repeat(32);
const HASH = '0x' + '33'.repeat(32);
const ABI = parseAbi([
  'constructor(uint256 initial)',
  'function setNumber(uint256 newNumber)',
  'function getNumber() view returns (uint256)',
]);

function makeReceipt(overrides = {}) {
  return {
    transactionHash: HASH,
    blockHash: '0x' + '44'.repeat(32),
    blockNumber: '0x1',
    transactionIndex: '0x0',
    from: ADDRESS,
    to: null,
    status: '0x1',
    gasUsed: '0x5208',
    cumulativeGasUsed: '0x5208',
    effectiveGasPrice: '0x1',
    contractAddress: CONTRACT,
    logs: [],
    logsBloom: '0x' + '00'.repeat(256),
    type: '0x2',
    ...overrides,
  };
}

function makeProvider({ receipt = makeReceipt(), callResult = '0x' } = {}) {
  const calls = [];
  const provider = {
    rpcHttpUrl: 'http://127.0.0.1:8545',
    async sendTransaction(signed) {
      calls.push({ method: 'shell_sendTransaction', params: [signed] });
      return HASH;
    },
  };

  const fetchMock = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.method === 'eth_getTransactionCount') {
      return makeResponse({ jsonrpc: '2.0', id: body.id, result: '0x0' });
    }
    if (body.method === 'eth_getTransactionReceipt') {
      return makeResponse({ jsonrpc: '2.0', id: body.id, result: receipt });
    }
    if (body.method === 'eth_call') {
      return makeResponse({ jsonrpc: '2.0', id: body.id, result: callResult });
    }
    throw new Error(`unexpected method ${body.method}`);
  };

  return { provider, calls, fetchMock };
}

function makeSigner() {
  const signed = [];
  return {
    signed,
    getAddress() {
      return ADDRESS;
    },
    async buildSignedTransaction(options) {
      signed.push(options);
      return { tx: options.tx, signature: { sig_type: 'ML-DSA-65', data: [1, 2, 3] } };
    },
  };
}

function makeResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function withFetchMock(fetchMock, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchMock;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('buildDeployTransaction encodes constructor args and contract creation shape', () => {
  const tx = buildDeployTransaction({
    artifact: { contractName: 'Counter', abi: ABI, bytecode: '0x60006000' },
    chainId: 1337,
    nonce: 2,
    constructorArgs: [7n],
    gasLimit: 1_500_000,
  });

  assert.equal(tx.to, null);
  assert.equal(tx.chain_id, 1337);
  assert.equal(tx.nonce, 2);
  assert.equal(tx.gas_limit, 1_500_000);
  assert.match(tx.data, /^0x60006000/);
  assert.ok(tx.data.length > '0x60006000'.length, 'constructor args should be appended');
});

test('buildContractCallTransaction encodes calldata for Shell 32-byte address target', () => {
  const tx = buildContractCallTransaction({
    chainId: 1337,
    nonce: 3,
    address: CONTRACT,
    abi: ABI,
    functionName: 'setNumber',
    args: [9n],
    gasLimit: 120_000,
  });

  assert.equal(tx.to, CONTRACT);
  assert.equal(tx.gas_limit, 120_000);
  assert.match(tx.data, /^0x3fb5c1cb/);
});

test('deployContract sends, waits, and validates 32-byte contract address', async () => {
  const { provider, calls, fetchMock } = makeProvider();
  const signer = makeSigner();

  await withFetchMock(fetchMock, async () => {
    const result = await deployContract({
      provider,
      signer,
      chainId: 1337,
      artifact: { contractName: 'Counter', abi: ABI, bytecode: '0x60006000' },
      wait: true,
      pollIntervalMs: 0,
    });

    assert.equal(result.hash, HASH);
    assert.equal(result.nonce, 0);
    assert.equal(result.contractAddress, CONTRACT);
    assert.equal(signer.signed[0].includePublicKey, true);
  });

  assert.deepEqual(calls.map((call) => call.method), [
    'eth_getTransactionCount',
    'shell_sendTransaction',
    'eth_getTransactionReceipt',
  ]);
});

test('writeContract sends contract call and waits for receipt', async () => {
  const { provider, calls, fetchMock } = makeProvider({ receipt: makeReceipt({ to: CONTRACT, contractAddress: null }) });
  const signer = makeSigner();

  await withFetchMock(fetchMock, async () => {
    const result = await writeContract({
      provider,
      signer,
      chainId: 1337,
      address: CONTRACT,
      abi: ABI,
      functionName: 'setNumber',
      args: [12n],
      wait: true,
      pollIntervalMs: 0,
    });

    assert.equal(result.hash, HASH);
    assert.equal(result.receipt.status, '0x1');
    assert.equal(signer.signed[0].tx.to, CONTRACT);
  });

  assert.deepEqual(calls.map((call) => call.method), [
    'eth_getTransactionCount',
    'shell_sendTransaction',
    'eth_getTransactionReceipt',
  ]);
});

test('readContract uses eth_call and decodes result', async () => {
  const encoded = encodeFunctionData({ abi: ABI, functionName: 'getNumber' });
  assert.match(encoded, /^0xf2c9ecd8/);
  const callResult = '0x' + 15n.toString(16).padStart(64, '0');
  const { provider, calls, fetchMock } = makeProvider({ callResult });

  await withFetchMock(fetchMock, async () => {
    const value = await readContract({
      provider,
      address: CONTRACT,
      abi: ABI,
      functionName: 'getNumber',
    });

    assert.equal(value, 15n);
    assert.equal(decodeFunctionResult({ abi: ABI, functionName: 'getNumber', data: callResult }), 15n);
  });

  assert.equal(calls[0].method, 'eth_call');
  assert.equal(calls[0].params[0].to, CONTRACT);
});

test('waitForTransactionReceipt times out clearly', async () => {
  const { provider } = makeProvider();
  await withFetchMock(async (_url, init) => {
    const body = JSON.parse(init.body);
    return makeResponse({ jsonrpc: '2.0', id: body.id, result: null });
  }, async () => {
    await assert.rejects(
      () => waitForTransactionReceipt({ provider, hash: HASH, timeoutMs: 0, pollIntervalMs: 0 }),
      /timeout waiting for transaction receipt/,
    );
  });
});

test('compileSolidity returns normalized Shell contract artifact', async () => {
  const artifact = await compileSolidity({
    sources: [{
      path: 'Counter.sol',
      content: `
        // SPDX-License-Identifier: MIT
        pragma solidity ^0.8.20;
        contract Counter {
          uint256 private number;
          constructor(uint256 initial) { number = initial; }
          function getNumber() external view returns (uint256) { return number; }
        }
      `,
    }],
    contractName: 'Counter',
  });

  assert.equal(artifact.contractName, 'Counter');
  assert.equal(artifact.sourcePath, 'Counter.sol');
  assert.ok(Array.isArray(artifact.abi));
  assert.match(artifact.bytecode, /^0x[0-9a-f]+/i);
  assert.match(artifact.solcVersion, /^\d+\.\d+\.\d+/);
});
