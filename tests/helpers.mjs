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
