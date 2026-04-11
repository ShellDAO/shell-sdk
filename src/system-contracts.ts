import { bytesToHex, encodeAbiParameters, keccak256, toBytes } from "viem";

import { bytesToPqAddress } from "./address.js";
import type { AddressLike, HexString } from "./types.js";

const SYSTEM_ADDRESS_LENGTH = 20;

function systemAddress(lastByte: number): Uint8Array {
  const bytes = new Uint8Array(SYSTEM_ADDRESS_LENGTH);
  bytes[SYSTEM_ADDRESS_LENGTH - 1] = lastByte;
  return bytes;
}

function selector(signature: string): HexString {
  return keccak256(toBytes(signature)).slice(0, 10) as HexString;
}

export const validatorRegistryHexAddress = "0x0000000000000000000000000000000000000001";
export const accountManagerHexAddress = "0x0000000000000000000000000000000000000002";
export const validatorRegistryAddress = bytesToPqAddress(systemAddress(1));
export const accountManagerAddress = bytesToPqAddress(systemAddress(2));

export const rotateKeySelector = selector("rotateKey(bytes,uint8)");
export const setValidationCodeSelector = selector("setValidationCode(bytes32)");
export const clearValidationCodeSelector = selector("clearValidationCode()");

export function encodeRotateKeyCalldata(publicKey: Uint8Array, algorithmId: number): HexString {
  const encoded = encodeAbiParameters(
    [
      { type: "bytes" },
      { type: "uint8" },
    ],
    [bytesToHex(publicKey), algorithmId],
  );

  return `${rotateKeySelector}${encoded.slice(2)}` as HexString;
}

export function encodeSetValidationCodeCalldata(codeHash: HexString): HexString {
  const encoded = encodeAbiParameters([{ type: "bytes32" }], [codeHash]);
  return `${setValidationCodeSelector}${encoded.slice(2)}` as HexString;
}

export function encodeClearValidationCodeCalldata(): HexString {
  return clearValidationCodeSelector;
}

export function isSystemContractAddress(address: AddressLike): boolean {
  return (
    address === accountManagerAddress ||
    address === validatorRegistryAddress ||
    address === accountManagerHexAddress ||
    address === validatorRegistryHexAddress
  );
}
