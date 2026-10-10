import { compileSolidity } from '../dist/contracts-compiler.js';
import { writeFileSync } from 'node:fs';
import { toFunctionSelector } from 'viem';
import solc from 'solc';

if (!process.argv[2]) throw new Error('usage: node scripts/compile-native-context-fixture.mjs <output.json>');
const source = `pragma solidity ^0.8.20; contract NativeContext { address public stored; function read() external returns(address,address,address,address) { stored = msg.sender; return(msg.sender,tx.origin,block.coinbase,address(this)); } }`;
const options = {sources:[{path:'NativeContext.sol',content:source}],contractName:'NativeContext',target:'pqvm',evmVersion:'shanghai',nativeAddressContextHeight:2};
const artifact = await compileSolidity(options);
writeFileSync(process.argv[2], JSON.stringify({source,activationHeight:2,compiler:solc.version(),selector:toFunctionSelector('read()'),artifact},null,2)+'\n');
