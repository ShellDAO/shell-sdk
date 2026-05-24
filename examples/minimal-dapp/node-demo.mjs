/**
 * Shell SDK minimal dApp — Node.js script
 *
 * Demonstrates: connect provider → query balance → sign + build transaction
 *
 * Usage:
 *   npm install shell-sdk
 *   node node-demo.mjs
 *
 * By default this points at the Shell devnet RPC. Set SHELL_RPC_URL to
 * override.
 */

import { MlDsa65Adapter, ShellSigner, createShellProvider } from "shell-sdk";

const RPC_URL = process.env.SHELL_RPC_URL ?? "http://127.0.0.1:8545";

async function main() {
  // ── 1. Create a provider ──────────────────────────────────────────────
  const provider = createShellProvider({ url: RPC_URL });

  // ── 2. Generate a key pair and build a signer ─────────────────────────
  const adapter = MlDsa65Adapter.generate();
  const signer = new ShellSigner("MlDsa65", adapter);

  console.log("Address (0x + 64 hex):", signer.getAddress());

  // ── 3. Query balance ───────────────────────────────────────────────────
  try {
    const balance = await provider.client.getBalance({ address: signer.getAddress() });
    console.log("Balance (wei):", balance.toString());
  } catch (err) {
    console.warn("getBalance failed (node may not be running):", err.message);
  }

  // ── 4. Build and sign a transaction ───────────────────────────────────
  // NOTE: sending requires a funded account + live node.
  // This section shows the sign-only flow without broadcasting.
  const TO = "0x0000000000000000000000000000000000000000000000000000000000000001";

  /** @type {import("shell-sdk").ShellTransactionRequest} */
  const tx = {
    from: signer.getAddress(),
    chain_id: 1337,
    nonce: 0,
    to: TO,
    value: "0x1",
    data: "0x",
    gas_limit: 21000,
    max_fee_per_gas: 1_000_000_000,
    max_priority_fee_per_gas: 1_000_000_000,
  };

  const { hashTransaction } = await import("shell-sdk");
  const txHash = hashTransaction(tx);
  const signed = await signer.buildSignedTransaction({ tx, txHash, includePublicKey: true });
  console.log("Signed tx type:", signed.tx.tx_type ?? 2, "(EIP-1559)");
  console.log("Signature length (bytes):", signed.signature.data.length);
  console.log("Sender pubkey set:", signed.sender_pubkey != null);

  console.log("\nAll done! Connect to a live node and call provider.sendTransaction(signed) to broadcast.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
