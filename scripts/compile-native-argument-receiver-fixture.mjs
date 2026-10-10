import {compileSolidity} from '../dist/contracts-compiler.js';
import {writeFileSync} from 'node:fs';
import {toFunctionSelector} from 'viem';
import solc from 'solc';
if (!process.argv[2]) throw new Error('usage: node scripts/compile-native-argument-receiver-fixture.mjs <output.json>');
const source='pragma solidity ^0.8.20; contract NativeArgumentReceiver { uint256 public selections; function choose(address target) internal returns(address) {selections+=1;return target;} function invoke(address target,bytes memory data) external returns(bool,bytes memory) {return choose(target).call(data);} }';
const artifact=await compileSolidity({sources:[{path:'NativeArgumentReceiver.sol',content:source}],contractName:'NativeArgumentReceiver',target:'pqvm',evmVersion:'shanghai',nativeAddressContextHeight:2});
writeFileSync(process.argv[2],JSON.stringify({source,compiler:solc.version(),activationHeight:2,selector:toFunctionSelector('invoke(address,bytes)'),artifact},null,2)+'\n');
