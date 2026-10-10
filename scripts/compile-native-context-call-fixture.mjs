import {compileSolidity} from '../dist/contracts-compiler.js';
import {writeFileSync} from 'node:fs';
import {toFunctionSelector} from 'viem';
import solc from 'solc';
if (!process.argv[2]) throw new Error('usage: node scripts/compile-native-context-call-fixture.mjs <output.json>');
const source='pragma solidity ^0.8.20; contract NativeContextCall { address public last; function invoke(bytes memory data) external returns(bool,bytes memory) {return address(this).call(data);} function poke() external returns(address) {last=msg.sender; return msg.sender;} function invokeDelegate(bytes memory data) external returns(bool,bytes memory) {return address(this).delegatecall(data);} function invokeStatic(bytes memory data) external view returns(bool,bytes memory) {return address(this).staticcall(data);} function read() external view returns(address) {return msg.sender;} }';
const artifact=await compileSolidity({sources:[{path:'NativeContextCall.sol',content:source}],contractName:'NativeContextCall',target:'pqvm',evmVersion:'shanghai',nativeAddressContextHeight:2});
writeFileSync(process.argv[2],JSON.stringify({source,compiler:solc.version(),activationHeight:2,selector:toFunctionSelector('invoke(bytes)'),pokeSelector:toFunctionSelector('poke()'),staticSelector:toFunctionSelector('invokeStatic(bytes)'),delegateSelector:toFunctionSelector('invokeDelegate(bytes)'),readSelector:toFunctionSelector('read()'),artifact},null,2)+'\n');
