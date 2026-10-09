import test from 'node:test';
import assert from 'node:assert/strict';
import solc from 'solc';
import { keccak256, stringToHex, toFunctionSelector } from 'viem';
import { compileSolidity } from '../dist/contracts-compiler.js';

const source = `pragma solidity ^0.8.20;
contract Events {
  address public stored;
  event Changed(address indexed previous,address current);
  event Anonymous(address indexed previous,address current) anonymous;
  error Denied(address value);
  constructor(address value) {stored=value; emit Changed(address(0),value);}
  function store(address value) external {
    address previous=stored; stored=value; emit Changed(previous,value); emit Anonymous(previous,value);
  }
  function reject(address value) external {stored=value; emit Changed(value,value); revert Denied(value);}
}`;
const options = {sources:[{path:'Events.sol',content:source}],contractName:'Events',target:'pqvm',evmVersion:'shanghai'};

test('PQABI keeps original event topics and custom-error selectors', async () => {
  const artifact = await compileSolidity(options);
  assert.ok(artifact.bytecode.includes(keccak256(stringToHex('Changed(address,address)')).slice(2)));
  assert.ok(artifact.deployedBytecode.includes(toFunctionSelector('Denied(address)').slice(2)));
  assert.equal(artifact.abi.find(entry=>entry.type==='event'&&entry.name==='Anonymous').anonymous,true);
  assert.deepEqual(artifact.abi.find(entry=>entry.type==='error').inputs.map(p=>p.type),['address']);
});

test('PQABI signature restoration does not change equal user constants', async () => {
  const topic = keccak256(stringToHex('Changed(uint256,uint256)'));
  const errorWord = toFunctionSelector('Denied(uint256)')+'00'.repeat(28);
  const withConstants=source.replace('address public stored;',`address public stored; function constants() external pure returns(uint256,uint256) {return (${topic},${errorWord});}`);
  const artifact=await compileSolidity({...options,sources:[{path:'Events.sol',content:withConstants}]});
  assert.ok(artifact.deployedBytecode.includes(topic.slice(2)));
  assert.deepEqual(artifact.abi.find(entry=>entry.name==='constants').outputs.map(p=>p.type),['uint256','uint256']);
});

test('PQABI restores inherited signatures with optimizer disabled', async () => {
  const inherited='pragma solidity ^0.8.20; /* 地址 address */ contract Base { event Changed(address value); error Denied(address value); } contract Events is Base { constructor(address value) {emit Changed(value);} function reject(address value) external pure {revert Denied(value);} }';
  const artifact=await compileSolidity({...options,optimizer:{enabled:false},sources:[{path:'Events.sol',content:inherited}]});
  assert.ok(artifact.bytecode.includes(keccak256(stringToHex('Changed(address)')).slice(2)));
  assert.ok(artifact.deployedBytecode.includes(toFunctionSelector('Denied(address)').slice(2)));
});

test('PQABI supports custom-error require with original selectors', async () => {
  for (const optimizer of [{enabled:true,runs:200}, {enabled:false,runs:200}]) {
    const compiled = await compileSolidity({...options, optimizer, sources:[{path:'Events.sol', content:
      'pragma solidity ^0.8.26; contract Base { error Denied(address value); } contract Events is Base { address public stored; function check(bool okay,address value) external { stored=value; require(okay,Denied(value)); } function again(bool okay,address value) external pure { require(okay,Denied(value)); } }'}]});
    assert.ok(compiled.deployedBytecode.includes(toFunctionSelector('check(bool,address)').slice(2)));
    assert.ok(compiled.deployedBytecode.includes(toFunctionSelector('Denied(address)').slice(2)));
    assert.equal(compiled.abi.find(entry=>entry.type==='error').inputs[0].type, 'address');
  }
});

for (const requireError of [false, true]) test(`PQABI real VM ${requireError ? 'require' : 'revert'} custom error preserves full address and rolls back preceding store`, {skip:!process.env.SHELL_PQABI_RPC_URL}, async () => {
  const topic=keccak256(stringToHex('Changed(uint256,uint256)'));
  const errorWord=toFunctionSelector('Denied(uint256)')+'00'.repeat(28);
  const withConstants=source.replace('^0.8.20', '^0.8.26').replace('revert Denied(value);', requireError ? 'require(false,Denied(value));' : 'revert Denied(value);').replace('address public stored;',`address public stored; function constants() external pure returns(uint256,uint256) {return (${topic},${errorWord});} function accept(address value) external {stored=value; require(true,Denied(value));}`);
  const artifact = await compileSolidity({...options,sources:[{path:'Events.sol',content:withConstants}]});
  const first='34'.repeat(12)+'12'.repeat(20), second='56'.repeat(12)+'12'.repeat(20);
  const selector=toFunctionSelector('Denied(address)').slice(2);
  const reject=toFunctionSelector('reject(address)').slice(2);
  const getter=toFunctionSelector('stored()').slice(2);
  const constants=toFunctionSelector('constants()').slice(2);
  const accept=toFunctionSelector('accept(address)').slice(2);
  const harness=`object "Probe" { code {
    datacopy(0,dataoffset("child"),datasize("child"))
    let child:=create(0,0,datasize("child")) if iszero(child) {revert(0,0)}
    mstore(0,shl(224,0x${reject})) mstore(4,0x${second})
    if call(gas(),child,0,0,36,0,0) {revert(0,0)}
    if iszero(eq(returndatasize(),36)) {revert(0,0)}
    returndatacopy(128,0,36)
    if iszero(eq(shr(224,mload(128)),0x${selector})) {revert(0,0)}
    if iszero(eq(mload(132),0x${second})) {revert(0,0)}
    mstore(164,0)
    mstore(0,shl(224,0x${getter}))
    if iszero(staticcall(gas(),child,0,4,192,32)) {revert(0,0)}
    if iszero(eq(mload(192),0x${first})) {revert(0,0)}
    mstore(0,shl(224,0x${constants}))
    if iszero(staticcall(gas(),child,0,4,224,64)) {revert(0,0)}
    mstore(0,shl(224,0x${accept})) mstore(4,0x${second})
    if iszero(call(gas(),child,0,0,36,0,0)) {revert(0,0)}
    mstore(0,shl(224,0x${getter}))
    if iszero(staticcall(gas(),child,0,4,320,32)) {revert(0,0)}
    if iszero(eq(mload(320),0x${second})) {revert(0,0)}
    return(128,160)
  } data "child" hex"${artifact.bytecode.slice(2)+first}" }`;
  const output=JSON.parse(solc.compile(JSON.stringify({language:'Yul',sources:{'Probe.yul':{content:harness}},settings:{evmVersion:'shanghai',outputSelection:{'*':{'*':['evm.bytecode.object']}}}})));
  assert.equal(output.errors?.filter(e=>e.severity==='error').length??0,0);
  const response=await fetch(process.env.SHELL_PQABI_RPC_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{data:'0x'+output.contracts['Probe.yul'].Probe.evm.bytecode.object,gas:'0x989680'},'latest']}),signal:AbortSignal.timeout(30000)});
  assert.ok(response.ok);const result=await response.json();
  assert.equal(result.result,'0x'+selector+second+'00'.repeat(28)+first+topic.slice(2)+errorWord.slice(2));
});
