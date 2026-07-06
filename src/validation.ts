/**
 * Input validation utilities for Shell Chain SDK.
 *
 * Provides validators for transaction inputs (addresses, amounts, nonces) and RPC URLs.
 *
 * @module validation
 */

import { isShellAddress } from "./address.js";

/**
 * Validate that a value is a non-negative bigint.
 *
 * @param value - The value to validate.
 * @param fieldName - Human-readable field name for error messages.
 * @throws {Error} If the value is not a non-negative bigint.
 */
export function validateNonNegativeBigInt(value: bigint, fieldName: string): void {
  if (typeof value !== "bigint" || value < 0n) {
    throw new Error(`${fieldName} must be a non-negative bigint, got ${value}`);
  }
}

/**
 * Validate that a value is a non-negative integer.
 *
 * @param value - The value to validate.
 * @param fieldName - Human-readable field name for error messages.
 * @throws {Error} If the value is not a non-negative integer.
 */
export function validateNonNegativeInteger(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer (≤ 2^53-1), got ${value}`);
  }
}

/**
 * Validate that an address is a valid Shell address (0x + 64 hex chars).
 *
 * Accepts null for contract deployment transactions.
 *
 * @param address - The address to validate (can be null).
 * @param fieldName - Human-readable field name for error messages.
 * @throws {Error} If the address is not null and not a valid Shell address.
 */
export function validateAddress(address: string | null, fieldName: string): void {
  if (address !== null && !isShellAddress(address)) {
    throw new Error(`${fieldName} must be null or a valid Shell address (0x + 64 hex chars), got ${address}`);
  }
}

/**
 * Validate that a value is a 32-byte `0x`-prefixed hash.
 *
 * @param hash - The hash to validate.
 * @param fieldName - Human-readable field name for error messages.
 * @throws {Error} If the value is not a 32-byte hex hash.
 */
export function validateHash(hash: string, fieldName: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error(`${fieldName} must be a valid 32-byte hash (0x + 64 hex chars), got ${hash}`);
  }
}

/**
 * Validate that an RPC URL is secure.
 *
 * Rules:
 * - Must be https:// (or http:// for localhost only)
 * - Cannot point to private IP ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8)
 * - WebSocket URLs must start with wss:// (or ws:// for localhost only)
 *
 * @param urlString - The RPC URL to validate.
 * @throws {Error} If the URL fails validation.
 */
export function validateRpcUrl(urlString: string): void {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid RPC URL: ${urlString}`);
  }

  const protocol = url.protocol;
  const hostname = url.hostname;
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

  // Check protocol: https/wss for remote, http/ws allowed for localhost
  const isHttp = protocol === "http:";
  const isHttps = protocol === "https:";
  const isWs = protocol === "ws:";
  const isWss = protocol === "wss:";

  if (!isHttp && !isHttps && !isWs && !isWss) {
    throw new Error(`RPC URL must use http, https, ws, or wss protocol, got ${protocol}`);
  }

  if ((isHttp || isWs) && !isLocal) {
    throw new Error(`Insecure RPC URL: ${isHttp ? "http" : "ws"} only allowed for localhost`);
  }

  // Check for private IP ranges (IPv4 and IPv6)
  if (!isLocal && (isPrivateIp(hostname) || isPrivateIpv6(hostname))) {
    throw new Error(`RPC URL cannot point to private IP range: ${hostname}`);
  }
}

/**
 * Check if a hostname is in a private IPv6 range.
 *
 * Covers: loopback (::1), link-local (fe80::/10), unique-local (fc00::/7),
 * and IPv4-mapped addresses (::ffff:x.x.x.x) whose IPv4 part is private.
 *
 * @param hostname - The raw hostname string (brackets already stripped by URL).
 * @returns true if the hostname is a private or link-local IPv6 address.
 */
function isPrivateIpv6(hostname: string): boolean {
  // url.hostname retains brackets for IPv6, e.g. [fe80::1]; strip them.
  const stripped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (!stripped.includes(":")) return false;
  const lower = stripped.toLowerCase();

  // Loopback
  if (lower === "::1") return true;

  // Link-local fe80::/10 covers fe80:: – febf:: (second byte 0x80–0xBF)
  if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true;

  // Unique-local fc00::/7: first byte is 0xfc or 0xfd
  if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true;

  // IPv4-mapped ::ffff:x.x.x.x — Node.js normalises to hex groups (e.g.
  // ::ffff:a9fe:a9fe for 169.254.169.254).  Block all IPv4-mapped addresses;
  // a private IPv4 address expressed this way bypasses the IPv4 checker.
  if (lower.startsWith("::ffff:")) return true;

  return false;
}


/**
 * Check if a hostname is in a private IPv4 range.
 *
 * @param hostname - The hostname to check.
 * @returns true if the hostname is a private IPv4 address.
 */
function isPrivateIp(hostname: string): boolean {
  // Try to resolve as IP address
  const ipRegex = /^(?:\d{1,3}\.){3}\d{1,3}$/;
  if (!ipRegex.test(hostname)) {
    return false; // Not an IP address (could be a domain)
  }

  const parts = hostname.split(".").map(Number);
  if (parts.some(p => p < 0 || p > 255)) {
    return false; // Invalid IP
  }

  // 10.0.0.0/8
  if (parts[0] === 10) return true;

  // 172.16.0.0/12
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;

  // 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true;

  // 127.0.0.0/8 (loopback, but already handled by localhost check)
  if (parts[0] === 127) return true;

  // 0.0.0.0/8
  if (parts[0] === 0) return true;

  // 169.254.0.0/16 (link-local — includes the cloud metadata endpoint
  // 169.254.169.254, the most common SSRF target)
  if (parts[0] === 169 && parts[1] === 254) return true;

  // 100.64.0.0/10 (CGNAT / shared address space, RFC 6598)
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;

  // 255.255.255.255 (broadcast)
  if (parts[0] === 255 && parts[1] === 255 && parts[2] === 255 && parts[3] === 255) return true;

  return false;
}
