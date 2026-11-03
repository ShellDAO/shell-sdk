import { createShellProvider, type SignatureTypeName } from 'shell-sdk';

const provider = createShellProvider({ rpcHttpUrl: 'http://127.0.0.1:8545' });

export async function readCommitSignatures(blockHash: string): Promise<Array<{
  validator: string;
  algorithm: SignatureTypeName;
  bytes: Uint8Array;
}>> {
  const proof = await provider.getFinalityProof(blockHash);
  return Object.entries(proof.certificate ?? {}).map(([validator, signature]) => ({
    validator,
    algorithm: signature.sig_type,
    bytes: Uint8Array.from(signature.data),
  }));
}
