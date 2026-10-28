import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, access, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileSolidity } from '../dist/contracts-compiler.js';

test('all Shell compiler targets reject resolved classical recovery before saving an artifact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shell-compiler-recovery-'));
  try {
    for (const target of [undefined, 'evm', 'pqvm']) {
      for (const body of [
        'return ecrecover(hash,v,r,s);',
        'ecrecover(hash,v,r,s); return address(0);',
      ]) {
        const outputPath = join(dir, 'Recovery.json');
        await assert.rejects(compileSolidity({
          sources: [{ path: 'Recovery.sol', content: `pragma solidity ^0.8.26;
            contract Recovery { function recover(bytes32 hash,uint8 v,bytes32 r,bytes32 s)
              external pure returns(address) { ${body} } }` }],
          contractName: 'Recovery', target, outputPath,
        }), /Shell Chain does not support the Solidity ecrecover builtin \(Recovery\.sol, byte \d+\)/);
        await assert.rejects(access(outputPath), { code: 'ENOENT' });
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolved recovery in a Solidity library dependency is rejected', async () => {
  await assert.rejects(compileSolidity({
    sources: [
      { path: 'Recover.sol', content: `pragma solidity ^0.8.26;
        library Recover { function signer(bytes32 h,uint8 v,bytes32 r,bytes32 s)
          internal pure returns(address) { return ecrecover(h,v,r,s); } }` },
      { path: 'App.sol', content: `pragma solidity ^0.8.26; import './Recover.sol';
        contract App { function signer(bytes32 h,uint8 v,bytes32 r,bytes32 s)
          external pure returns(address) { return Recover.signer(h,v,r,s); } }` },
    ], contractName: 'App', target: 'pqvm',
  }), /ecrecover builtin \(Recover\.sol, byte \d+\)/);
});

test('classical hash builtins reject for every compiler target before saving an artifact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shell-compiler-hash-'));
  try {
    for (const target of [undefined, 'evm', 'pqvm']) {
      for (const [builtin, result] of [['sha256', 'bytes32'], ['ripemd160', 'bytes20']]) {
        const outputPath = join(dir, 'Hash.json');
        await assert.rejects(compileSolidity({
          sources: [{ path: 'Hash.sol', content: `pragma solidity ^0.8.26;
            contract Hash { function digest(bytes memory input) external pure returns(${result}) {
              return ${builtin}(input);
            } }` }], contractName: 'Hash', target, outputPath,
        }), new RegExp(`Solidity ${builtin} builtin \\(Hash\\.sol, byte \\d+\\)`));
        await assert.rejects(access(outputPath), { code: 'ENOENT' });
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('comments, strings, shadowed functions and PQ precompile calls remain compilable', async () => {
  for (const target of [undefined, 'pqvm']) {
    const artifact = await compileSolidity({
      sources: [{ path: 'Allowed.sol', content: `pragma solidity ^0.8.26;
        contract Allowed {
          // ecrecover is disabled; this user function just returns an integer.
          function ecrecover(uint256 n) internal pure returns(uint256) { return n + 1; }
          function sha256(uint256 n) internal pure returns(uint256) { return n + 2; }
          function ripemd160(uint256 n) internal pure returns(uint256) { return n + 3; }
          function label() external pure returns(string memory) { return "ecrecover sha256 ripemd160"; }
          function value(uint256 n) external pure returns(uint256) { return ecrecover(n) + sha256(n) + ripemd160(n); }
          function verify(bytes memory input) external view returns(bool,bytes memory) {
            address target = address(1); return target.staticcall(input);
          }
        }` }], contractName: 'Allowed', target,
      ...(target === 'pqvm' ? { nativeAddressContextHeight: 2 } : {}),
    });
    assert.match(artifact.bytecode, /^0x[0-9a-f]+$/);
  }
});

test('the contract compile CLI reports unsupported recovery and exits without an artifact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shell-cli-recovery-'));
  try {
    const source = join(dir, 'Recovery.sol'), output = join(dir, 'Recovery.json');
    await writeFile(source, `pragma solidity ^0.8.26;
      contract Recovery { function recover(bytes32 h,uint8 v,bytes32 r,bytes32 s)
        external pure returns(address) { return ecrecover(h,v,r,s); } }`);
    for (const flags of [[], ['--pqvm']]) {
      const result = spawnSync(process.execPath, ['dist/cli.js', 'contract', 'compile',
        '--source', source, '--contract', 'Recovery', '--out', output, ...flags], {
        encoding: 'utf8', timeout: 30000,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Shell Chain does not support the Solidity ecrecover builtin/);
      await assert.rejects(access(output), { code: 'ENOENT' });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the contract compile CLI rejects classical hash dependencies in EVM and PQVM mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shell-cli-hash-'));
  try {
    for (const [builtin, result] of [['sha256', 'bytes32'], ['ripemd160', 'bytes20']]) {
      const source = join(dir, 'Hash.sol'), output = join(dir, 'Hash.json');
      await writeFile(source, `pragma solidity ^0.8.26;
        contract Hash { function digest(bytes memory input) external pure returns(${result}) {
          return ${builtin}(input);
        } }`);
      for (const flags of [[], ['--pqvm']]) {
        const compiled = spawnSync(process.execPath, ['dist/cli.js', 'contract', 'compile',
          '--source', source, '--contract', 'Hash', '--out', output, ...flags], {
          encoding: 'utf8', timeout: 30000,
        });
        assert.equal(compiled.status, 1, compiled.stderr);
        assert.match(compiled.stderr, new RegExp(`Solidity ${builtin} builtin`));
        await assert.rejects(access(output), { code: 'ENOENT' });
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
