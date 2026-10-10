import {compileSolidity} from '../dist/contracts-compiler.js';
import {writeFileSync} from 'node:fs';
import {toFunctionSelector} from 'viem';
import solc from 'solc';
if (!process.argv[2]) throw new Error('usage: node scripts/compile-native-call-fixture.mjs <output.json>');
const source='pragma solidity ^0.8.20; contract NativeCall { function invoke(address target, bytes memory data, uint256 value) external payable returns(bool,bytes memory) {return target.call{value:value}(data);} function invokeNoValue(address target, bytes memory data) external returns(bool,bytes memory) {return target.call(data);} }';
const artifact=await compileSolidity({sources:[{path:'NativeCall.sol',content:source}],contractName:'NativeCall',target:'pqvm',evmVersion:'shanghai',nativeAddressContextHeight:2});
writeFileSync(process.argv[2],JSON.stringify({source,compiler:solc.version(),activationHeight:2,selector:toFunctionSelector('invoke(address,bytes,uint256)'),noValueSelector:toFunctionSelector('invokeNoValue(address,bytes)'),artifact},null,2)+'\n');
