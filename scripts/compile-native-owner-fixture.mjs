import {compileSolidity} from '../dist/contracts-compiler.js';
import {writeFileSync} from 'node:fs';
import {toFunctionSelector} from 'viem';
import solc from 'solc';
if (!process.argv[2]) throw new Error('usage: node scripts/compile-native-owner-fixture.mjs <output.json> [address|bytes32] [struct]');
const resultType=process.argv[3] ?? 'address';
if (!['address','bytes32'].includes(resultType)) throw new Error('result type must be address or bytes32');
if (process.argv[4] && process.argv[4] !== 'struct') throw new Error('receiver option must be struct');
if (process.argv[4] === 'struct') {
  if (resultType !== 'bytes32') throw new Error('struct receiver fixture requires bytes32 results');
  const original='pragma solidity ^0.8.35; interface I {function ownerOf(uint256 id) external view returns(bytes32);} contract Ledger { struct Entry {address owner;} mapping(uint256=>Entry) private entries; function set(uint256 id,address owner) external {entries[id].owner=owner;} function lookup(uint256 id) external view returns(bytes32) {return I(entries[id].owner).ownerOf(type(uint256).max);} }';
  const selecting=original.replace('contract Ledger','contract SelectingLedger').replace('function lookup(uint256 id) external view', 'uint256 public selections; function select(uint256 id) internal returns(uint256) {selections++; return id;} function lookup(uint256 id) external').replace('I(entries[id].owner)', 'I(entries[select(id)].owner)').replace('} }','} function denied(uint256 id) external returns(bytes32) {return I(entries[select(id)].owner).ownerOf(0);} }');
  const owner='pragma solidity ^0.8.35; contract Owner {bytes32 public owner; error Missing(uint256 id); function ownerOf(uint256 id) external view returns(bytes32) {if(id!=type(uint256).max) revert Missing(id); return owner;}}';
  const writer='pragma solidity ^0.8.35; contract Writer {function ownerOf(uint256 id) external returns(bytes32) {assembly {sstore(0,id)} return bytes32(0);}}';
  const sources={Ledger:original,SelectingLedger:selecting,Owner:owner,Writer:writer};
  const artifacts={};
  for(const [contractName,content] of Object.entries(sources)) {
    artifacts[contractName]=await compileSolidity({sources:[{path:`${contractName}.sol`,content}],contractName,target:contractName==='Writer'?'evm':'pqvm',evmVersion:'shanghai',...(contractName==='Writer'?{}:{nativeAddressContextHeight:2})});
  }
  const signatures=['set(uint256,address)','lookup(uint256)','denied(uint256)','ownerOf(uint256)','Missing(uint256)'];
  writeFileSync(process.argv[2],JSON.stringify({sources,compiler:solc.version(),activationHeight:2,selectors:Object.fromEntries(signatures.map(signature=>[signature,toFunctionSelector(signature)])),artifacts},null,2)+'\n');
  process.exit(0);
}
const source='pragma solidity ^0.8.20; interface I {function ownerOf(uint256 tokenId) external view returns(address);} contract Reader {uint256 public selections; function lookup(address target,uint256 tokenId) external returns(address){selections++;return I(target).ownerOf(tokenId);}} contract Owner {address public owner; error Missing(uint256 tokenId); function ownerOf(uint256 tokenId) external view returns(address){if(tokenId!=type(uint256).max)revert Missing(tokenId);return owner;}} contract Writer {function ownerOf(uint256 tokenId) external returns(address){assembly {sstore(0,tokenId)}return address(0);}}'.replaceAll('returns(address)', `returns(${resultType})`).replace('address public owner', `${resultType} public owner`).replace('return address(0)', `return ${resultType}(0)`);
// Writer intentionally violates I's view promise to exercise STATICCALL rejection.
const artifacts={};
for(const contractName of ['Reader','Owner']) artifacts[contractName]=await compileSolidity({sources:[{path:'Owner.sol',content:source.replace(/ contract Writer.*$/,'')}],contractName,target:'pqvm',evmVersion:'shanghai',nativeAddressContextHeight:2});
artifacts.Writer=await compileSolidity({sources:[{path:'Writer.sol',content:'pragma solidity ^0.8.20; contract Writer {function ownerOf(uint256 tokenId) external returns(address){assembly {sstore(0,tokenId)}return address(0);}}'.replaceAll('returns(address)', `returns(${resultType})`).replace('return address(0)', `return ${resultType}(0)`)}],contractName:'Writer',target:'evm',evmVersion:'shanghai'});
writeFileSync(process.argv[2],JSON.stringify({source,compiler:solc.version(),activationHeight:2,selectors:Object.fromEntries(['lookup(address,uint256)','ownerOf(uint256)','Missing(uint256)'].map(signature=>[signature,toFunctionSelector(signature)])),artifacts},null,2)+'\n');
