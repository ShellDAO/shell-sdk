import {compileSolidity} from '../dist/contracts-compiler.js';
import {writeFileSync} from 'node:fs';
import {toFunctionSelector} from 'viem';
import solc from 'solc';
if (!process.argv[2]) throw new Error('usage: node scripts/compile-native-typed-call-fixture.mjs <output.json>');
const source='pragma solidity ^0.8.20; interface I {function echo(address value) external returns(address);} interface IV {function echo(address value) external view returns(address);} contract Typed {uint256 public selections; function invoke(address target,address value) external returns(address){selections++;return I(target).echo(value);} function inspect(address target,address value) external view returns(address){return IV(target).echo(value);}} contract Echo {address public last; error Denied(address value); function echo(address value) external returns(address){last=value;if(value==address(0))revert Denied(value);return value;}}';
const artifacts={};
for(const contractName of ['Typed','Echo']) artifacts[contractName]=await compileSolidity({sources:[{path:'Typed.sol',content:source}],contractName,target:'pqvm',evmVersion:'shanghai',nativeAddressContextHeight:2});
writeFileSync(process.argv[2],JSON.stringify({source,compiler:solc.version(),activationHeight:2,selectors:Object.fromEntries(['invoke(address,address)','inspect(address,address)','Denied(address)'].map(signature=>[signature,toFunctionSelector(signature)])),artifacts},null,2)+'\n');
