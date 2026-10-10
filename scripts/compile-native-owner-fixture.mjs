import {compileSolidity} from '../dist/contracts-compiler.js';
import {writeFileSync} from 'node:fs';
import {toFunctionSelector} from 'viem';
import solc from 'solc';
if (!process.argv[2]) throw new Error('usage: node scripts/compile-native-owner-fixture.mjs <output.json>');
const source='pragma solidity ^0.8.20; interface I {function ownerOf(uint256 tokenId) external view returns(address);} contract Reader {uint256 public selections; function lookup(address target,uint256 tokenId) external returns(address){selections++;return I(target).ownerOf(tokenId);}} contract Owner {address public owner; error Missing(uint256 tokenId); function ownerOf(uint256 tokenId) external view returns(address){if(tokenId!=0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff)revert Missing(tokenId);return owner;}} contract Writer {function ownerOf(uint256 tokenId) external returns(address){assembly {sstore(0,tokenId)}return address(0);}}';
// Writer intentionally violates I's view promise to exercise STATICCALL rejection.
const artifacts={};
for(const contractName of ['Reader','Owner']) artifacts[contractName]=await compileSolidity({sources:[{path:'Owner.sol',content:source.replace(/ contract Writer.*$/,'')}],contractName,target:'pqvm',evmVersion:'shanghai',nativeAddressContextHeight:2});
artifacts.Writer=await compileSolidity({sources:[{path:'Writer.sol',content:'pragma solidity ^0.8.20; contract Writer {function ownerOf(uint256 tokenId) external returns(address){assembly {sstore(0,tokenId)}return address(0);}}'}],contractName:'Writer',target:'evm',evmVersion:'shanghai'});
writeFileSync(process.argv[2],JSON.stringify({source,compiler:solc.version(),activationHeight:2,selectors:Object.fromEntries(['lookup(address,uint256)','ownerOf(uint256)','Missing(uint256)'].map(signature=>[signature,toFunctionSelector(signature)])),artifacts},null,2)+'\n');
