import { blake3 } from "@noble/hashes/blake3";
import { bech32m } from "@scure/base";
import { bytesToHex, hexToBytes } from "viem";

export const PQ_ADDRESS_HRP = "pq";
export const PQ_ADDRESS_LENGTH = 20;
export const PQ_ADDRESS_VERSION_V1 = 0x01;

type Bech32Address = `${string}1${string}`;
type HexAddress = `0x${string}`;

function assertBech32Address(value: string): asserts value is Bech32Address {
  if (!value.includes("1")) {
    throw new Error("invalid bech32m address");
  }
}

function assertHexAddress(value: string): asserts value is HexAddress {
  if (!value.startsWith("0x")) {
    throw new Error("invalid hex address");
  }
}

export function bytesToPqAddress(
  bytes: Uint8Array,
  version: number = PQ_ADDRESS_VERSION_V1,
): string {
  if (bytes.length !== PQ_ADDRESS_LENGTH) {
    throw new Error(`expected ${PQ_ADDRESS_LENGTH} address bytes, got ${bytes.length}`);
  }
  if (version < 0 || version > 255) {
    throw new Error(`invalid address version: ${version}`);
  }

  const payload = new Uint8Array(1 + PQ_ADDRESS_LENGTH);
  payload[0] = version;
  payload.set(bytes, 1);
  return bech32m.encode(PQ_ADDRESS_HRP, bech32m.toWords(payload));
}

export function pqAddressToBytes(address: string): Uint8Array {
  assertBech32Address(address);
  const { prefix, words } = bech32m.decode(address);

  if (prefix !== PQ_ADDRESS_HRP) {
    throw new Error(`expected ${PQ_ADDRESS_HRP} address prefix, got ${prefix}`);
  }

  const bytes = Uint8Array.from(bech32m.fromWords(words));
  if (bytes.length !== 1 + PQ_ADDRESS_LENGTH) {
    throw new Error(`expected ${1 + PQ_ADDRESS_LENGTH} address bytes, got ${bytes.length}`);
  }

  return bytes.slice(1);
}

export function pqAddressVersion(address: string): number {
  assertBech32Address(address);
  const { words } = bech32m.decode(address);
  const bytes = Uint8Array.from(bech32m.fromWords(words));
  if (bytes.length !== 1 + PQ_ADDRESS_LENGTH) {
    throw new Error(`expected ${1 + PQ_ADDRESS_LENGTH} address bytes, got ${bytes.length}`);
  }
  return bytes[0];
}

export function hexAddressToBytes(address: string): Uint8Array {
  assertHexAddress(address);
  const bytes = hexToBytes(address);
  if (bytes.length !== PQ_ADDRESS_LENGTH) {
    throw new Error(`expected ${PQ_ADDRESS_LENGTH} address bytes, got ${bytes.length}`);
  }
  return bytes;
}

export function bytesToHexAddress(bytes: Uint8Array): HexAddress {
  if (bytes.length !== PQ_ADDRESS_LENGTH) {
    throw new Error(`expected ${PQ_ADDRESS_LENGTH} address bytes, got ${bytes.length}`);
  }
  return bytesToHex(bytes);
}

export function normalizePqAddress(address: string): string {
  if (isPqAddress(address)) {
    return address;
  }

  return bytesToPqAddress(hexAddressToBytes(address));
}

export function normalizeHexAddress(address: string): HexAddress {
  if (isPqAddress(address)) {
    return bytesToHexAddress(pqAddressToBytes(address));
  }

  assertHexAddress(address);
  return address;
}

export function derivePqAddressFromPublicKey(
  publicKey: Uint8Array,
  algorithmId: number,
  version: number = PQ_ADDRESS_VERSION_V1,
): string {
  if (algorithmId < 0 || algorithmId > 255) {
    throw new Error(`invalid algorithm id: ${algorithmId}`);
  }

  const input = new Uint8Array(2 + publicKey.length);
  input[0] = version;
  input[1] = algorithmId;
  input.set(publicKey, 2);

  const hash = blake3(input);
  return bytesToPqAddress(hash.slice(0, PQ_ADDRESS_LENGTH), version);
}

export function isPqAddress(address: string): boolean {
  try {
    pqAddressToBytes(address);
    return true;
  } catch {
    return false;
  }
}
