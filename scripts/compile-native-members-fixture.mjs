import {compileSolidity} from '../dist/contracts-compiler.js';
import {writeFileSync} from 'node:fs';
import {toFunctionSelector} from 'viem';
import solc from 'solc';
if (!process.argv[2]) throw new Error('usage: node scripts/compile-native-members-fixture.mjs <output.json>');
const source='pragma solidity ^0.8.20; contract NativeMembers { function inspect(address target) external view returns(uint256,bytes32,bytes memory) {return(target.balance,target.codehash,target.code);} }';
const artifact=await compileSolidity({sources:[{path:'NativeMembers.sol',content:source}],contractName:'NativeMembers',target:'pqvm',evmVersion:'shanghai',nativeAddressContextHeight:2});
writeFileSync(process.argv[2],JSON.stringify({source,compiler:solc.version(),activationHeight:2,selector:toFunctionSelector('inspect(address)'),artifact},null,2)+'\n');
