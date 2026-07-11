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

test('v0.25 Shell RPC wrappers call the matching node methods', async () => {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return rpc({ jsonrpc: '2.0', id: body.id, result: resultFor(body.method) });
  };

  const provider = createShellProvider({ rpcHttpUrl: 'https://rpc.devnet.shell.local' });
  const address = '0x' + '11'.repeat(32);
  const hash = '0x' + '22'.repeat(32);

  assert.equal(await provider.pendingCount(), '0x0');
  assert.deepEqual(await provider.getShellBlockByNumber(42, 'summary'), { number: '0x2a' });
  assert.deepEqual(await provider.getShellBlockByHash(hash, 'full'), { hash });
  assert.deepEqual(await provider.getValidators(), [address]);
  assert.deepEqual(await provider.getValidatorStatus(address), { address, isValidator: true });
  assert.deepEqual(await provider.getGovernanceInfo(), { validatorCount: 1, validators: [address], proposalGasLimit: 100000 });
  assert.equal(await provider.estimateGovernanceGas('addValidator'), '0x186a0');
  assert.equal(await provider.encodeAddValidator(address), '0xadd');
  assert.equal(await provider.encodeRemoveValidator(address), '0xremove');
  assert.equal(await provider.encodeSetValidatorStake(address, 1000n), '0xstake');
  assert.equal(await provider.proposeAddValidator(address), hash);
  assert.equal(await provider.proposeRemoveValidator(address), hash);
  assert.equal(await provider.proposeSetValidatorWeight(address, 7), hash);
  assert.equal(await provider.proposeSetValidatorStake(address, 2000n), hash);
  assert.deepEqual(await provider.getNetworkStats(), { peerCount: 2, listeningAddress: '/ip4/127.0.0.1/tcp/30303' });
  assert.deepEqual(await provider.getChainStats(), { blockHeight: 42, totalTransactions: 3, avgBlockTime: 2.5, gasUsedTotal: '0x5208', latestBaseFee: '0x3b9aca00' });
  assert.deepEqual(await provider.getFinalityInfo(), { lastFinalizedBlock: '0x28', lastFinalizedHash: hash, currentHead: '0x2a', finalityLag: 2, pendingAttestations: 0 });
  assert.deepEqual(await provider.getFinalityProof(hash), { blockHash: hash, certificate: null });
  assert.deepEqual(await provider.consensusInfo(), { engine: 'wpoa', validators: [{ address, weight: 1 }] });
  assert.equal(await provider.transactionCount(), '0x3');
  assert.deepEqual(await provider.getBlockWitnesses('latest'), { blockHash: hash, witnessRoot: null, witnessCount: 0, witnesses: [] });
  assert.deepEqual(await provider.getProofAmendment(hash), { block_hash: hash, proof: null });
  assert.deepEqual(await provider.getAlgorithmRegistry(), [{ algo: 'MlDsa65', status: 'active', description: 'ML-DSA-65' }]);
  assert.equal(await provider.setBalance(address, 1000n), true);

  assert.deepEqual(calls.map((call) => [call.method, call.params]), [
    ['shell_pendingCount', []],
    ['shell_getBlockByNumber', ['0x2a', 'summary']],
    ['shell_getBlockByHash', [hash, 'full']],
    ['shell_getValidators', []],
    ['shell_getValidatorStatus', [address]],
    ['shell_getGovernanceInfo', []],
    ['shell_estimateGovernanceGas', ['addValidator']],
    ['shell_encodeAddValidator', [address]],
    ['shell_encodeRemoveValidator', [address]],
    ['shell_encodeSetValidatorStake', [address, '0x3e8']],
    ['shell_proposeAddValidator', [address]],
    ['shell_proposeRemoveValidator', [address]],
    ['shell_proposeSetValidatorWeight', [address, 7]],
    ['shell_proposeSetValidatorStake', [address, '0x7d0']],
    ['shell_getNetworkStats', []],
    ['shell_getChainStats', []],
    ['shell_getFinalityInfo', []],
    ['shell_finalityProof', [hash]],
    ['shell_consensusInfo', []],
    ['shell_transactionCount', []],
    ['shell_getBlockWitnesses', ['latest']],
    ['shell_getProofAmendment', [hash]],
    ['shell_getAlgorithmRegistry', []],
    ['shell_setBalance', [address, '0x3e8']],
  ]);
});

test('block number parameters accept finality tags supported by shell-chain RPC', async () => {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return rpc({ jsonrpc: '2.0', id: body.id, result: resultFor(body.method) });
  };

  const provider = createShellProvider({ rpcHttpUrl: 'https://rpc.devnet.shell.local' });

  assert.deepEqual(await provider.getShellBlockByNumber('safe', 'summary'), { number: '0x2a' });
  assert.deepEqual(await provider.getBlocksRange('finalized'), {
    start: 'finalized',
    direction: 'desc',
    limit: 0,
    blocks: [],
    nextStart: null,
  });

  assert.deepEqual(calls.map((call) => [call.method, call.params]), [
    ['shell_getBlockByNumber', ['safe', 'summary']],
    ['shell_getBlocksRange', ['finalized', { direction: 'desc', limit: null, txDetail: 'summary', txLimit: null }]],
  ]);
});

test('v0.25 mutating RPC wrappers validate inputs before sending', async () => {
  globalThis.fetch = async () => {
    throw new Error('fetch should not be called for invalid wrapper inputs');
  };

  const provider = createShellProvider({ rpcHttpUrl: 'https://rpc.devnet.shell.local' });
  const address = '0x' + '11'.repeat(32);

  await assert.rejects(
    () => provider.proposeSetValidatorWeight(address, Number.MAX_SAFE_INTEGER + 1),
    /weight must be a non-negative safe integer/,
  );
  await assert.rejects(
    () => provider.proposeSetValidatorWeight(address, -1),
    /weight must be a non-negative safe integer/,
  );
  await assert.rejects(
    () => provider.proposeSetValidatorStake(address, -1),
    /stake must be a non-negative safe integer/,
  );
  await assert.rejects(
    () => provider.encodeSetValidatorStake(address, '1000'),
    /stake must be a canonical 0x-prefixed JSON-RPC quantity/,
  );
  await assert.rejects(
    () => provider.setBalance(address, '1000'),
    /balance must be a canonical 0x-prefixed JSON-RPC quantity/,
  );
  await assert.rejects(
    () => provider.setBalance('0x1234', 1n),
    /address must be null or a valid Shell address/,
  );
  await assert.rejects(
    () => provider.getShellBlockByNumber(-1, 'summary'),
    /number must be a non-negative safe integer/,
  );
  await assert.rejects(
    () => provider.getBlocksRange('0x01', { direction: 'desc' }),
    /start must be a block tag or canonical 0x-prefixed JSON-RPC quantity/,
  );
  await assert.rejects(
    () => provider.getAddressSummary('0x1234'),
    /address must be null or a valid Shell address/,
  );
  await assert.rejects(
    () => provider.getShellBlockByHash('0x1234', 'summary'),
    /hash must be a valid 32-byte hash/,
  );
  await assert.rejects(
    () => provider.getTransactionSummary('0x1234'),
    /txHash must be a valid 32-byte hash/,
  );
  await assert.rejects(
    () => provider.getFinalityProof('0x1234'),
    /blockHash must be a valid 32-byte hash/,
  );
  await assert.rejects(
    () => provider.getProofAmendment('0x1234'),
    /blockHash must be a valid 32-byte hash/,
  );
});

function resultFor(method) {
  const address = '0x' + '11'.repeat(32);
  const hash = '0x' + '22'.repeat(32);
  switch (method) {
    case 'shell_pendingCount':
      return '0x0';
    case 'shell_getBlockByNumber':
      return { number: '0x2a' };
    case 'shell_getBlocksRange':
      return { start: 'finalized', direction: 'desc', limit: 0, blocks: [], nextStart: null };
    case 'shell_getBlockByHash':
      return { hash };
    case 'shell_getValidators':
      return [address];
    case 'shell_getValidatorStatus':
      return { address, isValidator: true };
    case 'shell_getGovernanceInfo':
      return { validatorCount: 1, validators: [address], proposalGasLimit: 100000 };
    case 'shell_estimateGovernanceGas':
      return '0x186a0';
    case 'shell_encodeAddValidator':
      return '0xadd';
    case 'shell_encodeRemoveValidator':
      return '0xremove';
    case 'shell_encodeSetValidatorStake':
      return '0xstake';
    case 'shell_proposeAddValidator':
    case 'shell_proposeRemoveValidator':
    case 'shell_proposeSetValidatorWeight':
    case 'shell_proposeSetValidatorStake':
      return hash;
    case 'shell_getNetworkStats':
      return { peerCount: 2, listeningAddress: '/ip4/127.0.0.1/tcp/30303' };
    case 'shell_getChainStats':
      return { blockHeight: 42, totalTransactions: 3, avgBlockTime: 2.5, gasUsedTotal: '0x5208', latestBaseFee: '0x3b9aca00' };
    case 'shell_getFinalityInfo':
      return { lastFinalizedBlock: '0x28', lastFinalizedHash: hash, currentHead: '0x2a', finalityLag: 2, pendingAttestations: 0 };
    case 'shell_finalityProof':
      return { blockHash: hash, certificate: null };
    case 'shell_consensusInfo':
      return { engine: 'wpoa', validators: [{ address, weight: 1 }] };
    case 'shell_transactionCount':
      return '0x3';
    case 'shell_getBlockWitnesses':
      return { blockHash: hash, witnessRoot: null, witnessCount: 0, witnesses: [] };
    case 'shell_getProofAmendment':
      return { block_hash: hash, proof: null };
    case 'shell_getAlgorithmRegistry':
      return [{ algo: 'MlDsa65', status: 'active', description: 'ML-DSA-65' }];
    case 'shell_setBalance':
      return true;
    default:
      throw new Error(`unexpected method ${method}`);
  }
}

function rpc(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
