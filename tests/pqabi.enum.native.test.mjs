import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { keccak256, toFunctionSelector } from 'viem';
import { compileSolidity } from '../dist/contracts-compiler.js';

// Opt-in integration test. The compiled runtime is installed in a fresh private
// genesis to isolate compiler semantics from native CREATE deployment policy.
test('PQABI enums preserve signed state, historical isolation and physical reopen',
  {skip: !process.env.SHELL_NODE_BIN, timeout: 240000}, async (t) => {
    const binary = resolve(process.env.SHELL_NODE_BIN);
    const directory = await mkdtemp(join(tmpdir(), 'shell-pqabi-enum-'));
    await chmod(directory, 0o700);
    const result = {directory, binary, startedAt: new Date().toISOString(), commands: [], opens: [], rpc: [], receipts: []};
    const save = () => writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2) + '\n');
    const pause = ms => new Promise(done => setTimeout(done, ms));
    let child, exited, row, url;
    const cli = (label, args) => {
      const before = new Date().toISOString();
      const value = spawnSync(binary, args.map(String), {encoding: 'utf8', timeout: 30000});
      const log = join(directory, label + '.log');
      closeSync(openSync(log, 'wx', 0o600));
      // Only private local logs may contain key-generation output.
      return {value, before, log, args: args.map(String)};
    };
    const command = async (label, args) => {
      const {value, before, log, args: recorded} = cli(label, args);
      await writeFile(log, (value.stdout ?? '') + (value.stderr ?? ''));
      result.commands.push({label, args: recorded, startedAt: before, finishedAt: new Date().toISOString(), exitCode: value.status});
      await save();
      assert.equal(value.status, 0, `${label}: ${value.stderr ?? value.error}`);
      return value.stdout;
    };
    const rpc = async (method, params = [], reject = false) => {
      await pause(40);
      const body = {jsonrpc: '2.0', id: 1, method, params};
      const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(5000)});
      assert.equal(response.status, 200);
      const value = await response.json();
      result.rpc.push({request: body, response: value});
      await save();
      if (reject) { assert.ok(value.error, 'expected execution rejection'); return value.error; }
      assert.equal(value.error, undefined, JSON.stringify(value.error));
      return value.result;
    };
    const start = async () => {
      const socket = createServer();
      await new Promise(done => socket.listen(0, '127.0.0.1', done));
      const port = socket.address().port;
      await new Promise(done => socket.close(done));
      url = `http://127.0.0.1:${port}`;
      const args = ['--password-file', join(directory, 'password'), 'run', '--datadir', join(directory, 'data'),
        '--keystore', join(directory, 'key.json'), '--network', 'dev', '--chain-id', '1337', '--db', 'rocksdb',
        '--rpc-addr', `127.0.0.1:${port}`, '--metrics-addr', '127.0.0.1:0', '--p2p', '--p2p-addr', '127.0.0.1:0',
        '--node-role', 'validator', '--consensus-engine', 'wpoa', '--block-time', '1000', '--max-idle-interval', '1209600000'];
      const fd = openSync(join(directory, `node-${result.opens.length}.log`), 'wx', 0o600);
      child = spawn(binary, args, {stdio: ['ignore', fd, fd]});
      closeSync(fd);
      exited = new Promise(done => child.once('exit', (code, signal) => done({code, signal})));
      row = {args, pid: child.pid, startedAt: new Date().toISOString()};
      result.opens.push(row);
      await save();
      for (let n = 0; n < 150; n++) {
        assert.equal(child.exitCode, null, 'node exited before RPC readiness');
        try { await rpc('eth_chainId'); return; } catch (error) { if (n === 149) throw error; }
        await pause(100);
      }
    };
    const stop = async () => {
      if (!child) return;
      if (child.exitCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      row.exit = await exited;
      clearTimeout(timer);
      row.finishedAt = new Date().toISOString();
      child = undefined;
      await save();
      assert.deepEqual(row.exit, {code: 0, signal: null});
    };
    const word = value => BigInt(value).toString(16).padStart(64, '0');
    const ownerA = '0x' + '34'.repeat(12) + 'ab'.repeat(20);
    const ownerB = '0x' + '56'.repeat(12) + 'ab'.repeat(20);
    const contract = '0x' + '57'.repeat(32);
    const input = (signature, args) => toFunctionSelector(signature) + args;
    const phase = (owner, block = 'latest') => rpc('eth_call', [{to: contract, data: input('phases(address)', owner.slice(2))}, block]);
    const storage = owner => rpc('eth_getStorageAt', [contract, keccak256(owner + word(0)), 'latest']);
    let signer;
    const send = async (label, data, status) => {
      const output = await command(label, ['--password-file', join(directory, 'password'), 'tx', 'send',
        '--keystore', join(directory, 'key.json'), '--to', contract, '--value', '0', '--data', data,
        '--gas-limit', '500000', '--chain-id', '1337', '--rpc-url', url]);
      const hash = output.match(/0x[0-9a-f]{64}/g).at(-1);
      let receipt;
      for (let n = 0; n < 150; n++) {
        receipt = await rpc('eth_getTransactionReceipt', [hash]);
        if (receipt && BigInt((await rpc('shell_getFinalityInfo')).lastFinalizedBlock) >= BigInt(receipt.blockNumber)) break;
        await pause(100);
      }
      assert.equal(receipt?.status, status, label);
      assert.ok(BigInt((await rpc('shell_getFinalityInfo')).lastFinalizedBlock) >= BigInt(receipt.blockNumber));
      result.receipts.push(receipt);
      assert.equal(BigInt(await rpc('eth_getTransactionCount', [signer, 'latest'])), BigInt(result.receipts.length));
      await save();
      return receipt;
    };
    try {
      const {randomBytes} = await import('node:crypto');
      await writeFile(join(directory, 'password'), randomBytes(24).toString('hex'), {mode: 0o600});
      await command('key', ['--password-file', join(directory, 'password'), 'key', 'generate', '--algorithm', 'mldsa65', '--output', join(directory, 'key.json')]);
      const key = JSON.parse(await readFile(join(directory, 'key.json'), 'utf8'));
      signer = key.address;
      const content = await readFile(new URL('./fixtures/PhaseBook.sol', import.meta.url), 'utf8');
      const artifact = await compileSolidity({sources: [{path: 'PhaseBook.sol', content}], contractName: 'PhaseBook', target: 'pqvm', evmVersion: 'cancun'});
      const genesis = {chain_id: 1337, chain_name: 'enum-acceptance', network_type: 'Dev', timestamp: Math.floor(Date.now() / 1000),
        gas_limit: 50000000, extra_data: 'enum-acceptance', boot_nodes: [],
        consensus: {engine: 'wpoa', authorities: [signer], authority_pubkeys: ['0x' + key.public_key.replace(/^0x/, '')], weights: [1], block_time_secs: 1, max_future_secs: 60, epoch_length: 100},
        alloc: {[signer]: {balance: '0x3635c9adc5dea00000'}, [contract]: {balance: '0x0', code: artifact.deployedBytecode}}};
      await writeFile(join(directory, 'genesis.json'), JSON.stringify(genesis));
      await command('init', ['--datadir', join(directory, 'data'), 'init', '--genesis', join(directory, 'genesis.json'), '--network', 'dev', '--chain-id', '1337']);
      await start();
      assert.equal(await rpc('eth_getCode', [contract, 'latest']), artifact.deployedBytecode);
      assert.equal(BigInt(await phase(ownerA)), 0n);
      assert.equal(BigInt(await phase(ownerB)), 0n);
      const first = await send('set-rejected', input('set(address,uint8)', ownerA.slice(2) + word(2)), '0x1');
      assert.equal(BigInt(await phase(ownerA)), 2n);
      assert.equal(BigInt(await phase(ownerB)), 0n);
      assert.equal(BigInt(await storage(ownerA)), 2n);
      await send('approve', input('approve(address)', ownerB.slice(2)), '0x1');
      assert.equal(BigInt(await phase(ownerA)), 2n);
      assert.equal(BigInt(await phase(ownerB)), 1n);
      assert.equal(BigInt(await storage(ownerB)), 1n);
      await send('reset-enum', input('set(address,uint8)', ownerA.slice(2) + word(0)), '0x1');
      const bad = input('set(address,uint8)', ownerA.slice(2) + word(255));
      await rpc('eth_call', [{from: signer, to: contract, data: bad}, 'latest'], true);
      await send('invalid-enum', bad, '0x0');
      assert.equal(BigInt(await phase(ownerA)), 0n);
      assert.equal(BigInt(await phase(ownerB)), 1n);
      const before = await rpc('eth_getBlockByNumber', ['latest', false]);
      assert.equal(BigInt(await phase(ownerA, first.blockNumber)), 2n);
      assert.equal(BigInt(await phase(ownerB, first.blockNumber)), 0n);
      assert.deepEqual(await rpc('eth_getBlockByNumber', ['latest', false]), before, 'history cannot change current state');
      await stop();
      await start();
      assert.deepEqual(await rpc('eth_getBlockByNumber', ['latest', false]), before);
      assert.equal(await rpc('eth_getCode', [contract, 'latest']), artifact.deployedBytecode);
      for (const receipt of result.receipts) assert.deepEqual(await rpc('eth_getTransactionReceipt', [receipt.transactionHash]), receipt);
      assert.equal(BigInt(await phase(ownerA)), 0n);
      assert.equal(BigInt(await phase(ownerB)), 1n);
      assert.equal(BigInt(await phase(ownerA, first.blockNumber)), 2n);
      await send('post-reopen-approve', input('approve(address)', ownerA.slice(2)), '0x1');
      assert.equal(BigInt(await phase(ownerA)), 1n);
      assert.equal(BigInt(await phase(ownerB)), 1n);
      result.passed = true;
    } catch (error) {
      result.failure = String(error.stack ?? error);
      throw error;
    } finally {
      await stop();
      result.finishedAt = new Date().toISOString();
      await save();
      t.diagnostic(JSON.stringify({directory, passed: result.passed ?? false}));
    }
  });
