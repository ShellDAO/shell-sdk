import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { argon2id } from 'hash-wasm';

export async function createKeystoreFixture({ secretKey, publicKey, address, keyType, password }) {
  const salt = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
  const nonce = Uint8Array.from({ length: 24 }, (_, index) => 100 + index);

  const derivedKeyHex = await argon2id({
    password,
    salt,
    iterations: 2,
    memorySize: 65536,
    parallelism: 1,
    hashLength: 32,
    outputType: 'hex',
  });
  const derivedKey = hexToBytes(derivedKeyHex);

  const plaintext = new Uint8Array(secretKey);
  const cipher = xchacha20poly1305(derivedKey, nonce);
  const ciphertext = cipher.encrypt(plaintext);

  return {
    version: 1,
    address,
    key_type: keyType,
    kdf: 'argon2id',
    kdf_params: {
      m_cost: 65536,
      t_cost: 2,
      p_cost: 1,
      salt: bytesToHex(salt),
    },
    cipher: 'xchacha20-poly1305',
    cipher_params: { nonce: bytesToHex(nonce) },
    ciphertext: bytesToHex(ciphertext),
    public_key: bytesToHex(publicKey),
  };
}

export function createJsonRpcFetchMock() {
  const calls = [];
  const fetchMock = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);

    const results = {
      shell_getPqPubkey: '0x' + '11'.repeat(32),
      shell_sendTransaction: '0x' + 'ab'.repeat(32),
      shell_getTransactionsByAddress: { transactions: [], total: 0 },
      shell_rpcCapabilities: {
        rpcVersion: 'shell-rpc-v2',
        methods: [
          'shell_rpcCapabilities',
          'shell_getChainSnapshot',
          'shell_getBlocksRange',
          'shell_getAddressSummary',
          'shell_getTransactionsByAddressV2',
          'shell_getTransactionSummary',
          'shell_getValidatorSnapshot',
        ],
        maxPageSize: 100,
        maxBlocksRange: 100,
        maxTxSummaryPerBlock: 100,
        supportsCursorPagination: true,
        supportsAddressHistoryIndex: true,
        witnessStore: true,
        storageProfile: { profile: 'archive' },
        fallbackMethods: ['shell_getBlockByNumber', 'shell_getTransactionsByAddress'],
      },
      shell_getChainSnapshot: {
        chainId: '0x67932',
        head: { number: '0x2a', hash: '0x' + 'aa'.repeat(32), transactionCount: 1 },
        finalized: { number: '0x29', hash: '0x' + 'bb'.repeat(32), transactionCount: 0 },
        finalityLag: 1,
        pendingTransactions: '0x0',
        peerCount: 3,
        isMining: false,
        uptime: 120,
        baseFee: '0x3b9aca00',
        gasPrice: '0x3b9aca00',
        totalTransactions: 42,
        gasUsedTotal: '0x5208',
        avgBlockTime: 2,
        consensus: {},
        validators: [],
        storageProfile: { profile: 'archive' },
      },
      shell_getBlocksRange: {
        start: '0x2a',
        direction: 'desc',
        limit: 2,
        blocks: [{ number: '0x2a', hash: '0x' + 'aa'.repeat(32), transactions: [] }],
        nextStart: '0x28',
      },
      shell_getAddressSummary: {
        address: '0x' + '44'.repeat(32),
        balance: '0xde0b6b3a7640000',
        nonce: '0x2',
        exists: true,
        hasCode: false,
        codeHash: null,
        pqPubkeyRegistered: true,
        totalTransactions: 1,
        recentTransactions: {
          address: '0x' + '44'.repeat(32),
          fromBlock: '0x0',
          toBlock: '0x2a',
          limit: 1,
          direction: 'desc',
          total: 1,
          nextCursor: null,
          hasMore: false,
          items: [],
        },
      },
      shell_getTransactionsByAddressV2: {
        address: '0x' + '44'.repeat(32),
        fromBlock: '0x0',
        toBlock: '0x2a',
        limit: 10,
        direction: 'desc',
        total: null,
        nextCursor: null,
        hasMore: false,
        items: [],
      },
      shell_getTransactionSummary: {
        transaction: {
          hash: '0x' + '55'.repeat(32),
          blockHash: '0x' + 'aa'.repeat(32),
          blockNumber: '0x2a',
          transactionIndex: '0x0',
          value: '0x0',
          type: '0x2',
          hasInput: false,
        },
        receipt: null,
        status: '0x1',
        gasUsed: '0x5208',
        logCount: 0,
        timestamp: '0x1',
      },
      shell_getValidatorSnapshot: {
        validators: [],
        stakeDerivedWeights: false,
        currentProposer: null,
        blockNumber: 42,
        epoch: 0,
        epochLength: 100,
        epochProgress: 42,
        proposerWindow: 20,
        proposerStats: [],
      },
      shell_estimatePaymasterGas: {
        paymaster: '0x' + '22'.repeat(32),
        sender: '0x' + '33'.repeat(32),
        validation_gas: null,
        paymaster_gas_cap: '0xc350',
        within_cap: null,
        simulation_status: 'cap_only',
        simulation_version: 1,
        capability: 'paymaster_cap_only',
      },
    };

    if (body.method === 'eth_chainId') {
      return makeResponse({ jsonrpc: '2.0', id: body.id, result: '0x67932' });
    }
    if (body.method in results) {
      return makeResponse({ jsonrpc: '2.0', id: body.id, result: results[body.method] });
    }

    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  return { fetchMock, calls };
}

function makeResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex) {
  const clean = hex.replace(/^0x/, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
