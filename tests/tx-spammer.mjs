/**
 * Shell Chain Testnet — PQ Transaction Spammer v2
 * 10x throughput: sends a burst of 10 concurrent txs (one per account) every 2500ms.
 * ~240 tx/min vs ~24 tx/min in v1.
 */

import { readFileSync } from 'fs';
import {
  decryptKeystore,
  createShellProvider,
  buildTransferTransaction,
  hashTransaction,
} from '/opt/shell/shell-sdk-new/dist/index.js';
import { defineChain } from 'viem';

const RPC_URL = 'http://127.0.0.1:8545';
const CHAIN_ID = 10;
const KEYSTORE_PASSWORD = 'testnet-test-2026';
const KEYSTORE_DIR = '/opt/shell/test-accounts';
const NUM_ACCOUNTS = 10;
const BURST_INTERVAL_MS = 2500; // burst every 2.5s → 10 tx/burst × 24 bursts/min = 240 tx/min

const shellTestnet = defineChain({
  id: CHAIN_ID,
  name: 'Shell Testnet',
  nativeCurrency: { decimals: 18, name: 'SHELL', symbol: 'SHELL' },
  rpcUrls: { default: { http: [RPC_URL] } },
});

function log(type, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${type.padEnd(10)}] ${msg}`);
}

const stats = { total: 0, ok: 0, err: 0, byType: {} };
function record(type, success) {
  stats.total++;
  if (success) stats.ok++; else stats.err++;
  if (!stats.byType[type]) stats.byType[type] = { ok: 0, err: 0 };
  if (success) stats.byType[type].ok++; else stats.byType[type].err++;
}

async function loadSigners() {
  const signers = [];
  for (let i = 1; i <= NUM_ACCOUNTS; i++) {
    const path = `${KEYSTORE_DIR}/account-${i}.json`;
    const ks = JSON.parse(readFileSync(path, 'utf8'));
    const signer = await decryptKeystore(ks, KEYSTORE_PASSWORD);
    signers.push(signer);
    log('INIT', `Loaded account-${i}: ${signer.getAddress()}`);
  }
  return signers;
}

async function getNonce(provider, address) {
  const result = await provider.client.request({
    method: 'eth_getTransactionCount',
    params: [address, 'latest'],
  });
  return parseInt(result, 16);
}

// Per-account nonce cache (reset on error)
const nonces = {};

async function getNextNonce(provider, signer) {
  const addr = signer.getAddress();
  if (nonces[addr] === undefined) {
    nonces[addr] = await getNonce(provider, addr);
  }
  return nonces[addr]++;
}

function resetNonce(signer) {
  delete nonces[signer.getAddress()];
}

// --- Transaction builders ---

async function sendTransfer(provider, from, to) {
  const nonce = await getNextNonce(provider, from);
  const tx = buildTransferTransaction({ chainId: CHAIN_ID, nonce, to: to.getAddress(), value: BigInt('1000000000000000000') });
  const signed = await from.buildSignedTransaction({ tx, txHash: hashTransaction(tx), includePublicKey: true });
  return provider.sendTransaction(signed);
}

async function sendSmallTransfer(provider, from, to) {
  const nonce = await getNextNonce(provider, from);
  const tx = buildTransferTransaction({ chainId: CHAIN_ID, nonce, to: to.getAddress(), value: BigInt('100000000000000') });
  const signed = await from.buildSignedTransaction({ tx, txHash: hashTransaction(tx), includePublicKey: true });
  return provider.sendTransaction(signed);
}

async function sendZeroTransfer(provider, from, to) {
  const nonce = await getNextNonce(provider, from);
  const tx = buildTransferTransaction({ chainId: CHAIN_ID, nonce, to: to.getAddress(), value: 0n, gasLimit: 21000 });
  const signed = await from.buildSignedTransaction({ tx, txHash: hashTransaction(tx), includePublicKey: true });
  return provider.sendTransaction(signed);
}

async function sendWithData(provider, from, to) {
  const nonce = await getNextNonce(provider, from);
  const data = `0x${Buffer.from(`shell-memo-${Date.now()}`).toString('hex')}`;
  const tx = buildTransferTransaction({ chainId: CHAIN_ID, nonce, to: to.getAddress(), value: BigInt('500000000000000000'), data, gasLimit: 50000 });
  const signed = await from.buildSignedTransaction({ tx, txHash: hashTransaction(tx), includePublicKey: true });
  return provider.sendTransaction(signed);
}

const TX_TYPES = [
  { name: 'TRANSFER_1',    fn: sendTransfer,      weight: 4 },
  { name: 'TRANSFER_TINY', fn: sendSmallTransfer, weight: 3 },
  { name: 'ZERO_TX',       fn: sendZeroTransfer,  weight: 2 },
  { name: 'DATA_TX',       fn: sendWithData,      weight: 2 },
];

// Weighted sequence expanded
const TX_SEQUENCE = TX_TYPES.flatMap(t => Array(t.weight).fill(t));
let seqIdx = 0;
let burstCount = 0;

/**
 * Send one tx for a single account (used inside a burst).
 * `slotIdx` offsets the account pairing for variety.
 */
async function sendOne(provider, signers, slotIdx) {
  const txType = TX_SEQUENCE[(seqIdx + slotIdx) % TX_SEQUENCE.length];
  const from = signers[slotIdx % signers.length];
  const to   = signers[(slotIdx + 3) % signers.length];

  try {
    const hash = await txType.fn(provider, from, to);
    log(txType.name, `${from.getAddress().slice(0,14)}→${to.getAddress().slice(0,14)} tx=${hash.slice(0,14)}…`);
    record(txType.name, true);
  } catch (err) {
    const msg = err?.message || String(err);
    log(txType.name, `ERR[${slotIdx}] ${msg.slice(0, 80)}`);
    record(txType.name, false);
    if (msg.includes('nonce') || msg.includes('invalid') || msg.includes('stale')) {
      resetNonce(from);
    }
  }
}

/**
 * Fire all 10 account slots concurrently, wait for all to settle.
 */
async function sendBurst(provider, signers) {
  const tasks = signers.map((_, i) => sendOne(provider, signers, i));
  await Promise.allSettled(tasks);
  seqIdx = (seqIdx + signers.length) % TX_SEQUENCE.length;
  burstCount++;
}

async function printStats(provider) {
  try {
    const blockNum = await provider.client.getBlockNumber();
    const rate = (stats.total / (burstCount * BURST_INTERVAL_MS / 1000 / 60)).toFixed(1);
    console.log(`\n──── Stats  block=${blockNum}  total=${stats.total}  ok=${stats.ok}  err=${stats.err}  ~${rate} tx/min ────`);
    for (const [type, c] of Object.entries(stats.byType)) {
      console.log(`  ${type.padEnd(14)} ok=${c.ok} err=${c.err}`);
    }
    console.log('');
  } catch { /* ignore */ }
}

async function main() {
  console.log('=== Shell Chain Testnet PQ Transaction Spammer v2 (10x burst) ===');
  console.log(`RPC: ${RPC_URL}  Chain: ${CHAIN_ID}  Burst: ${NUM_ACCOUNTS} concurrent tx / ${BURST_INTERVAL_MS}ms`);

  const provider = createShellProvider({ chain: shellTestnet, rpcHttpUrl: RPC_URL });

  const block = await provider.client.getBlockNumber();
  console.log(`Current block: ${block}\n`);

  console.log('Loading PQ keystores…');
  const signers = await loadSigners();
  console.log(`\nLoaded ${signers.length} signers. Starting burst spam (target ~${Math.round(signers.length / BURST_INTERVAL_MS * 60000)} tx/min)...\n`);

  setInterval(() => printStats(provider), 60_000);

  // Pre-fetch all nonces concurrently before first burst
  await Promise.all(signers.map(s => getNextNonce(provider, s).then(n => {
    // getNextNonce already cached + incremented; roll back the increment
    nonces[s.getAddress()] = n - 1;
  })));

  while (true) {
    const t0 = Date.now();
    await sendBurst(provider, signers);
    const elapsed = Date.now() - t0;
    const wait = Math.max(0, BURST_INTERVAL_MS - elapsed);
    await new Promise(r => setTimeout(r, wait));
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
