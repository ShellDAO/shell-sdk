import assert from 'node:assert/strict';
import test from 'node:test';
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


test('canonical overload real RPC: original full ABI read and signed write admission',
  {skip:!process.env.SHELL_NODE_BIN}, async () => {
    const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
    const {openSync,closeSync}=await import('node:fs');
    const {tmpdir}=await import('node:os');
    const {join}=await import('node:path');
    const {spawn,spawnSync}=await import('node:child_process');
    const {createServer,createConnection}=await import('node:net');
    const {once}=await import('node:events');
    const {MlDsa65Adapter}=await import('../dist/adapters.js');
    const {ShellSigner}=await import('../dist/signer.js');
    const binary=process.env.SHELL_NODE_BIN;
    const directory=await mkdtemp(join(tmpdir(),'shell-sdk-overload-'));
    const signer=new ShellSigner('MlDsa65',MlDsa65Adapter.generate());
    const contract='0x'+'99'.repeat(32);
    let child,exit,log,passed=false;
    try {
      const content=`pragma solidity ^0.8.35;
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
      const artifact=await compileSolidity({sources:[{path:'StatefulOverloads.sol',content}],
        contractName:'StatefulOverloads',target:'pqvm',evmVersion:'shanghai'});
      const genesis={chain_id:1337,timestamp:0,network_type:'Dev',fee_accounting_activation_height:0,
        consensus:{engine:'poa',authorities:[signer.getAddress()],authority_pubkeys:[Buffer.from(signer.getPublicKey()).toString('hex')],block_time_secs:600},
        alloc:{[signer.getAddress()]:{balance:'0x8ac7230489e80000'},
          [contract]:{balance:'0x0',code:artifact.deployedBytecode.slice(2)}}};
      const genesisPath=join(directory,'input-genesis.json');
      await writeFile(genesisPath,JSON.stringify(genesis));
      const init=spawnSync(binary,['--datadir',directory,'init','--genesis',genesisPath,'--network','dev','--chain-id','1337'],{encoding:'utf8',timeout:30000});
      assert.equal(init.status,0,init.stderr||init.stdout);
      const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
      const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
      const config=join(directory,'observer.toml');await writeFile(config,'[metrics]\nenabled = false\n');
      log=openSync(join(directory,'cli.log'),'w');
      child=spawn(binary,['--datadir',directory,'run','--network','dev','--chain-id','1337',
        '--block-time','600000','--db','rocksdb','--consensus-engine','poa',
        '--storage-profile','archive','--rpc-addr',`127.0.0.1:${port}`,'--config',config],{stdio:['ignore',log,log]});
      exit=once(child,'exit');
      const deadline=Date.now()+15000;
      while(true) {
        const ready=await new Promise(resolve=>{const socket=createConnection({host:'127.0.0.1',port});
          socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>{socket.destroy();resolve(false);});});
        if(ready)break;
        assert.equal(child.exitCode,null,'node exited during startup');assert.ok(Date.now()<deadline,'node RPC startup timeout');
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      const provider=createShellProvider({rpcHttpUrl:`http://127.0.0.1:${port}`});
      assert.equal(await provider.client.request({method:'eth_chainId',params:[]}), '0x539');
      const abi=artifact.abi,original=structuredClone(abi);
      for(const [functionName,argument,selector,expected] of OVERLOAD_CASES) {
        assert.equal(await readContract({provider,address:contract,abi,functionName,args:[argument]}),expected);
        const encoded=encodeFunctionData({abi,functionName,args:[argument]});
        assert.equal(encoded,selector+OVERLOAD_WORD.slice(2));
      }
      for(const slot of [0,1,2]) {
        assert.equal(await provider.client.request({method:'eth_getStorageAt',params:[contract,'0x'+slot.toString(16),'latest']}),'0x'+'00'.repeat(32));
      }
      // Real root signatures and RPC admission; no receipt or mined-state claim here.
      for(const [nonce,[functionName,argument]] of OVERLOAD_CASES.entries()) {
        const result=await writeContract({provider,signer,chainId:1337,nonce,address:contract,
          abi,functionName,args:[argument],includePublicKey:true,wait:false,gasLimit:500000,
          maxFeePerGas:1000000000,maxPriorityFeePerGas:0});
        assert.match(result.hash,/^0x[0-9a-f]{64}$/);
      }
      assert.equal(await provider.client.request({method:'eth_getTransactionCount',params:[signer.getAddress(),'pending']}),'0x2');
      assert.deepEqual(abi,original);passed=true;
    } catch(error) {
      throw new Error(`overload RPC regression failed; retained ${directory}`,{cause:error});
    } finally {
      signer.dispose();
      if(child) {
        if(child.exitCode===null && child.signalCode===null)child.kill('SIGTERM');
        const timer=setTimeout(()=>{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');},5000);timer.unref();
        try {await exit;} finally {clearTimeout(timer);}
      }
      if(log!==undefined)closeSync(log);
      if(passed)await rm(directory,{recursive:true});
    }
  });


test('read helper binds result decoding to the overload selected by argument count', async () => {
  const abi=parseAbi(['function lookup() returns (address)','function lookup(uint256 value) returns (uint256)']);
  for(const [args,value] of [[[],OVERLOAD_WORD],[[19n],OVERLOAD_AMOUNT]]) {
    const {provider,fetchMock}=makeProvider({callResult:OVERLOAD_WORD});
    await withFetchMock(fetchMock,async()=>assert.equal(await readContract({provider,
      address:CONTRACT,abi,functionName:'lookup',args}),value));
  }
});
