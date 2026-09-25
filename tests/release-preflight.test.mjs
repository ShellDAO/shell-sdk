import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/release-preflight.mjs', import.meta.url));

function preflight(version, ref, lockVersion = version) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'sdk-release-preflight-'));
  try {
    writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ version }));
    writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({
      version: lockVersion, packages: { '': { version: lockVersion } },
    }));
    return spawnSync(process.execPath, [script], {
      cwd, env: { ...process.env, GITHUB_REF: ref }, encoding: 'utf8',
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('release candidates publish to next while stable releases publish to latest', () => {
  for (const [version, tag] of [['0.14.0-rc.1', 'next'], ['0.14.0', 'latest']]) {
    const result = preflight(version, `refs/tags/v${version}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `dist_tag=${tag}`);
  }
});

test('wrong tags and branch dispatches cannot publish the package', () => {
  for (const ref of ['refs/tags/v0.13.0', 'refs/heads/main', 'refs/heads/v0.14.0-rc.1', '']) {
    const result = preflight('0.14.0-rc.1', ref);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /matching Git tag/);
    assert.equal(result.stdout, '');
  }
});

test('release preflight rejects stale lockfile package versions', () => {
  const result = preflight('0.14.0-rc.1', 'refs/tags/v0.14.0-rc.1', '0.13.0');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package-lock.json must match/);
  assert.equal(result.stdout, '');
});
