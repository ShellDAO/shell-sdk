import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_PATH = path.join(REPO_ROOT, 'contracts', 'PqvmCounter.sol');
const OUTPUT_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'compiled', 'PqvmCounter.compiled.json');

export async function compileContractFixture() {
  const source = await readFile(SOURCE_PATH, 'utf8');
  const input = {
    language: 'Solidity',
    sources: {
      'PqvmCounter.sol': { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object'],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter((entry) => entry.severity === 'error');
  if (errors.length > 0) {
    const message = errors.map((entry) => entry.formattedMessage ?? entry.message).join('\n');
    throw new Error(`Solidity compile failed:\n${message}`);
  }

  const contract = output.contracts?.['PqvmCounter.sol']?.PqvmCounter;
  if (!contract?.abi || !contract?.evm?.bytecode?.object) {
    throw new Error('Missing ABI/bytecode output for PqvmCounter');
  }

  const payload = {
    contractName: 'PqvmCounter',
    sourcePath: 'contracts/PqvmCounter.sol',
    solcVersion: solc.version(),
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`,
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { outputPath: OUTPUT_PATH, bytecodeSize: contract.evm.bytecode.object.length / 2 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await compileContractFixture();
  console.log(`compiled ${result.outputPath} (bytecode=${result.bytecodeSize} bytes)`);
}
