import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { blake3 } from '@noble/hashes/blake3.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(repo, 'dist/index.js');
const tsc = join(repo, 'node_modules/typescript/bin/tsc');
const compilerArgs = ['--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext'];

test('finality certificate values expose exported PQ signature types', async () => {
  const readme = await readFile(join(repo, 'README.md'), 'utf8');
  const example = readme.split('### Read a finality certificate\n')[1].split('```typescript\n')[1].split('```')[0];
  assert.equal((await readFile(join(repo, 'tests/types/finality-proof.mts'), 'utf8')).trim(), example.trim());
  const result = spawnSync(process.execPath, [tsc, ...compilerArgs, '--noEmit', join(repo, 'tests/types/finality-proof.mts')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('getFinalityProof preserves non-null PQ signatures and missing certificates', async () => {
  const { createShellProvider } = await import(pathToFileURL(entry));
  const original = globalThis.fetch;
  const hash = '0x' + '12'.repeat(32);
  const address = '0x' + '34'.repeat(32);
  const certificate = { [address]: { sig_type: 'MlDsa65', data: [0, 128, 255] } };
  let present = true;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(request.method, 'shell_finalityProof');
    assert.deepEqual(request.params, [hash]);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      result: { blockHash: hash, certificate: present ? certificate : null } }),
    { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const provider = createShellProvider({ rpcHttpUrl: 'http://127.0.0.1:8545' });
    assert.deepEqual(await provider.getFinalityProof(hash), { blockHash: hash, certificate });
    present = false;
    assert.deepEqual(await provider.getFinalityProof(hash), { blockHash: hash, certificate: null });
  } finally {
    globalThis.fetch = original;
  }
});

// Manual: SHELL_NODE_BIN=/path/to/shell-node node --test tests/finality-proof.test.mjs
// Requires a compatible RocksDB/libp2p node. Creates fresh dev keys and funds;
// retains private node data, original certificate and receipts for inspection.
test('native finalized certificate is typed, verifiable and persistent',
  { skip: !process.env.SHELL_NODE_BIN, timeout: 90000 }, async () => {
    const binary = resolve(process.env.SHELL_NODE_BIN);
    const out = await mkdtemp(join(tmpdir(), 'shell-sdk-finality-'));
    const data = join(out, 'node');
    const password = join(out, 'password');
    const key = join(out, 'key.json');
    const result = { directory: out, commands: [], starts: [], startedAt: new Date().toISOString() };
    const save = () => writeFile(join(out, 'results.json'), JSON.stringify(result, null, 2));
    let processHandle, closeComplete;
    const run = async (label, args) => {
      const command = [binary, ...args];
      const completed = spawnSync(command[0], command.slice(1), { encoding: 'utf8', timeout: 30000 });
      await writeFile(join(out, label + '.log'), completed.stdout + completed.stderr);
      result.commands.push({ command, exitCode: completed.status });
      await save();
      assert.equal(completed.status, 0, completed.stderr);
      return completed.stdout;
    };
    const port = await new Promise((accept, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const selected = server.address().port;
        server.close(() => accept(selected));
      });
    });
    const url = `http://127.0.0.1:${port}`;
    const rpc = async (method, params = []) => {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const value = await response.json();
      assert.equal(value.error, undefined, JSON.stringify(value));
      return value.result;
    };
    const wait = async (check) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        assert.equal(processHandle.exitCode, null, 'Node exited before acceptance');
        try { const value = await check(); if (value) return value; } catch (error) {
          if (!(error instanceof TypeError)) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Timed out waiting for local node');
    };
    const start = async () => {
      const args = ['run', '--datadir', data, '--keystore', key, '--password-file', password,
        '--rpc-addr', `127.0.0.1:${port}`, '--metrics-addr', '127.0.0.1:0', '--p2p',
        '--p2p-addr', '127.0.0.1:0', '--network', 'dev', '--chain-id', '1337',
        '--consensus-engine', 'wpoa', '--node-role', 'validator', '--db', 'rocksdb',
        '--storage-profile', 'full', '--block-time', '2000', '--max-idle-interval', '1209600000'];
      const log = join(out, `node-${result.starts.length}.log`);
      processHandle = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '';
      processHandle.stdout.on('data', chunk => { text += chunk; });
      processHandle.stderr.on('data', chunk => { text += chunk; });
      const row = { pid: processHandle.pid, command: [binary, ...args], log };
      result.starts.push(row);
      closeComplete = new Promise((accept, reject) => processHandle.once('close', async code => {
        try {
          row.exitCode = code;
          row.stoppedAt = new Date().toISOString();
          await writeFile(log, text);
          await save();
          accept(code);
        } catch (error) { reject(error); }
      }));
      await wait(() => rpc('shell_getNodeInfo'));
      return row;
    };
    const stop = async () => {
      if (!processHandle) return;
      const processToStop = processHandle;
      if (processToStop.exitCode === null) processToStop.kill('SIGTERM');
      const timer = setTimeout(() => processToStop.kill('SIGKILL'), 15000);
      const code = await closeComplete;
      clearTimeout(timer);
      assert.equal(code, 0);
    };
    try {
      await writeFile(password, randomBytes(24).toString('hex'), { mode: 0o600 });
      await run('key', ['key', 'generate', '--algorithm', 'mldsa65', '--output', key, '--password-file', password]);
      const keystore = JSON.parse(await readFile(key, 'utf8'));
      const publicKey = Buffer.from(keystore.public_key.replace(/^0x/, ''), 'hex');
      const address = '0x' + Buffer.from(blake3(Buffer.concat([Buffer.from([1]), publicKey]))).toString('hex');
      assert.equal(address, keystore.address);
      const recipient = '0x' + randomBytes(32).toString('hex');
      await mkdir(data);
      await writeFile(join(data, 'genesis.json'), JSON.stringify({ chain_id: 1337, chain_name: 'sdk-finality',
        network_type: 'Dev', timestamp: Math.floor(Date.now() / 1000) - 120, gas_limit: 30000000,
        extra_data: 'sdk-finality', boot_nodes: [], alloc: { [address]: { balance: '0x3635c9adc5dea00000' } },
        consensus: { engine: 'wpoa', authorities: [address], authority_pubkeys: ['0x' + publicKey.toString('hex')],
          weights: [1], block_time_secs: 2, max_future_secs: 300, epoch_length: 0 } }));
      await start();
      assert.equal(await rpc('eth_chainId'), '0x539');
      const genesis = await rpc('eth_getBlockByNumber', ['0x0', false]);
      const nonce = await rpc('eth_getTransactionCount', [address, 'latest']);
      assert.equal(nonce, '0x0');
      const { createShellProvider } = await import(pathToFileURL(entry));
      const provider = createShellProvider({ rpcHttpUrl: url });
      assert.deepEqual(await provider.getFinalityProof(genesis.hash), { blockHash: genesis.hash, certificate: null });
      const sent = await run('transfer', ['tx', 'send', '--keystore', key, '--password-file', password,
        '--to', recipient, '--value', '1', '--chain-id', '1337', '--rpc-url', url]);
      const hash = sent.match(/0x[0-9a-f]{64}/g).at(-1);
      const receipt = await wait(async () => {
        const receipt = await rpc('eth_getTransactionReceipt', [hash]);
        return receipt && BigInt((await rpc('shell_getFinalityInfo')).lastFinalizedBlock) >= BigInt(receipt.blockNumber) ? receipt : null;
      });
      assert.equal(receipt.status, '0x1');
      const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
      const before = { block, nonce: await rpc('eth_getTransactionCount', [address, 'latest']),
        balance: await rpc('eth_getBalance', [recipient, 'latest']) };
      assert.equal(before.nonce, '0x1');
      assert.equal(before.balance, '0x1');
      const proof = await provider.getFinalityProof(block.hash);
      assert.equal(proof.blockHash, block.hash);
      assert.deepEqual(Object.keys(proof.certificate), [address]);
      assert.equal(proof.certificate[address].sig_type, 'MlDsa65');
      const signature = Uint8Array.from(proof.certificate[address].data);
      const message = Buffer.from(block.hash.slice(2), 'hex');
      assert.equal(ml_dsa65.verify(signature, message, publicKey), true);
      const tampered = Buffer.from(message); tampered[0] ^= 1;
      assert.equal(ml_dsa65.verify(signature, tampered, publicKey), false);
      const typedSource = `import {createShellProvider, type ShellSignature} from ${JSON.stringify(entry)};
export async function read(url: string, hash: string): Promise<Record<string, ShellSignature> | null> {
  return (await createShellProvider({rpcHttpUrl: url}).getFinalityProof(hash)).certificate;
}\n`;
      const input = join(out, 'consumer.mts');
      const output = join(out, 'consumer.mjs');
      await writeFile(input, typedSource);
      const compiled = spawnSync(process.execPath, [tsc, ...compilerArgs, input], { encoding: 'utf8' });
      assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
      result.typedConsumerSha256 = createHash('sha256').update(await readFile(output)).digest('hex');
      const { read } = await import(pathToFileURL(output));
      assert.deepEqual(await read(url, block.hash), proof.certificate);
      if (process.env.BASELINE_SDK_ENTRY) {
        const original = await import(pathToFileURL(resolve(process.env.BASELINE_SDK_ENTRY)));
        assert.deepEqual(await original.createShellProvider({ rpcHttpUrl: url }).getFinalityProof(block.hash), proof);
        result.originalPublicRuntimeMatches = true;
      }
      assert.deepEqual(await rpc('eth_getBlockByNumber', ['latest', false]), before.block);
      assert.equal(await rpc('eth_getBalance', [recipient, 'latest']), before.balance);
      assert.equal(await rpc('eth_getTransactionCount', [address, 'latest']), before.nonce);
      result.observed = { address, publicKey: publicKey.toString('hex'), recipient, hash, receipt, proof, before,
        independentSignatureValid: true, tamperedHashRejected: true };
      await stop();
      await start();
      assert.deepEqual(await read(url, block.hash), proof.certificate);
      assert.deepEqual(await provider.getFinalityProof(genesis.hash), { blockHash: genesis.hash, certificate: null });
      assert.deepEqual(await rpc('eth_getBlockByNumber', ['latest', false]), before.block);
      assert.equal(await rpc('eth_getBalance', [recipient, 'latest']), before.balance);
      assert.equal(await rpc('eth_getTransactionCount', [address, 'latest']), before.nonce);
      assert.deepEqual(await rpc('eth_getTransactionReceipt', [hash]), receipt);
      await rm(output); // Exact, owned, reconstructible TypeScript output only.
      result.typedOutputRemoved = true;
      result.passed = true;
    } catch (error) {
      result.failure = String(error);
      throw error;
    } finally {
      await stop();
      result.finishedAt = new Date().toISOString();
      await save();
      console.log(JSON.stringify({ finalityAcceptance: result.passed ?? false, directory: out }));
    }
  });
