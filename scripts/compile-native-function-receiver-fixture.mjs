import {compileSolidity} from '../dist/contracts-compiler.js';
import {writeFileSync} from 'node:fs';
import {toFunctionSelector} from 'viem';
import solc from 'solc';
if (!process.argv[2]) throw new Error('usage: node scripts/compile-native-function-receiver-fixture.mjs <output.json>');
const source='pragma solidity ^0.8.20; contract NativeFunctionReceiver { address private target; uint256 public selections; function choose() internal returns(address) {selections+=1; return target;} function invoke(bytes memory data) external returns(bool,bytes memory) {return choose().call(data);} }';
const artifact=await compileSolidity({sources:[{path:'NativeFunctionReceiver.sol',content:source}],contractName:'NativeFunctionReceiver',target:'pqvm',evmVersion:'shanghai',nativeAddressContextHeight:2});
writeFileSync(process.argv[2],JSON.stringify({source,compiler:solc.version(),activationHeight:2,selector:toFunctionSelector('invoke(bytes)'),artifact},null,2)+'\n');
