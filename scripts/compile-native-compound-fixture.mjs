import {compileSolidity} from '../dist/contracts-compiler.js';
import {writeFileSync} from 'node:fs';
import {toFunctionSelector} from 'viem';
import solc from 'solc';
if (!process.argv[2]) throw new Error('usage: node scripts/compile-native-compound-fixture.mjs <output.json>');
const source='pragma solidity ^0.8.20; contract NativeCompound { function inspect() external payable returns(uint256,bytes32,bytes memory) {return(address(this).balance,address(this).codehash,address(this).code);} }';
const artifact=await compileSolidity({sources:[{path:'NativeCompound.sol',content:source}],contractName:'NativeCompound',target:'pqvm',evmVersion:'shanghai',nativeAddressContextHeight:2});
writeFileSync(process.argv[2],JSON.stringify({source,compiler:solc.version(),activationHeight:2,selector:toFunctionSelector('inspect()'),artifact},null,2)+'\n');
