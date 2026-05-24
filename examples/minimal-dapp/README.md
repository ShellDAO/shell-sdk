# Shell SDK — Minimal dApp Example

Demonstrates the core Shell SDK flow:
1. Generate a post-quantum key pair (ML-DSA-65)
2. Create a signer and derive address
3. Query balance from a Shell node
4. Build + sign a transaction (without broadcasting)

## Node.js (server / CLI)

```bash
# From the shell-sdk root:
npm install
npm run build

# Run the demo (points at localhost:8545 by default)
node examples/minimal-dapp/node-demo.mjs

# Point at a different RPC endpoint:
SHELL_RPC_URL=http://my-node:8545 node examples/minimal-dapp/node-demo.mjs
```

Expected output:
```
Address (0x + 64 hex): 0x…
Balance (wei): 0   ← 0 for a fresh account; fund it via the faucet
Signed tx type: 2
Signature length (bytes): 3309
Sender pubkey set: true

All done! Connect to a live node and call provider.sendTransaction(signed) to broadcast.
```

## Browser

```bash
# Build the SDK first
cd ../../  # shell-sdk root
npm run build

# Serve this directory with any HTTP server
npx serve examples/minimal-dapp/
# or
python3 -m http.server 8080
```

Then open `http://localhost:8080/browser-demo.html` in your browser.

## Key sizes (ML-DSA-65 / FIPS 204)

| Field       | Bytes |
|-------------|-------|
| Public key  | 1952  |
| Secret key  | 4032  |
| Signature   | 3309  |

These match `pqcrypto-dilithium` v0.5 (used by shell-chain), confirming wire
compatibility. Both `"Dilithium3"` and `"MlDsa65"` keys use this algorithm.
