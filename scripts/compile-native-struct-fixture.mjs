import {compileSolidity} from '../dist/contracts-compiler.js';
import {writeFileSync} from 'node:fs';
import {toFunctionSelector} from 'viem';
import solc from 'solc';

if (!process.argv[2]) throw new Error('usage: node scripts/compile-native-struct-fixture.mjs <output.json>');
const sources={
  original:'pragma solidity ^0.8.35; contract Ledger { struct Entry { address owner; uint256 amount; } mapping(uint256 => Entry) private entries; function set(uint256 id, address owner, uint256 amount) external { entries[id] = Entry(owner, amount); } function get(uint256 id) external view returns (address, uint256) { return (entries[id].owner, entries[id].amount); } }',
  nested:`pragma solidity ^0.8.35;
contract Ledger {
  struct Entry {address owner; uint96 amount;}
  struct Book {Entry entry; address backup;}
  mapping(uint256 => Book) private entries;
  function set(uint256 id,address owner,uint96 amount,address backup) external {
    entries[id] = Book(Entry(owner,amount),backup);
  }
  function update(uint256 id,address owner,uint96 amount) external {
    Entry storage entry=entries[id].entry; entry.owner=owner; entry.amount=amount;
  }
  function get(uint256 id) external view returns(address,uint96,address) {
    Book memory book=entries[id]; return(book.entry.owner,book.entry.amount,book.backup);
  }
}`,
};
const artifacts={};
for(const [name,content] of Object.entries(sources)) {
  artifacts[name]=await compileSolidity({sources:[{path:'Ledger.sol',content}],contractName:'Ledger',target:'pqvm',evmVersion:'shanghai'});
}
const signatures=['set(uint256,address,uint256)','set(uint256,address,uint96,address)','update(uint256,address,uint96)','get(uint256)'];
writeFileSync(process.argv[2],JSON.stringify({sources,compiler:solc.version(),selectors:Object.fromEntries(signatures.map(signature=>[signature,toFunctionSelector(signature)])),artifacts},null,2)+'\n');
