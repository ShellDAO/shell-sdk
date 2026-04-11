# shell-sdk

TypeScript SDK for Shell Chain.

## Scope

- viem-based client primitives
- PQ bech32m address helpers
- Foundation for AA transaction builders and PQ signers

## Development

```bash
npm install
npm run build
```

## Initial exports

- `shellDevnet`
- `ShellProvider`
- `createShellProvider`
- `createShellPublicClient`
- `createShellWsClient`
- `bytesToPqAddress`
- `pqAddressToBytes`
- `isPqAddress`
- `derivePqAddressFromPublicKey`
- `buildTransferTransaction`
- `buildRotateKeyTransaction`
- `buildSignedTransaction`
