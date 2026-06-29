import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
