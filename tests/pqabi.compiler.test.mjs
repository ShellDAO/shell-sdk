import test from 'node:test';
import assert from 'node:assert/strict';
import solc from 'solc';
import { compileSolidity } from '../dist/contracts-compiler.js';

const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract AddressRoundtrip {
  address public stored;
  constructor(address value) { stored = value; }
  function echo(address value) external pure returns(address) { return value; }
  function store(address value) external { stored = value; }
}`;
const options = { sources: [{path:'AddressRoundtrip.sol',content:source}], contractName:'AddressRoundtrip', evmVersion:'shanghai' };
const first = '34'.repeat(12) + '12'.repeat(20);
const second = '56'.repeat(12) + '12'.repeat(20);

test('PQABI target retains original ABI types and selector dispatch', async () => {
  const original = await compileSolidity(options);
  const native = await compileSolidity({...options,target:'pqvm'});
  assert.deepEqual(native.abi, original.abi);
  for (const selector of ['2ffdbf1a','9e39db73','e582dd31']) {
    assert.ok(native.deployedBytecode.includes(selector));
  }
  assert.notEqual(native.bytecode,original.bytecode);
});

test('PQABI target rejects context, assembly and payable address instead of narrowing', async () => {
  for (const body of [
    'function caller() external view returns(address) { return msg.sender; }',
    'function raw() external { assembly { stop() } }',
    'address payable public owner;',
  ]) {
    await assert.rejects(compileSolidity({sources:[{path:'Unsupported.sol',content:`pragma solidity ^0.8.20; contract Unsupported { address stored; ${body} }`}],contractName:'Unsupported',target:'pqvm'}),/does not yet support/);
  }
});

test('AST lowering leaves address text in comments and strings unchanged', async () => {
  await compileSolidity({sources:[{path:'Text.sol',content:'pragma solidity ^0.8.20; contract Text { /* address */ address public stored; string public text = "address"; }'}],contractName:'Text',target:'pqvm'});
});

// Optional real-node acceptance uses only eth_call: child accounts/storage exist
// inside the simulation and are discarded afterward. No funded account required.
test('PQABI real VM: full-word echo, constructor storage, update, and rejected malformed write', {skip: !process.env.SHELL_PQABI_RPC_URL}, async () => {
  for (const target of ['evm','pqvm']) {
    const artifact = await compileSolidity({...options,target});
    const bytecode = artifact.bytecode.slice(2)+first;
const harness=`object "Probe" { code {
 datacopy(0,dataoffset("child"),datasize("child"))
 let child := create(0,0,datasize("child"))
 if iszero(child) { revert(0,0) }
 // Original selectors: echo(address), store(address), stored().
 mstore(0,shl(224,0x2ffdbf1a)) mstore(4,0x${first})
 if iszero(call(gas(),child,0,0,36,128,32)) { revert(0,0) }
 if iszero(eq(mload(128),0x${first})) { revert(0,0) }
 mstore(0,shl(224,0xe582dd31))
 if iszero(staticcall(gas(),child,0,4,160,32)) { revert(0,0) }
 if iszero(eq(mload(160),0x${first})) { revert(0,0) }
 mstore(0,shl(224,0x9e39db73)) mstore(4,0x${second})
 if iszero(call(gas(),child,0,0,36,0,0)) { revert(0,0) }
 mstore(0,shl(224,0xe582dd31))
 if iszero(staticcall(gas(),child,0,4,192,32)) { revert(0,0) }
 if iszero(eq(mload(192),0x${second})) { revert(0,0) }
 mstore(0,shl(224,0x9e39db73)) mstore(4,0x${first})
 if call(gas(),child,0,0,35,0,0) { revert(0,0) }
 mstore(0,shl(224,0xe582dd31))
 if iszero(staticcall(gas(),child,0,4,224,32)) { revert(0,0) }
 if iszero(eq(mload(224),0x${second})) { revert(0,0) }
 return(128,128)
 } data "child" hex"${bytecode}" }`;
    const output = JSON.parse(solc.compile(JSON.stringify({language:'Yul',sources:{'Probe.yul':{content:harness}},settings:{evmVersion:'shanghai',outputSelection:{'*':{'*':['evm.bytecode.object']}}}})));
    assert.equal(output.errors?.filter(e=>e.severity==='error').length ?? 0,0);
    const data = '0x'+output.contracts['Probe.yul'].Probe.evm.bytecode.object;
    const response = await fetch(process.env.SHELL_PQABI_RPC_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{data,gas:'0x989680'},'latest']}),signal:AbortSignal.timeout(30000)});
    assert.ok(response.ok);
    const result=await response.json();
    assert.equal(result.result,target==='pqvm'?'0x'+first+first+second+second:'0x');
  }
});
