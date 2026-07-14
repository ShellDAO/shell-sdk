import assert from 'node:assert/strict';
import test from 'node:test';

import { decryptKeystore, parseEncryptedKey } from '../dist/keystore.js';
import cliMlDsa65 from './fixtures/cli-keystore-mldsa65.json' with { type: 'json' };

function withKdfParams(params) {
  return {
    ...cliMlDsa65,
    kdf_params: { ...cliMlDsa65.kdf_params, ...params },
  };
}

test('decryptKeystore rejects excessive Argon2 work before derivation', async () => {
  await assert.rejects(
    () => decryptKeystore(withKdfParams({ m_cost: 131_073 }), 'password'),
    /argon2 memory cost/i,
  );
  await assert.rejects(
    () => decryptKeystore(withKdfParams({ t_cost: 11 }), 'password'),
    /argon2 time cost/i,
  );
  await assert.rejects(
    () => decryptKeystore(withKdfParams({ p_cost: 17 }), 'password'),
    /argon2 parallelism/i,
  );
});

test('decryptKeystore rejects malformed encoded fields before derivation', async () => {
  await assert.rejects(
    () => decryptKeystore({ ...cliMlDsa65, ciphertext: 'zz' }, 'password'),
    /ciphertext.*hex/i,
  );
  await assert.rejects(
    () => decryptKeystore({ ...cliMlDsa65, ciphertext: '00'.repeat(4_097) }, 'password'),
    /ciphertext.*8192/i,
  );
});

test('parseEncryptedKey rejects oversized public keys before decoding', () => {
  assert.throws(
    () => parseEncryptedKey({ ...cliMlDsa65, public_key: '00'.repeat(2_049) }),
    /public key.*4096/i,
  );
});
