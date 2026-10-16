import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const expected = JSON.parse(readFileSync('package.json', 'utf8'));
const consumer = mkdtempSync(path.join(tmpdir(), 'shell-sdk-package-'));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: consumer, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} failed: ${result.error ?? result.stderr}`);
  return result.stdout;
}

try {
  const spec = process.argv[2] ?? path.join(consumer, JSON.parse(execFileSync('npm',
    ['pack', '--json', '--pack-destination', consumer], { encoding: 'utf8' }))[0].filename);
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund',
    '--no-package-lock', spec]);
  const root = path.join(consumer, 'node_modules', expected.name);
  const installed = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(installed.version, expected.version, 'Installed version must match the release');
  assert.equal(installed.bin?.['shell-sdk'], 'dist/cli.js', 'CLI entry must survive packing');
  assert.deepEqual(installed.exports, expected.exports, 'Public exports must survive packing');
  for (const entry of Object.values(installed.exports)) {
    for (const file of [entry.types, entry.import]) {
      assert.ok(statSync(path.join(root, file)).isFile(), `Missing public file: ${file}`);
    }
  }
  const imports = Object.keys(installed.exports).map((entry) =>
    entry === '.' ? installed.name : installed.name + entry.slice(1));
  run(process.execPath, ['--input-type=module', '-e',
    `for (const entry of ${JSON.stringify(imports)}) await import(entry);`]);
  const help = run(process.execPath, [path.join(consumer, 'node_modules', '.bin', 'shell-sdk'), '--help']);
  assert.match(help, /shell-sdk contract <command>/);
  const source = 'pragma solidity ^0.8.30; contract Counter { function value() public pure returns (uint256) { return 7; } }';
  run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { compileSolidity } from 'shell-sdk/contracts/compiler';
    await assert.rejects(compileSolidity({ contractName: 'Counter', sources: [
      { path: 'Counter.sol', content: ${JSON.stringify(source)} }
    ] }), /requires the optional solc peer/);
  `]);
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund',
    '--no-package-lock', `solc@${installed.peerDependencies.solc}`]);
  writeFileSync(path.join(consumer, 'Counter.sol'), source);
  for (const target of ['evm', 'pqvm']) {
    run(process.execPath, [path.join(consumer, 'node_modules', '.bin', 'shell-sdk'),
      'contract', 'compile', '--source', 'Counter.sol', '--contract', 'Counter',
      '--out', `${target}.json`, ...(target === 'pqvm' ? ['--pqvm'] : [])]);
    const artifact = JSON.parse(readFileSync(path.join(consumer, `${target}.json`), 'utf8'));
    assert.equal(artifact.contractName, 'Counter');
    assert.match(artifact.bytecode, /^0x[0-9a-f]+$/i);
    assert.ok(artifact.abi.some((entry) => entry.type === 'function' && entry.name === 'value'));
  }
  console.log(`Verified ${installed.name}@${installed.version}: imports, declarations, CLI and EVM/PQABI compilation`);
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
