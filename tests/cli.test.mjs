import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const CLI = path.resolve('dist', 'cli.js');

test('cli prints contract help', () => {
  const result = spawnSync(process.execPath, [CLI, 'contract', 'help'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /contract compile/);
  assert.match(result.stdout, /contract deploy/);
});

test('cli contract compile writes artifact', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'shell-sdk-cli-'));
  try {
    const out = path.join(tempDir, 'PqvmCounter.json');
    const result = spawnSync(process.execPath, [
      CLI,
      'contract',
      'compile',
      '--source',
      'contracts/PqvmCounter.sol',
      '--contract',
      'PqvmCounter',
      '--out',
      out,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"contractName":"PqvmCounter"/);
    const artifact = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(out, 'utf8')));
    assert.equal(artifact.contractName, 'PqvmCounter');
    assert.match(artifact.bytecode, /^0x[0-9a-f]+$/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test('cli native context compile enforces explicit activation arguments', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'shell-sdk-cli-native-'));
  try {
    const source = path.join(tempDir, 'Context.sol');
    await writeFile(source, 'pragma solidity ^0.8.20; contract Context { function caller() external view returns(address) {return msg.sender;} }');
    const out = path.join(tempDir, 'Context.json');
    const base = [CLI, 'contract', 'compile', '--source', source, '--contract', 'Context', '--out', out];
    for (const args of [[], ['--pqvm'], ['--pqvm','--native-address-context-height'], ['--pqvm','--native-address-context-height','1.5'], ['--native-address-context-height','2']]) {
      // Ordinary EVM compilation remains valid; PQVM requires the profile.
      const result = spawnSync(process.execPath, [...base,...args], {encoding:'utf8'});
      assert.equal(result.status, args.length === 0 ? 0 : 1, result.stderr);
    }
    const result = spawnSync(process.execPath, [...base,'--pqvm','--native-address-context-height','2'], {encoding:'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(out,'utf8')).contractName, 'Context');
  } finally { await rm(tempDir, {recursive:true,force:true}); }
});
