import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSolidity } from '../dist/contracts-compiler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_PATH = path.join(REPO_ROOT, 'contracts', 'PqvmCounter.sol');
const OUTPUT_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'compiled', 'PqvmCounter.compiled.json');

export async function compileContractFixture() {
  const artifact = await compileSolidity({
    sources: [{ path: 'PqvmCounter.sol', content: await readFile(SOURCE_PATH, 'utf8') }],
    contractName: 'PqvmCounter',
  });
  artifact.sourcePath = 'contracts/PqvmCounter.sol';

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return { outputPath: OUTPUT_PATH, bytecodeSize: (artifact.bytecode.length - 2) / 2 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await compileContractFixture();
  console.log(`compiled ${result.outputPath} (bytecode=${result.bytecodeSize} bytes)`);
}
