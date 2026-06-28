import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseAbi } from 'viem';

import {
  createShellProvider,
  decryptKeystore,
  deployContract,
  readContract,
  writeContract,
} from '../dist/index.js';
import { compileContractFixture } from '../scripts/compile-contract-fixture.mjs';

const ENABLED = process.env.SHELL_SDK_E2E_SG3 === '1';
const RPC_URL = process.env.SHELL_SDK_RPC_URL ?? 'http://47.237.195.95:8545';
const CHAIN_ID = Number(process.env.SHELL_SDK_CHAIN_ID ?? '10');
const MIN_BALANCE_WEI = BigInt(process.env.SHELL_SDK_MIN_BALANCE_WEI ?? '10000000000000000');
const MAX_FEE_PER_GAS = Number(process.env.SHELL_SDK_MAX_FEE_PER_GAS ?? '2000000000');
const MAX_PRIORITY_FEE_PER_GAS = Number(process.env.SHELL_SDK_MAX_PRIORITY_FEE_PER_GAS ?? '200000000');
const KEYSTORE_PATH = process.env.SHELL_SDK_E2E_KEYSTORE_PATH;
const KEYSTORE_JSON = process.env.SHELL_SDK_E2E_KEYSTORE_JSON;
const KEYSTORE_PASSWORD = process.env.SHELL_SDK_E2E_KEYSTORE_PASSWORD;
const FAUCET_URL = process.env.SHELL_SDK_E2E_FAUCET_URL ?? '';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ARTIFACT_PATH = path.join(__dirname, 'fixtures', 'compiled', 'PqvmCounter.compiled.json');

const ABI = parseAbi([
  'function setNumber(uint256 newNumber)',
  'function increment()',
  'function getNumber() view returns (uint256)',
]);

async function rpcRequest(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`rpc request failed: ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  if (body.error) {
    throw new Error(`rpc error [${body.error.code}] ${body.error.message}`);
  }
  return body.result;
}

async function sendWithRetries({
  label,
  signer,
  send,
  maxAttempts = 4,
}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const pendingNonceHex = await rpcRequest(RPC_URL, 'eth_getTransactionCount', [signer.getAddress(), 'pending']);
      const nonce = Number(BigInt(pendingNonceHex));
      return await send(nonce, attempt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const duplicate = message.match(/duplicate transaction (0x[a-f0-9]{64})/i);
      if (duplicate) {
        throw new Error(`${label} hit duplicate transaction outside SDK retry path: ${duplicate[1]}`);
      }
      lastError = error;
    }
  }

  throw new Error(`${label} failed after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function readKeystoreFixture() {
  if (KEYSTORE_JSON) {
    return JSON.parse(KEYSTORE_JSON);
  }
  if (KEYSTORE_PATH) {
    const content = await readFile(KEYSTORE_PATH, 'utf8');
    return JSON.parse(content);
  }
  throw new Error(
    'missing keystore: set SHELL_SDK_E2E_KEYSTORE_PATH or SHELL_SDK_E2E_KEYSTORE_JSON',
  );
}

async function topupViaFaucet(address) {
  if (!FAUCET_URL) {
    return;
  }

  const res = await fetch(FAUCET_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  if (!res.ok) {
    throw new Error(`faucet topup failed: ${res.status} ${res.statusText}`);
  }
}

const contractTest = ENABLED ? test : test.skip;

contractTest('sg3 pqvm smart contract flow: compile -> deploy -> write -> read', async () => {
  assert.ok(KEYSTORE_PASSWORD, 'SHELL_SDK_E2E_KEYSTORE_PASSWORD is required');
  assert.ok(Number.isSafeInteger(CHAIN_ID) && CHAIN_ID > 0, 'SHELL_SDK_CHAIN_ID must be positive');

  await compileContractFixture();
  const artifact = JSON.parse(await readFile(ARTIFACT_PATH, 'utf8'));
  assert.ok(typeof artifact.bytecode === 'string' && artifact.bytecode.startsWith('0x'), 'invalid artifact bytecode');

  const provider = createShellProvider({ rpcHttpUrl: RPC_URL });
  const keystore = await readKeystoreFixture();
  const signer = await decryptKeystore(keystore, KEYSTORE_PASSWORD);
  const address = signer.getAddress();

  let balance = await provider.client.getBalance({ address });
  if (balance < MIN_BALANCE_WEI && FAUCET_URL) {
    await topupViaFaucet(address);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    balance = await provider.client.getBalance({ address });
  }
  assert.ok(
    balance >= MIN_BALANCE_WEI,
    `insufficient balance for e2e deploy, balance=${balance.toString()} min=${MIN_BALANCE_WEI.toString()}`,
  );

  const deploy = await sendWithRetries({
    label: 'contract deploy',
    signer,
    send: (nonce, attempt) => deployContract({
      provider,
      signer,
      chainId: CHAIN_ID,
      artifact,
      nonce,
      includePublicKey: true,
      gasLimit: 1_500_000,
      maxFeePerGas: MAX_FEE_PER_GAS + (attempt - 1) * 500_000_000,
      maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS * attempt,
      wait: true,
      timeoutMs: 120_000,
      pollIntervalMs: 2_000,
    }),
  });
  const deployReceipt = deploy.receipt;
  assert.ok(deployReceipt.contractAddress, 'missing deployed contract address');
  const contractAddress = deploy.contractAddress;
  assert.match(contractAddress, /^0x[0-9a-fA-F]{64}$/, 'contract address must be 32-byte shell address');

  await sendWithRetries({
    label: 'setNumber',
    signer,
    send: (nonce, attempt) => writeContract({
      provider,
      signer,
      chainId: CHAIN_ID,
      nonce,
      address: contractAddress,
      abi: ABI,
      functionName: 'setNumber',
      args: [7n],
      gasLimit: 120_000,
      maxFeePerGas: MAX_FEE_PER_GAS + (attempt - 1) * 500_000_000,
      maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS * attempt,
      wait: true,
      timeoutMs: 120_000,
      pollIntervalMs: 2_000,
    }),
  });

  const setValue = await readContract({
    provider,
    address: contractAddress,
    abi: ABI,
    functionName: 'getNumber',
  });
  assert.equal(setValue, 7n, 'unexpected state after setNumber');

  await sendWithRetries({
    label: 'increment',
    signer,
    send: (nonce, attempt) => writeContract({
      provider,
      signer,
      chainId: CHAIN_ID,
      nonce,
      address: contractAddress,
      abi: ABI,
      functionName: 'increment',
      args: [],
      gasLimit: 120_000,
      maxFeePerGas: MAX_FEE_PER_GAS + (attempt - 1) * 500_000_000,
      maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS * attempt,
      wait: true,
      timeoutMs: 120_000,
      pollIntervalMs: 2_000,
    }),
  });

  const incValue = await readContract({
    provider,
    address: contractAddress,
    abi: ABI,
    functionName: 'getNumber',
  });
  assert.equal(incValue, 8n, 'unexpected state after increment');
});
