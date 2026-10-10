import {compileSolidity} from '../dist/contracts-compiler.js';
import {writeFileSync} from 'node:fs';
import {toFunctionSelector} from 'viem';
import solc from 'solc';
if (!process.argv[2]) throw new Error('usage: node scripts/compile-native-call-modes-fixture.mjs <output.json>');
const source='pragma solidity ^0.8.20; contract NativeModes { function invokeStatic(address target, bytes memory data) external view returns(bool,bytes memory) {return target.staticcall(data);} function invokeDelegate(address target, bytes memory data) external payable returns(bool,bytes memory) {return target.delegatecall(data);} }';
const artifact=await compileSolidity({sources:[{path:'NativeModes.sol',content:source}],contractName:'NativeModes',target:'pqvm',evmVersion:'shanghai',nativeAddressContextHeight:2});
writeFileSync(process.argv[2],JSON.stringify({source,compiler:solc.version(),activationHeight:2,staticSelector:toFunctionSelector('invokeStatic(address,bytes)'),delegateSelector:toFunctionSelector('invokeDelegate(address,bytes)'),artifact},null,2)+'\n');
