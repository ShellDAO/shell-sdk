import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { setImmediate as flushTasks } from 'node:timers/promises';
import { parseAbi, toFunctionSelector } from 'viem';

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
import { createShellProvider } from '../dist/provider.js';
import { acknowledgementHash } from './helpers.mjs';
import { buildBatchTransaction } from '../dist/transactions.js';

const ADDRESS = '0x' + '11'.repeat(32);
const CONTRACT = '0x' + '22'.repeat(32);
const HASH = '0x' + '33'.repeat(32);
const ABI = parseAbi([
  'constructor(uint256 initial)',
  'function setNumber(uint256 newNumber)',
  'function getNumber() view returns (uint256)',
]);
const NO_CONSTRUCTOR_ABI = parseAbi([
  'function getNumber() view returns (uint256)',
]);
const NFT_ABI = parseAbi([
  'function mint(address to,string uri) returns (uint256 tokenId)',
  'function ownerOf(uint256 tokenId) view returns (address)',
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

function makeProvider({ receipt = hash => makeReceipt({ transactionHash: hash }), callResult = '0x', nonce = '0x0', pqPubkey = null, rpcApiKey } = {}) {
  const calls = [];
  let submittedHash;
  const provider = createShellProvider({ rpcHttpUrl: 'http://127.0.0.1:8545', rpcApiKey });

  const fetchMock = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (rpcApiKey && new Headers(init.headers).get('authorization') !== `Bearer ${rpcApiKey}`) {
      return new Response('Unauthorized', { status: 401 });
    }
    if (body.method === 'shell_sendTransaction') submittedHash = acknowledgementHash(body.params[0]);
    const results = {
      eth_getTransactionCount: nonce,
      eth_getTransactionReceipt: typeof receipt === 'function' ? receipt(body.params[0]) : receipt,
      eth_call: callResult,
      shell_getPqPubkey: pqPubkey,
      shell_sendTransaction: submittedHash,
    };
    if (Object.hasOwn(results, body.method)) {
      return makeResponse({ jsonrpc: '2.0', id: body.id, result: results[body.method] });
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
      return { from: ADDRESS, tx: options.tx, signature: { sig_type: 'ML-DSA-65', data: [1, 2, 3] } };
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

for (const [name, submit, build, transactionOptions] of [
  ['deployContract', deployContract, buildDeployTransaction, () => ({
    artifact: { contractName: 'Counter', abi: ABI, bytecode: '0x60006000' },
    constructorArgs: [7n],
  })],
  ['writeContract', writeContract, buildContractCallTransaction, () => ({
    address: CONTRACT, abi: ABI, functionName: 'setNumber', args: [7n],
  })],
]) {
  test(`${name} preserves submission inputs while the pending nonce is loading`, async () => {
    const { provider, calls, fetchMock } = makeProvider({ nonce: '0x7' });
    const signer = makeSigner();
    const replacementSigner = makeSigner();
    replacementSigner.getAddress = () => '0x' + '55'.repeat(32);
    let replacementBroadcasts = 0;
    let releaseNonce;
    const nonceReady = new Promise(resolve => { releaseNonce = resolve; });
    const options = {
      provider, signer, chainId: 1337, wait: true,
      ...transactionOptions(),
      accessList: [{ address: CONTRACT, storage_keys: ['0x' + '66'.repeat(32)] }],
    };
    const expected = structuredClone(build({ ...options, nonce: 7 }));

    await withFetchMock(async (url, init) => {
      if (JSON.parse(init.body).method === 'eth_getTransactionCount') {
        await nonceReady;
      }
      return fetchMock(url, init);
    }, async () => {
      const pending = submit(options);
      options.signer = replacementSigner;
      options.provider = {
        ...provider,
        async sendTransaction() { replacementBroadcasts += 1; return HASH; },
      };
      options.chainId = 42;
      options.includePublicKey = false;
      options.wait = false;
      (options.constructorArgs ?? options.args)[0] = 99n;
      options.accessList[0].storage_keys[0] = '0x' + '77'.repeat(32);
      if (options.artifact) options.artifact.bytecode = '0x60016001';
      releaseNonce();

      const result = await pending;
      assert.equal(replacementSigner.signed.length, 0, 'must retain the original signer');
      assert.equal(replacementBroadcasts, 0, 'must retain the original provider');
      assert.deepEqual(signer.signed, [{ tx: expected, includePublicKey: true }]);
      assert.equal(result.nonce, 7);
      assert.equal(result.receipt.transactionHash, result.hash);
      assert.deepEqual(calls.map(call => call.method), [
        'eth_getTransactionCount', 'shell_getPqPubkey', 'shell_sendTransaction', 'eth_getTransactionReceipt',
      ]);
      assert.equal(calls[0].params[0], ADDRESS);
    });
  });
}

test('contract helpers use the provider RPC API key throughout read, deploy and write', async () => {
  const { provider, calls, fetchMock } = makeProvider({
    rpcApiKey: 'test-api-key',
    nonce: '0x3',
    callResult: '0x' + 15n.toString(16).padStart(64, '0'),
  });
  await withFetchMock(fetchMock, async () => {
    const signer = makeSigner();
    const deployed = await deployContract({
      provider, signer, chainId: 1337,
      artifact: { contractName: 'Counter', abi: NO_CONSTRUCTOR_ABI, bytecode: '0x60006000' },
      wait: true,
    });
    assert.equal(deployed.nonce, 3);
    assert.equal(deployed.contractAddress, CONTRACT);
    const written = await writeContract({
      provider, signer, chainId: 1337, address: CONTRACT, abi: ABI,
      functionName: 'setNumber', args: [12n], wait: true,
    });
    assert.equal(written.nonce, 3);
    assert.equal(written.receipt.status, '0x1');
    assert.equal(await readContract({
      provider, address: CONTRACT, abi: ABI, functionName: 'getNumber',
    }), 15n);
  });
  assert.deepEqual(calls.map(call => call.method), [
    'eth_getTransactionCount', 'shell_getPqPubkey', 'shell_sendTransaction', 'eth_getTransactionReceipt',
    'eth_getTransactionCount', 'shell_getPqPubkey', 'shell_sendTransaction', 'eth_getTransactionReceipt',
    'eth_call',
  ]);
  assert.equal(calls[0].params[1], 'pending');
});

test('deployContract sends, waits, and validates 32-byte contract address', async () => {
  const { provider, calls, fetchMock } = makeProvider();
  const signer = makeSigner();

  await withFetchMock(fetchMock, async () => {
    const result = await deployContract({
      provider,
      signer,
      chainId: 1337,
      artifact: { contractName: 'Counter', abi: NO_CONSTRUCTOR_ABI, bytecode: '0x60006000' },
      wait: true,
      pollIntervalMs: 0,
    });

    assert.equal(result.hash, acknowledgementHash(calls.find(call => call.method === 'shell_sendTransaction').params[0]));
    assert.equal(result.nonce, 0);
    assert.equal(result.contractAddress, CONTRACT);
    assert.equal(signer.signed[0].includePublicKey, true);
  });

  assert.deepEqual(calls.map((call) => call.method), [
    'eth_getTransactionCount',
    'shell_getPqPubkey',
    'shell_sendTransaction',
    'eth_getTransactionReceipt',
  ]);
});

test('deployContract rejects malformed pending nonce quantities before signing', async () => {
  const { provider, fetchMock } = makeProvider({ nonce: '0x01' });
  const signer = makeSigner();

  await withFetchMock(fetchMock, async () => {
    await assert.rejects(
      deployContract({
        provider,
        signer,
        chainId: 1337,
        artifact: { contractName: 'Counter', abi: NO_CONSTRUCTOR_ABI, bytecode: '0x60006000' },
      }),
      /canonical 0x-prefixed JSON-RPC quantity/,
    );
  });

  assert.equal(signer.signed.length, 0);
});

test('deployContract rejects pending nonces outside JavaScript safe integer range', async () => {
  const { provider, fetchMock } = makeProvider({ nonce: '0x20000000000000' });
  const signer = makeSigner();

  await withFetchMock(fetchMock, async () => {
    await assert.rejects(
      deployContract({
        provider,
        signer,
        chainId: 1337,
        artifact: { contractName: 'Counter', abi: NO_CONSTRUCTOR_ABI, bytecode: '0x60006000' },
      }),
      /non-negative safe integer/,
    );
  });

  assert.equal(signer.signed.length, 0);
});

test('writeContract sends contract call and waits for receipt', async () => {
  const { provider, calls, fetchMock } = makeProvider({ receipt: hash => makeReceipt({ transactionHash: hash, to: CONTRACT, contractAddress: null }) });
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

    assert.equal(result.hash, acknowledgementHash(calls.find(call => call.method === 'shell_sendTransaction').params[0]));
    assert.equal(result.receipt.status, '0x1');
    assert.equal(signer.signed[0].tx.to, CONTRACT);
  });

  assert.deepEqual(calls.map((call) => call.method), [
    'eth_getTransactionCount',
    'shell_getPqPubkey',
    'shell_sendTransaction',
    'eth_getTransactionReceipt',
  ]);
});

test('writeContract embeds the key for an unregistered sender with a pending nonce', async () => {
  const { provider, fetchMock } = makeProvider({ nonce: '0x1' });
  const signer = makeSigner();

  await withFetchMock(fetchMock, async () => {
    await writeContract({
      provider,
      signer,
      chainId: 1337,
      address: CONTRACT,
      abi: ABI,
      functionName: 'setNumber',
      args: [12n],
    });
  });

  assert.equal(signer.signed[0].includePublicKey, true);
});

test('writeContract omits the key once the sender is registered on-chain', async () => {
  const { provider, fetchMock } = makeProvider({ nonce: '0x1', pqPubkey: '0x1234' });
  const signer = makeSigner();

  await withFetchMock(fetchMock, async () => {
    await writeContract({
      provider,
      signer,
      chainId: 1337,
      address: CONTRACT,
      abi: ABI,
      functionName: 'setNumber',
      args: [12n],
    });
  });

  assert.equal(signer.signed[0].includePublicKey, false);
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

test('Shell contract ABI keeps address keyword while encoding 32-byte addresses', () => {
  const encoded = encodeFunctionData({
    abi: NFT_ABI,
    functionName: 'mint',
    args: [ADDRESS, 'ipfs://example/1.json'],
  });

  assert.equal(encoded.slice(0, 10), toFunctionSelector('mint(address,string)'));
  assert.notEqual(encoded.slice(0, 10), toFunctionSelector('mint(bytes32,string)'));
  assert.ok(encoded.includes(ADDRESS.slice(2)), 'full 32-byte Shell address should be encoded');
  assert.throws(
    () => encodeFunctionData({ abi: NFT_ABI, functionName: 'mint', args: ['0x' + '11'.repeat(20), 'x'] }),
    /Shell address/,
  );
});

test('Shell contract ABI decodes address returns as 32-byte addresses', () => {
  const decoded = decodeFunctionResult({
    abi: NFT_ABI,
    functionName: 'ownerOf',
    data: ADDRESS,
  });

  assert.equal(decoded, ADDRESS);
});

test('receipt polling rejects unrelated or missing transaction hashes', async (t) => {
  for (const [name, transactionHash] of [
    ['another transaction', '0x' + 'ab'.repeat(32)],
    ['missing hash', undefined],
    ['null hash', null],
    ['malformed hash', '0x1234'],
  ]) {
    await t.test(name, async () => {
      const { provider, fetchMock, calls } = makeProvider({ receipt: makeReceipt({ transactionHash }) });
      await withFetchMock(fetchMock, async () => {
        await assert.rejects(
          waitForTransactionReceipt({ provider, hash: HASH }),
          /receipt.*hash.*does not match/,
        );
      });
      assert.equal(calls.length, 1, 'an invalid response must not start another poll');
    });
  }
});

test('receipt polling accepts matching hashes regardless of hex letter case', async () => {
  const hash = '0x' + 'ab'.repeat(32);
  const receipt = makeReceipt({ transactionHash: '0x' + 'AB'.repeat(32), status: '0x0' });
  const { provider, fetchMock } = makeProvider({ receipt });
  await withFetchMock(fetchMock, async () => {
    assert.deepEqual(await waitForTransactionReceipt({ provider, hash }), receipt);
  });
});

test('receipt polling rejects malformed requested hashes before RPC', async () => {
  const { provider, calls, fetchMock } = makeProvider();
  await withFetchMock(fetchMock, async () => {
    await assert.rejects(
      waitForTransactionReceipt({ provider, hash: '0x1234' }),
      /hash must be a valid 32-byte hash/,
    );
  });
  assert.equal(calls.length, 0);
});

test('deployContract does not return an address from an unrelated receipt', async () => {
  const { provider, fetchMock } = makeProvider({
    receipt: makeReceipt({ transactionHash: '0x' + 'ab'.repeat(32) }),
  });
  await withFetchMock(fetchMock, async () => {
    await assert.rejects(deployContract({
      provider,
      signer: makeSigner(),
      chainId: 1337,
      artifact: { contractName: 'Counter', abi: NO_CONSTRUCTOR_ABI, bytecode: '0x60006000' },
      wait: true,
    }), /receipt.*hash.*does not match/);
  });
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

test('receipt polling sleeps only within the remaining timeout budget', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let requests = 0;
  let respond;
  const provider = { client: { request: () => {
    requests += 1;
    return new Promise(resolve => { respond = resolve; });
  } } };
  const outcome = assert.rejects(
    waitForTransactionReceipt({ provider, hash: HASH, timeoutMs: 50, pollIntervalMs: 1000 }),
    /timeout waiting for transaction receipt/,
  );
  t.mock.timers.tick(40);
  respond(null);
  await flushTasks();
  t.mock.timers.tick(10);
  await outcome;
  assert.equal(requests, 1, 'must not start another poll at the deadline');
});

test('receipt deadline ends a stalled RPC and ignores its late completion', async (t) => {
  for (const lateResult of ['receipt', 'null', 'error']) {
    await t.test(lateResult, async (t) => {
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
      let requests = 0;
      let respond;
      let reject;
      const provider = { client: { request: () => {
        requests += 1;
        return new Promise((resolve, fail) => { respond = resolve; reject = fail; });
      } } };
      let settled = false;
      const outcome = waitForTransactionReceipt({ provider, hash: HASH, timeoutMs: 50 })
        .then(value => { settled = true; return value; }, error => { settled = true; throw error; });
      const rejection = assert.rejects(outcome, /timeout waiting for transaction receipt/);
      rejection.catch(() => {});
      try {
        t.mock.timers.tick(49);
        await flushTasks();
        assert.equal(settled, false);
        t.mock.timers.tick(1);
        await flushTasks();
        assert.equal(settled, true, 'must reject while RPC is still pending');
      } finally {
        if (lateResult === 'error') reject(new Error('late transport error'));
        else respond(lateResult === 'receipt' ? makeReceipt() : null);
        // Release baseline waits too, so a failed regression leaves no pending work.
        t.mock.timers.tick(1000);
        await flushTasks();
        await rejection.catch(() => {});
      }
      await rejection;
      assert.equal(requests, 1, 'late completion must not restart receipt polling');
    });
  }
});

test('receipt wait supports long deadlines and clears its timer after success', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const schedule = t.mock.method(globalThis, 'setTimeout');
  const clear = t.mock.method(globalThis, 'clearTimeout');
  let respond;
  const provider = { client: { request: () => new Promise(resolve => { respond = resolve; }) } };
  const maxDelay = 2 ** 31 - 1;
  let settled = false;
  const outcome = waitForTransactionReceipt({ provider, hash: HASH, timeoutMs: maxDelay + 50 })
    .then(value => { settled = true; return value; });
  assert.equal(schedule.mock.calls[0].arguments[1], maxDelay);
  t.mock.timers.tick(maxDelay);
  await flushTasks();
  assert.equal(settled, false, 'timer limit must not shorten the requested deadline');
  assert.equal(schedule.mock.calls[1].arguments[1], 50);
  respond(makeReceipt());
  assert.deepEqual(await outcome, makeReceipt());
  assert.equal(clear.mock.callCount(), 1);
  assert.equal(clear.mock.calls[0].arguments[0], schedule.mock.calls[1].result);
});

test('receipt wait rejects responses processed after the deadline even before timers run', async (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const provider = { client: { request: async () => {
    now = 51;
    return makeReceipt();
  } } };
  await assert.rejects(
    waitForTransactionReceipt({ provider, hash: HASH, timeoutMs: 50 }),
    /timeout waiting for transaction receipt/,
  );
});

test('receipt wait preserves RPC errors and releases its deadline timer', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const clear = t.mock.method(globalThis, 'clearTimeout');
  const error = new Error('RPC unavailable');
  const provider = { client: { request: async () => { throw error; } } };
  await assert.rejects(waitForTransactionReceipt({ provider, hash: HASH }), actual => actual === error);
  assert.equal(clear.mock.callCount(), 1);
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


const OVERLOADED_ABI = parseAbi([
  'function set(address value) returns (address)',
  'function set(uint256 value) returns (uint256)',
]);
const OVERLOAD_WORD = '0x' + '34'.repeat(12) + '12'.repeat(20);
const OVERLOAD_AMOUNT = BigInt(OVERLOAD_WORD);
const OVERLOAD_CASES = [
  ['set(address)', OVERLOAD_WORD, '0x2801617e', OVERLOAD_WORD, OVERLOAD_WORD],
  ['set(uint256)', OVERLOAD_AMOUNT, '0x60fe47b1', OVERLOAD_AMOUNT + 1n,
    '0x' + (OVERLOAD_AMOUNT + 1n).toString(16).padStart(64, '0')],
];

test('canonical overload signatures retain full ABI, original selectors and result types', () => {
  const original = structuredClone(OVERLOADED_ABI);
  for (const [functionName, argument, selector, value, result] of OVERLOAD_CASES) {
    const data = selector + OVERLOAD_WORD.slice(2);
    assert.equal(encodeFunctionData({abi:OVERLOADED_ABI,functionName,args:[argument]}), data);
    assert.equal(buildContractCallTransaction({chainId:1337,nonce:0,address:CONTRACT,
      abi:OVERLOADED_ABI,functionName,args:[argument]}).data, data);
    assert.equal(decodeFunctionResult({abi:OVERLOADED_ABI,functionName,data:result}),value);
  }
  assert.deepEqual(OVERLOADED_ABI,original);
  assert.throws(() => encodeFunctionData({abi:OVERLOADED_ABI,functionName:'set',args:[OVERLOAD_WORD]}),/ambiguous overloaded/);
  assert.throws(() => decodeFunctionResult({abi:OVERLOADED_ABI,functionName:'set',data:OVERLOAD_WORD}),/ambiguous overloaded/);
  assert.throws(() => encodeFunctionData({abi:OVERLOADED_ABI,functionName:'set(bytes32)',args:[OVERLOAD_WORD]}),/not found/);
  assert.throws(() => encodeFunctionData({abi:OVERLOADED_ABI,functionName:'set(address)',args:[]}),/not found/);
  assert.throws(() => encodeFunctionData({abi:OVERLOADED_ABI,functionName:'set(address)',args:['0x'+'12'.repeat(20)]}),/Shell address/);
});

test('canonical tuple overload selects original address components without narrowing ABI', () => {
  const abi=parseAbi(['function inspect((address owner,uint256 value) entry) returns (address)',
    'function inspect(uint256 value) returns (uint256)']);
  const data=encodeFunctionData({abi,functionName:'inspect((address,uint256))',
    args:[{owner:OVERLOAD_WORD,value:19n}]});
  assert.equal(data,toFunctionSelector('inspect((address,uint256))')+OVERLOAD_WORD.slice(2)+19n.toString(16).padStart(64,'0'));
  assert.equal(decodeFunctionResult({abi,functionName:'inspect((address,uint256))',data:OVERLOAD_WORD}),OVERLOAD_WORD);
});

test('read and write helpers share explicit original overload selection', async () => {
  for (const [functionName, argument, selector, value, result] of OVERLOAD_CASES) {
    const {provider,calls,fetchMock}=makeProvider({callResult:result});
    const signer=makeSigner();
    await withFetchMock(fetchMock,async () => {
      assert.equal(await readContract({provider,address:CONTRACT,abi:OVERLOADED_ABI,
        functionName,args:[argument]}),value);
      await writeContract({provider,signer,address:CONTRACT,abi:OVERLOADED_ABI,
        functionName,args:[argument],chainId:1337,nonce:0,includePublicKey:true});
    });
    assert.equal(calls.find(call=>call.method==='eth_call').params[0].data,selector+OVERLOAD_WORD.slice(2));
    assert.equal(signer.signed[0].tx.data,selector+OVERLOAD_WORD.slice(2));
  }
});


const derivedLiveCases=JSON.parse(readFileSync(new URL('./fixtures/native-derived-overloads.json',import.meta.url),'utf8'));
for(const variant of [{kind:'canonical',array:false},...derivedLiveCases]) {
 for(const algorithm of ['MlDsa65','Dilithium3']) {
  for(const entry of ['ordinary','AA','CLI']) {
 test(`canonical overload real RPC: ${variant.kind}/${algorithm}/${entry} mined state, P2P import and crash recovery`,
  {skip:!process.env.SHELL_NODE_BIN, timeout:120000}, async () => {
    const {mkdtemp,mkdir,writeFile,readFile,rm}=await import('node:fs/promises');
    const {openSync,closeSync}=await import('node:fs');
    const {tmpdir}=await import('node:os');
    const {join}=await import('node:path');
    const {spawn,spawnSync}=await import('node:child_process');
    const {createServer}=await import('node:net');
    const {once}=await import('node:events');
    const {randomBytes}=await import('node:crypto');
    const {generateAdapter}=await import('../dist/adapters.js');
    const {ShellSigner}=await import('../dist/signer.js');
    const binary=process.env.SHELL_NODE_BIN;
    const directory=await mkdtemp(join(tmpdir(),`shell-sdk-overload-${variant.kind}-${algorithm}-${entry}-`));
    let signer=new ShellSigner(algorithm,generateAdapter(algorithm));
    const contract='0x'+'99'.repeat(32), zero='0x'+'00'.repeat(32);
    const second='0x'+'56'.repeat(12)+'12'.repeat(20);
    const initialBalance=10000000000000000000n, maxFee=1000000000n;
    const password=randomBytes(24).toString('hex');
    const nodes={},receipts=[],history=[];
    let passed=false, balance=initialBalance;
    const artifactPath=join(directory,'Stateful.json'),signerPath=join(directory,'signer.json');
    function cli(command,options=[]) {
      return spawnSync(process.execPath,[new URL('../dist/cli.js',import.meta.url).pathname,'contract',command,...options],
        {encoding:'utf8',timeout:30000,env:{...process.env,SHELL_KEYSTORE_PASSWORD:password}});
    }
    const jsonArgs=args=>JSON.stringify(args,(_key,value)=>typeof value==='bigint'?value.toString()+'n':value);
    async function until(check, label, timeout=15000) {
      const deadline=Date.now()+timeout;
      while(Date.now()<deadline) {
        for(const node of Object.values(nodes)) {
          assert.equal(node.child.exitCode,null,`${node.name} exited during ${label}`);
          assert.equal(node.child.signalCode,null,`${node.name} signalled during ${label}`);
        }
        if(await check())return;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      assert.fail(`${label} timeout`);
    }
    async function port() {
      const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
      const result=server.address().port;await new Promise(resolve=>server.close(resolve));return result;
    }
    async function stop(name, signal='SIGTERM') {
      const node=nodes[name];if(!node)return;
      if(node.child.exitCode===null && node.child.signalCode===null)node.child.kill(signal);
      const timer=setTimeout(()=>node.child.kill('SIGKILL'),5000);timer.unref();
      try {await node.exit;} finally {clearTimeout(timer);closeSync(node.log);delete nodes[name];}
    }
    async function start(name, bootnode) {
      const rpcPort=await port(),p2pPort=await port(),data=join(directory,name);
      const logPath=join(directory,`${name}.log`),log=openSync(logPath,'a');
      const args=['--log-level','info','--datadir',data,'run','--network','dev','--chain-id','1337',
        '--block-time','1000','--max-idle-interval','0','--db','rocksdb','--consensus-engine','wpoa',
        '--storage-profile','archive','--rpc-addr',`127.0.0.1:${rpcPort}`,
        '--rpc-api','eth,net,web3,shell,debug','--config',join(directory,'config.toml'),
        '--p2p','--p2p-addr',`127.0.0.1:${p2pPort}`];
      if(name==='validator')args.push('--keystore',join(directory,'validator.json'),'--password-stdin','--node-role','validator');
      else args.push('--node-role','prover');
      if(bootnode)args.push('--bootnode',bootnode);
      const child=spawn(binary,args,{stdio:['pipe',log,log]});
      child.stdin.end(name==='validator'?password+'\n':'');
      const node={name,child,exit:once(child,'exit'),log,logPath,url:`http://127.0.0.1:${rpcPort}`,
        provider:createShellProvider({rpcHttpUrl:`http://127.0.0.1:${rpcPort}`})};
      nodes[name]=node;
      await until(async()=>{
        try {return await node.provider.client.request({method:'eth_chainId',params:[]})==='0x539';}
        catch {return false;}
      },`${name} RPC startup`);
      await until(async()=>{
        const text=await readFile(logPath,'utf8');
        node.bootnode=text.match(new RegExp(`/ip4/127\\.0\\.0\\.1/tcp/${p2pPort}/p2p/[A-Za-z0-9]+`))?.[0];
        return Boolean(node.bootnode);
      },`${name} transport identity`);
      return node;
    }
    const rpc=(name,method,params=[])=>nodes[name].provider.client.request({method,params});
    async function state(name) {
      const tag='latest';
      const words=[];
      for(const slot of [0,1,2])words.push(await rpc(name,'eth_getStorageAt',[contract,'0x'+slot.toString(16),tag]));
      return {words,nonce:BigInt(await rpc(name,'eth_getTransactionCount',[signer.getAddress(),tag])),
        balance:BigInt(await rpc(name,'eth_getBalance',[signer.getAddress(),tag]))};
    }
    const word=value=>'0x'+BigInt(value).toString(16).padStart(64,'0');
    async function wordsAt(name,tag) {
      const words=[];
      for(const functionName of [variant.kind==='canonical'?'owner()':'nativeOwner()',variant.kind==='canonical'?'amount()':'nativeAmount()','writes()']) {
        let value;
        if(entry==='CLI'&&tag==='latest') {
          const result=cli('read',['--artifact',artifactPath,'--address',contract,'--function',functionName,
            '--rpc',nodes[name].url]);
          assert.equal(result.status,0,result.stderr);value=JSON.parse(result.stdout);
          if(functionName!=='nativeOwner()'&&functionName!=='owner()')value=BigInt(value);
        } else value=await readContract({provider:nodes[name].provider,address:contract,
          abi:artifact.abi,functionName,blockTag:tag});
        words.push(typeof value==='bigint'?word(value):value);
      }
      return words;
    }
    let artifact;
    async function synchronized(receipt,expected,checkLatest=true) {
      await until(async()=>Boolean(await rpc('follower','eth_getTransactionReceipt',[receipt.transactionHash])), 'follower receipt',30000);
      assert.deepEqual(await rpc('follower','eth_getTransactionReceipt',[receipt.transactionHash]),receipt);
      const blocks=[];
      for(const name of ['validator','follower']) {
        const block=await rpc(name,'eth_getBlockByNumber',[receipt.blockNumber,false]);
        assert.equal(block.hash,receipt.blockHash);
        assert.deepEqual(await wordsAt(name,receipt.blockNumber),expected.words);
        if(checkLatest)assert.deepEqual(await state(name),expected);
        blocks.push(block);
      }
      assert.equal(blocks[0].stateRoot,blocks[1].stateRoot);
      assert.equal(blocks[0].hash,blocks[1].hash);
    }
    try {
      const content=variant.content??`pragma solidity ^0.8.35;
contract StatefulOverloads {
 address public owner;
 uint256 public amount;
 uint256 public writes;
 function value(address v) internal pure returns(address) {return v;}
 function value(uint256 v) internal pure returns(uint256) {return v+1;}
 function set(address v) external returns(address) {owner=value(v);writes++;require(v!=address(0));return owner;}
 function set(uint256 v) external returns(uint256) {amount=value(v);writes++;return amount;}
}
`;
      const options={sources:[{path:'StatefulOverloads.sol',content}],
        contractName:variant.kind==='canonical'?'StatefulOverloads':'StatefulDerived',evmVersion:'shanghai'};
      const originalArtifact=await compileSolidity({...options,target:'evm'});
      artifact=await compileSolidity({...options,target:'pqvm'});
      assert.deepEqual(artifact.abi,originalArtifact.abi);
      if(entry==='CLI') {
        const source=join(directory,'Stateful.sol');await writeFile(source,content);
        const compiled=cli('compile',['--source',source,'--contract',options.contractName,'--out',artifactPath,'--pqvm']);
        assert.equal(compiled.status,0,compiled.stderr);
        artifact=JSON.parse(await readFile(artifactPath,'utf8'));assert.deepEqual(artifact.abi,originalArtifact.abi);
        const account=spawnSync(binary,['--password-stdin','key','generate','--algorithm',algorithm==='MlDsa65'?'mldsa65':'dilithium3',
          '--output',signerPath],{input:password+'\n',encoding:'utf8',timeout:30000});
        assert.equal(account.status,0,account.stderr||account.stdout);
        const {decryptKeystore}=await import('../dist/keystore.js');signer.dispose();
        signer=await decryptKeystore(JSON.parse(await readFile(signerPath,'utf8')),password);
      }
      const key=spawnSync(binary,['--password-stdin','key','generate','--algorithm','mldsa65',
        '--output',join(directory,'validator.json')],{input:password+'\n',encoding:'utf8',timeout:30000});
      assert.equal(key.status,0,key.stderr||key.stdout);
      const authority=JSON.parse(await readFile(join(directory,'validator.json'),'utf8'));
      const genesis={chain_id:1337,timestamp:Math.floor(Date.now()/1000),network_type:'Dev',fee_accounting_activation_height:0,
        consensus:{engine:'wpoa',authorities:[authority.address],authority_pubkeys:[authority.public_key],
          weights:[1],block_time_secs:1,max_future_secs:60,epoch_length:0},
        alloc:{[signer.getAddress()]:{balance:'0x8ac7230489e80000'},
          [contract]:{balance:'0x0',code:artifact.deployedBytecode.slice(2)}}};
      const genesisPath=join(directory,'input-genesis.json');
      await writeFile(genesisPath,JSON.stringify(genesis));
      await writeFile(join(directory,'config.toml'),'[metrics]\nenabled = false\n');
      for(const name of ['validator','follower']) {
        const data=join(directory,name);await mkdir(data);
        const init=spawnSync(binary,['--datadir',data,'init','--genesis',genesisPath,'--network','dev','--chain-id','1337'],{encoding:'utf8',timeout:30000});
        assert.equal(init.status,0,init.stderr||init.stdout);
      }
      const validator=await start('validator');
      const abi=artifact.abi,original=structuredClone(abi);
      for(const [functionName,argument,selector,expected] of variant.kind==='canonical'?OVERLOAD_CASES:[]) {
        assert.equal(await readContract({provider:validator.provider,address:contract,abi,functionName,args:[argument]}),expected);
        assert.equal(encodeFunctionData({abi,functionName,args:[argument]}),selector+OVERLOAD_WORD.slice(2));
      }
      assert.deepEqual((await state('validator')).words,[zero,zero,zero]);
      await start('follower',validator.bootnode);
      await until(async()=>Number(await rpc('follower','net_peerCount'))>=1,'follower peer');
      // Independent expectations from the original Solidity state transitions.
      const ordinarySteps=[
        ['set(address)',OVERLOAD_WORD,true,[OVERLOAD_WORD,zero,word(1)]],
        ['set(uint256)',OVERLOAD_AMOUNT,true,[OVERLOAD_WORD,word(OVERLOAD_AMOUNT+1n),word(2)]],
        ['set(address)',second,true,[second,word(OVERLOAD_AMOUNT+1n),word(3)]],
        ['set(address)',zero,false,[second,word(OVERLOAD_AMOUNT+1n),word(3)]],
        ['set(uint256)',(1n<<256n)-1n,false,[second,word(OVERLOAD_AMOUNT+1n),word(3)]],
        ['truncated',OVERLOAD_WORD,false,[second,word(OVERLOAD_AMOUNT+1n),word(3)]],
        ...(variant.array?[['empty',null,false,[second,word(OVERLOAD_AMOUNT+1n),word(3)]]]:[]),
        ['set(uint256)',0n,true,[second,word(1),word(4)]],
      ];
      const aaSteps=[
        [[['set(address)',OVERLOAD_WORD],['set(uint256)',OVERLOAD_AMOUNT]],true,[OVERLOAD_WORD,word(OVERLOAD_AMOUNT+1n),word(2)]],
        [[['set(address)',second]],true,[second,word(OVERLOAD_AMOUNT+1n),word(3)]],
        [[['set(uint256)',0n],['set(address)',zero]],false,[second,word(OVERLOAD_AMOUNT+1n),word(3)]],
        [[['set(address)',OVERLOAD_WORD],['set(uint256)',(1n<<256n)-1n]],false,[second,word(OVERLOAD_AMOUNT+1n),word(3)]],
        [[['set(uint256)',23n],['truncated',OVERLOAD_WORD]],false,[second,word(OVERLOAD_AMOUNT+1n),word(3)]],
        ...(variant.array?[[[['set(address)',OVERLOAD_WORD],['empty',null]],false,[second,word(OVERLOAD_AMOUNT+1n),word(3)]]]:[]),
        [[['set(uint256)',0n],['set(address)',OVERLOAD_WORD]],true,[OVERLOAD_WORD,word(1),word(5)]],
      ];
      const steps=entry==='AA'?aaSteps:entry==='CLI'?ordinarySteps.filter(step=>step[0]!=='truncated'):ordinarySteps;
      async function execute(step,nonce,checkFollower=true) {
        const [functionName,argument]=step;
        const success=step[entry==='AA'?1:2],words=step[entry==='AA'?2:3];
        let hash;
        if(entry==='AA') {
          const innerCalls=functionName.map(([name,value])=>{
            const signature=variant.array?name.replace('address)','address[])').replace('uint256)','uint256[])'):name;
            const addressSignature=variant.array?'set(address[])':'set(address)';
            const args=[variant.array?[value,typeof value==='bigint'?23n:second]:value];
            let data=encodeFunctionData({abi,functionName:name==='truncated'||name==='empty'?addressSignature:signature,args:name==='empty'?[[]]:args});
            if(name==='truncated')data=data.slice(0,-2);
            else if(name!=='empty') {
              const selector=signature==='set(address)'?'0x2801617e':signature==='set(uint256)'?'0x60fe47b1':signature==='set(address[])'?'0x11f2a107':'0x6ea9bfc5';
              assert.equal(data,selector+(variant.array?word(32).slice(2)+word(2).slice(2):'')+word(value).slice(2)
                +(variant.array?word(typeof value==='bigint'?23n:second).slice(2):''));
            }
            return {to:contract,value:'0x0',data,gas_limit:'0x7a120'};
          });
          const {tx,aa_bundle}=buildBatchTransaction({chainId:1337,nonce,innerCalls,gasLimit:1500000,
            maxFeePerGas:Number(maxFee),maxPriorityFeePerGas:0});
          const signed=await signer.buildSignedTransaction({tx,aaBundle:aa_bundle,includePublicKey:true});
          if(nonce===0) {
            const before=await state('validator');
            const changed=structuredClone(signed);changed.aa_bundle.inner_calls[0].data=changed.aa_bundle.inner_calls[0].data.slice(0,-2)+'ff';
            await assert.rejects(nodes.validator.provider.sendTransaction(changed),/signature|hash|invalid|mismatch/i);
            const corrupt=structuredClone(signed);corrupt.signature.data[0]^=1;
            await assert.rejects(nodes.validator.provider.sendTransaction(corrupt),/signature|hash|invalid|mismatch/i);
            const cross=structuredClone(signed);cross.signature.sig_type=algorithm==='MlDsa65'?'Dilithium3':'MlDsa65';
            await assert.rejects(nodes.validator.provider.sendTransaction(cross),/signature|hash|invalid|mismatch|sender|address/i);
            assert.deepEqual(await state('validator'),before);
          }
          hash=await nodes.validator.provider.sendTransaction(signed);
        } else {
          const signature=variant.array?functionName.replace('address)','address[])').replace('uint256)','uint256[])'):functionName;
          const args=[variant.array?[argument,typeof argument==='bigint'?23n:second]:argument];
          const addressSignature=variant.array?'set(address[])':'set(address)';
          if(entry==='CLI') {
            const cliSignature=functionName==='empty'?addressSignature:signature;
            const cliArgs=functionName==='empty'?[[]]:args;
            const encoded=encodeFunctionData({abi,functionName:cliSignature,args:cliArgs});
            const result=cli('write',['--artifact',artifactPath,'--keystore',signerPath,'--address',contract,'--function',cliSignature,
              '--args',jsonArgs(cliArgs),'--rpc',nodes.validator.url,'--chain-id','1337','--gas-limit','500000']);
            assert.equal(result.status,success?0:1,result.stderr);
            if(success) {
              const output=JSON.parse(result.stdout);assert.equal(output.nonce,nonce);hash=output.hash;
            } else {
              assert.match(result.stderr,/contract write reverted:/);hash=result.stderr.match(/0x[0-9a-f]{64}/)?.[0];assert.ok(hash);
            }
            const submitted=await rpc('validator','eth_getTransactionByHash',[hash]);
            assert.equal(submitted.input,encoded);
            assert.deepEqual(await wordsAt('validator','latest'),words);
          } else if(functionName==='truncated'||functionName==='empty') {
            const tx=buildContractCallTransaction({address:contract,abi,functionName:addressSignature,args:functionName==='empty'?[[]]:args,
              chainId:1337,nonce,gasLimit:500000,maxFeePerGas:Number(maxFee),maxPriorityFeePerGas:0});
            if(functionName==='truncated')tx.data=tx.data.slice(0,-2);
            hash=await validator.provider.sendTransaction(await signer.buildSignedTransaction({tx,includePublicKey:true}));
          } else {
            const selector=signature==='set(address)'?'0x2801617e':signature==='set(uint256)'?'0x60fe47b1':signature==='set(address[])'?'0x11f2a107':'0x6ea9bfc5';
            const expectedData=selector+(variant.array?word(32).slice(2)+word(2).slice(2):'')+word(argument).slice(2)
              +(variant.array?word(typeof argument==='bigint'?23n:second).slice(2):'');
            assert.equal(encodeFunctionData({abi,functionName:signature,args}),expectedData);
            ({hash}=await writeContract({provider:nodes.validator.provider,signer,chainId:1337,nonce,address:contract,
              abi,functionName:signature,args,includePublicKey:true,wait:false,gasLimit:500000,
              maxFeePerGas:Number(maxFee),maxPriorityFeePerGas:0}));
          }
        }
        const receipt=await waitForTransactionReceipt({provider:nodes.validator.provider,hash,timeoutMs:30000,pollIntervalMs:100});
        assert.equal(receipt.status,success?'0x1':'0x0');
        assert.equal(receipt.from,signer.getAddress());assert.equal(receipt.to,entry==='AA'?null:contract);
        assert.equal(receipt.type,entry==='AA'?'0x7e':'0x2');
        const block=await rpc('validator','eth_getBlockByNumber',[receipt.blockNumber,false]);
        assert.equal(block.hash,receipt.blockHash);assert.ok(block.transactions.includes(hash));
        const submitted=entry==='CLI'?await rpc('validator','eth_getTransactionByHash',[hash]):null;
        const feeCap=submitted?BigInt(submitted.maxFeePerGas):maxFee;
        const priority=submitted?BigInt(submitted.maxPriorityFeePerGas):0n;
        const baseFee=BigInt(block.baseFeePerGas),price=baseFee+priority<feeCap?baseFee+priority:feeCap;
        assert.equal(BigInt(receipt.effectiveGasPrice),price);
        balance-=BigInt(receipt.gasUsed)*price;
        const expected={words,nonce:BigInt(nonce+1),balance};
        assert.deepEqual(await state('validator'),expected);
        await assert.rejects(rpc('validator','eth_getStorageAt',[contract,'0x0',receipt.blockNumber]),
          /historical state queries are not supported/);
        if(checkFollower)await synchronized(receipt,expected);
        receipts.push(receipt);history.push(expected);
      }
      for(const [nonce,step] of steps.entries())await execute(step,nonce);
      for(const name of ['validator','follower']) {
        const before=await state(name);
        for(let i=receipts.length-1;i>=0;i--)assert.deepEqual(await wordsAt(name,receipts[i].blockNumber),history[i].words);
        assert.deepEqual(await state(name),before);
      }
      // SIGKILL bypasses normal shutdown: reopen the same WAL-backed databases.
      await stop('follower','SIGKILL');
      await execute(entry==='AA'?[[['set(address)',second]],true,[second,word(1),word(6)]]
        :['set(address)',OVERLOAD_WORD,true,[OVERLOAD_WORD,word(1),word(5)]],steps.length,false);
      await until(async()=>{
        const finalized=await rpc('validator','eth_getBlockByNumber',['finalized',false]);
        return finalized && BigInt(finalized.number)>=BigInt(receipts.at(-1).blockNumber);
      },'offline write finality');
      await stop('validator','SIGKILL');
      const resumed=await start('validator');await start('follower',resumed.bootnode);
      for(let i=0;i<receipts.length;i++)await synchronized(receipts[i],history[i],false);
      assert.deepEqual(await state('validator'),history.at(-1));
      await execute(entry==='AA'?[[['set(address)',OVERLOAD_WORD],['set(uint256)',23n]],true,[OVERLOAD_WORD,word(24),word(8)]]
        :['set(uint256)',23n,true,[OVERLOAD_WORD,word(24),word(6)]],steps.length+1);
      await until(async()=>{
        for(const name of ['validator','follower']) {
          const finalized=await rpc(name,'eth_getBlockByNumber',['finalized',false]);
          if(!finalized || BigInt(finalized.number)<BigInt(receipts.at(-1).blockNumber))return false;
        }
        return true;
      },'continued write finality');
      assert.deepEqual(abi,original);
      console.log('canonical overload live acceptance',JSON.stringify({chainId:1337,algorithm,variant:variant.kind,entry,
        receipts,history,crashRecovery:true,offlineFollowerCatchup:true,continuedWrite:true,finalized:true},(_,value)=>typeof value==='bigint'?value.toString():value));
      passed=true;
    } catch(error) {
      throw new Error(`overload RPC regression failed; retained ${directory}`,{cause:error});
    } finally {
      signer.dispose();
      try {await stop('follower');} finally {await stop('validator');}
      if(passed)await rm(directory,{recursive:true});
    }
  });
  }
 }
}



test('read helper binds result decoding to the overload selected by argument count', async () => {
  const abi=parseAbi(['function lookup() returns (address)','function lookup(uint256 value) returns (uint256)']);
  for(const [args,value] of [[[],OVERLOAD_WORD],[[19n],OVERLOAD_AMOUNT]]) {
    const {provider,fetchMock}=makeProvider({callResult:OVERLOAD_WORD});
    await withFetchMock(fetchMock,async()=>assert.equal(await readContract({provider,
      address:CONTRACT,abi,functionName:'lookup',args}),value));
  }
});
