import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));

if (typeof version !== 'string' || !version) {
  throw new Error('package.json must declare a release version');
}
if (lock.version !== version || lock.packages?.['']?.version !== version) {
  throw new Error('package-lock.json must match the package version');
}
if (process.env.GITHUB_REF !== `refs/tags/v${version}`) {
  throw new Error(`Publish requires the matching Git tag v${version}; branch dispatches are not releases`);
}

// Prereleases remain opt-in and must not move the stable installation channel.
const prerelease = version.split('+')[0].includes('-');
console.log(`dist_tag=${prerelease ? 'next' : 'latest'}`);
