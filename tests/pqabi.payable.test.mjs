import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { toFunctionSelector } from 'viem';
import { compileSolidity } from '../dist/contracts-compiler.js';
import { encodeFunctionData } from '../dist/contracts.js';
import { ShellSigner, MlDsa65Adapter, decryptKeystore, buildTransaction, createShellProvider,
  buildInnerCall, buildBatchTransaction } from '../dist/index.js';

const source = `pragma solidity ^0.8.30;
interface IPay { function pay(address owner) external payable returns(address); }
contract Payee {
 error Denied(address owner);
 uint256 public count;
 address public seen;
 function pay(address owner) external payable returns(address) {
  count++; seen=owner; if (owner==address(0)) revert Denied(owner); return owner;
 }
}
contract Reader {
 uint256 public count;
 address public last;
 function invoke(address target,address owner,uint256 amount) external payable returns(address) {
  count++; last=IPay(target).pay{value:amount}(owner); return last;
 }
 function plain(address target,address owner) external returns(address) {
  count++; last=IPay(target).pay(owner); return last;
 }
 function reject(address target,address owner,uint256 amount) external payable {
  count++; last=IPay(target).pay{value:amount}(owner); require(false);
 }
}`;

// Run after npm run build with SHELL_NODE_BIN pointing to a compatible node.
// Isolated genesis allocation avoids making a native CREATE derivation claim.
test('typed payable calls: signed value, rollback, import, history and disk reopen',
  { skip: !process.env.SHELL_NODE_BIN, timeout: 240000 }, async () => {
  const binary = process.env.SHELL_NODE_BIN;
  const directory = await mkdtemp(join(tmpdir(), 'shell-sdk-payable-'));
  const password = randomBytes(24).toString('hex');
  const passwordFile = join(directory, 'password.txt');
  const keyFile = join(directory, 'validator.json');
  await writeFile(passwordFile, password, { mode: 0o600 });
  for (const file of [keyFile, join(directory, 'observer.json')]) {
    const key = spawnSync(binary, ['--password-file', passwordFile, 'key', 'generate',
      '--algorithm', 'mldsa65', '--output', file], { encoding: 'utf8' });
    assert.equal(key.status, 0, key.stderr);
  }
  const miner = await decryptKeystore(JSON.parse(await readFile(keyFile, 'utf8')), password);
  const payer = new ShellSigner('MlDsa65', MlDsa65Adapter.generate());
  const word = value => BigInt(value).toString(16).padStart(64, '0');
  const address = byte => '0x' + byte.repeat(32);
  const reader = address('11'), payee = address('22');
  const alias = '0x' + '33'.repeat(12) + '22'.repeat(20);
  const short = address('44'), missing = address('55');
  const owner = address('aa'), other = '0x' + 'bb'.repeat(12) + 'aa'.repeat(20);
  const zero = '0x' + word(0);
  const artifacts = {};
  for (const contractName of ['Reader', 'Payee']) {
    const options = { sources: [{ path: 'Payable.sol', content: source }], contractName, evmVersion: 'shanghai' };
    const original = await compileSolidity(options);
    artifacts[contractName] = await compileSolidity({ ...options, target: 'pqvm', nativeAddressContextHeight: 0 });
    assert.deepEqual(artifacts[contractName].abi, original.abi);
  }
  const ports = [];
  for (let i = 0; i < 2; i++) {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    ports.push(server.address().port);
    await new Promise(resolve => server.close(resolve));
  }
  assert.notEqual(...ports);
  const report = { directory, binarySha256: createHash('sha256').update(await readFile(binary)).digest('hex'),
    artifacts, source, opens: [], transactions: [], adaptations: [
      'Source compiler; isolated Dev chain 1337, native context and fee accounting at genesis.',
      'Fresh ML-DSA keys; full RocksDB producer and independent non-authority observer.',
      'Runtime allocation is not native CREATE or public tutorial deployment acceptance.' ] };
  const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const provider = createShellProvider({ rpcHttpUrl: `http://127.0.0.1:${ports[0]}` });
  const nodes = [], dirs = [join(directory, 'leader'), join(directory, 'observer')];
  async function rpc(i, method, params = []) {
    await pause(100);
    const response = await fetch(`http://127.0.0.1:${ports[i]}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}: ${await response.text()}`);
    const body = await response.json();
    if (body.error) throw Object.assign(new Error(JSON.stringify(body.error)), { rpcError: body.error });
    return body.result;
  }
  async function stop(i) {
    const child = nodes[i]; if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000); timer.unref();
      try { await closed; } finally { clearTimeout(timer); }
    }
    const opened = report.opens.findLast(x => x.pid === child.pid);
    opened.exitCode = child.exitCode; opened.signal = child.signalCode;
    nodes[i] = undefined;
    assert.equal(child.exitCode, 0);
  }
  async function start(i, bootnode) {
    const label = `${i}-${report.opens.length}`;
    const args = ['run', '--datadir', dirs[i], '--keystore', i ? join(directory, 'observer.json') : keyFile,
      '--password-file', passwordFile, '--rpc-addr', `127.0.0.1:${ports[i]}`, '--metrics-addr', '127.0.0.1:0',
      '--block-time', '2000', '--max-idle-interval', '1209600000', '--network', 'dev',
      '--consensus-engine', 'wpoa', '--chain-id', '1337', '--db', 'rocksdb', '--storage-profile', 'full',
      '--rpc-api', 'eth,net,web3,shell,debug,trace', '--p2p', '--p2p-addr', '127.0.0.1:0', '--log-level', 'info'];
    if (bootnode) args.push('--bootnode', bootnode);
    const log = join(directory, label + '.log');
    const fd = openSync(log, 'w');
    const child = spawn(binary, args, { stdio: ['ignore', fd, fd] }); closeSync(fd);
    nodes[i] = child; report.opens.push({ pid: child.pid, args, log }); await save();
    for (let attempt = 0; attempt < 160; attempt++) {
      assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
      try { if (await rpc(i, 'eth_chainId') === '0x539') return log; } catch {}
      await pause(100);
    }
    throw new Error('node startup timeout');
  }
  async function peer(log) {
    for (let attempt = 0; attempt < 160; attempt++) {
      const match = (await readFile(log, 'utf8')).match(/Listening on (\/ip4\/127\.0\.0\.1\/tcp\/\d+\/p2p\/[a-zA-Z0-9]+)/);
      if (match) return match[1]; await pause(100);
    }
    throw new Error('peer address timeout');
  }
  const request = (target, beneficiary, amount, fn = 'invoke') => {
    const data = encodeFunctionData({ abi: artifacts.Reader.abi, functionName: fn,
      args: fn === 'plain' ? [target, beneficiary] : [target, beneficiary, amount] });
    const signature = `${fn}(address,address${fn === 'plain' ? '' : ',uint256'})`;
    assert.equal(data, toFunctionSelector(signature) + word(target) + word(beneficiary) + (fn === 'plain' ? '' : word(amount)));
    return { from: payer.getAddress(), to: reader, gas: '0x927c0', data };
  };
  const state = async (i, tag = 'latest') => {
    const accounts = {};
    for (const target of [reader, payee, alias, short, missing, payer.getAddress(), miner.getAddress()]) {
      accounts[target] = { balance: await rpc(i, 'eth_getBalance', [target, tag]),
        nonce: await rpc(i, 'eth_getTransactionCount', [target, tag]), slots: [] };
      for (const slot of ['0x0', '0x1']) accounts[target].slots.push(await rpc(i, 'eth_getStorageAt', [target, slot, tag]));
    }
    return accounts;
  };
  let nonce = 0;
  async function send(label, calls, value, success, aa = false) {
    const before = await state(0);
    const built = aa ? buildBatchTransaction({ chainId: 1337, nonce, gasLimit: 1200000,
      innerCalls: calls.map(call => buildInnerCall(reader, call.data, 500000, 0n)) }) : null;
    const tx = built?.tx ?? buildTransaction({ chainId: 1337, nonce, to: reader,
      data: calls[0].data, value, gasLimit: 600000 });
    const signed = await payer.buildSignedTransaction({ tx, ...(built ? { aaBundle: built.aa_bundle } : {}), includePublicKey: true });
    const hash = await provider.sendTransaction(signed);
    const entry = { label, hash, aa, before }; report.transactions.push(entry); await save();
    for (let attempt = 0; attempt < 160; attempt++) {
      entry.receipt = await rpc(0, 'eth_getTransactionReceipt', [hash]);
      if (entry.receipt) break; await pause(100);
    }
    assert.equal(entry.receipt?.status, success ? '0x1' : '0x0', label);
    nonce++; entry.after = await state(0);
    entry.trace = await rpc(0, 'debug_traceTransaction', [hash, { tracer: 'callTracer' }]);
    const fee = BigInt(entry.receipt.gasUsed) * BigInt(entry.receipt.effectiveGasPrice);
    assert.equal(BigInt(before[payer.getAddress()].balance) - BigInt(entry.after[payer.getAddress()].balance), fee + (success ? value : 0n));
    assert.equal(BigInt(entry.after[miner.getAddress()].balance) - BigInt(before[miner.getAddress()].balance), fee);
    assert.equal(BigInt(entry.after[payer.getAddress()].nonce), BigInt(nonce));
    if (!success) for (const target of [reader, payee, alias, short, missing]) assert.deepEqual(entry.after[target], before[target]);
    for (let attempt = 0; attempt < 160; attempt++) {
      const block = await rpc(1, 'eth_getBlockByNumber', [entry.receipt.blockNumber, false]);
      if (block?.hash === entry.receipt.blockHash) break; await pause(100);
    }
    assert.equal((await rpc(1, 'eth_getBlockByNumber', [entry.receipt.blockNumber, false])).hash, entry.receipt.blockHash);
    assert.deepEqual(await rpc(1, 'eth_getTransactionReceipt', [hash]), entry.receipt);
    assert.deepEqual(await state(1), entry.after); await save(); return entry;
  }
  try {
    const genesis = { chain_id: 1337, network_type: 'Dev', timestamp: Math.floor(Date.now() / 1000) - 120,
      gas_limit: 30000000, registered_key_algorithm_height: 0, native_address_context_height: 0,
      fee_accounting_activation_height: 0, aa_account_manager_height: 0,
      consensus: { engine: 'wpoa', authorities: [miner.getAddress()],
        authority_pubkeys: ['0x' + Buffer.from(miner.getPublicKey()).toString('hex')], weights: [1],
        stakes: [], block_time_secs: 2, max_future_secs: 300, epoch_length: 0 }, alloc: {} };
    for (const account of [miner.getAddress(), payer.getAddress()]) genesis.alloc[account] = { balance: '0x3635c9adc5dea00000', nonce: 0 };
    for (const [account, code] of [[reader, artifacts.Reader.deployedBytecode], [payee, artifacts.Payee.deployedBytecode],
      [alias, artifacts.Payee.deployedBytecode], [short, '0x60635f55601f5ff3']]) {
      genesis.alloc[account] = { balance: '0x0', nonce: 1, code, storage: {} };
    }
    for (const dir of dirs) { await mkdir(dir); await writeFile(join(dir, 'genesis.json'), JSON.stringify(genesis)); }
    await start(1, await peer(await start(0)));
    const first = await send('pay full32 target', [request(payee, owner, 7n)], 9n, true);
    assert.equal(first.after[payee].balance, '0x7'); assert.equal(first.after[reader].balance, '0x2');
    assert.equal(first.after[alias].balance, '0x0'); assert.equal(first.after[payee].slots[1], owner);
    assert.equal(first.trace.output, owner); assert.equal(first.trace.calls[0].to.toLowerCase(), payee);
    assert.equal(first.trace.calls[0].input, toFunctionSelector('pay(address)') + owner.slice(2));
    assert.equal(BigInt(first.trace.calls[0].value), 7n);
    await send('plain call to same payable declaration', [request(payee, other, 0n, 'plain')], 0n, true);
    const second = await send('same-low20 alias transfer', [request(alias, other, 4n)], 5n, true);
    assert.equal(second.after[payee].balance, '0x7'); assert.equal(second.after[alias].balance, '0x4');
    assert.equal(second.after[alias].slots[1], other); assert.equal(second.after[reader].balance, '0x3');
    const denied = await send('callee rejection', [request(payee, zero, 2n)], 0n, false);
    assert.equal(denied.trace.output, toFunctionSelector('Denied(address)') + word(0));
    await send('insufficient caller funds', [request(payee, owner, 4n)], 0n, false);
    await send('short return restores value and callee storage', [request(short, owner, 2n)], 5n, false);
    await send('missing callee restores value', [request(missing, owner, 1n)], 0n, false);
    await send('outer rejection restores successful callee', [request(payee, owner, 1n, 'reject')], 3n, false);
    await send('AA second call reverts first value and storage', [request(payee, owner, 1n), request(alias, zero, 1n)], 0n, false, true);
    await send('AA successful payable call', [request(payee, owner, 1n)], 0n, true, true);
    const verify = async () => {
      for (const i of [0, 1]) {
        const before = await state(i), head = await rpc(i, 'eth_getBlockByNumber', ['latest', false]);
        assert.equal(before[payee].balance, '0x8'); assert.equal(before[alias].balance, '0x4');
        assert.equal(before[reader].balance, '0x2'); assert.equal(before[reader].slots[0], '0x' + word(4));
        assert.equal(before[payee].slots[0], '0x' + word(3)); assert.equal(before[alias].slots[0], '0x' + word(1));
        for (const entry of report.transactions) assert.deepEqual(await rpc(i, 'eth_getTransactionReceipt', [entry.hash]), entry.receipt);
        assert.deepEqual(await state(i, first.receipt.blockNumber), first.after);
        assert.equal(await rpc(i, 'eth_call', [request(payee, other, 1n), first.receipt.blockNumber]), other);
        assert.deepEqual(await rpc(i, 'debug_traceTransaction', [first.hash, { tracer: 'callTracer' }]), first.trace);
        assert.deepEqual(await state(i), before);
        assert.equal((await rpc(i, 'eth_getBlockByNumber', ['latest', false])).stateRoot, head.stateRoot);
        const final = await rpc(i, 'shell_getFinalityInfo'); assert.equal(BigInt(final.lastFinalizedBlock), BigInt(head.number));
      }
    };
    await verify(); await stop(1); await stop(0);
    await start(1, await peer(await start(0))); await verify(); report.passed = true;
  } catch (error) { report.error = String(error); throw error; }
  finally {
    try { await stop(1); await stop(0); }
    finally { miner.dispose(); payer.dispose(); await save(); console.log(`Payable acceptance report: ${join(directory, 'report.json')}`); }
  }
});
