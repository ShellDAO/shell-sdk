import test from 'node:test';
import assert from 'node:assert/strict';
import solc from 'solc';
import { compileSolidity } from '../dist/contracts-compiler.js';
import { encodeFunctionData, decodeFunctionResult } from '../dist/contracts.js';

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


test('native context builtins require explicit activation and retain the public ABI', async () => {
  const content = `pragma solidity ^0.8.20; contract Context { address public owner; function read() external returns(address,address,address,address) { owner=msg.sender; return(msg.sender,tx.origin,block.coinbase,address(this)); } }`;
  const options = {sources:[{path:'Context.sol',content}],contractName:'Context',target:'pqvm',evmVersion:'shanghai'};
  await assert.rejects(compileSolidity(options), /nativeAddressContextHeight/);
  for (const height of [-1, 1.5, Number.MAX_SAFE_INTEGER+1, NaN]) {
    await assert.rejects(compileSolidity({...options,nativeAddressContextHeight:height}), /nonnegative safe integer/);
  }
  const native = await compileSolidity({...options,nativeAddressContextHeight:2});
  const original = await compileSolidity({...options,target:'evm'});
  assert.deepEqual(native.abi, original.abi);
  assert.notEqual(native.deployedBytecode, original.deployedBytecode);
  // Builtins must be detected even when the source spells no address type.
  await assert.rejects(compileSolidity({sources:[{path:'OnlyContext.sol',content:'pragma solidity ^0.8.20; contract OnlyContext { function equal() external view returns(bool) {return msg.sender == tx.origin;} }'}],contractName:'OnlyContext',target:'pqvm'}), /nativeAddressContextHeight/);
  await compileSolidity({sources:[{path:'OnlyContext.sol',content:'pragma solidity ^0.8.20; contract OnlyContext { function equal() external view returns(bool) {return msg.sender == tx.origin;} }'}],contractName:'OnlyContext',target:'pqvm',nativeAddressContextHeight:2});
  await assert.rejects(compileSolidity({...options,sources:[{path:'Context.sol',content:content+' function _pc0() pure returns(uint256) {return 1;}'}],nativeAddressContextHeight:2}), /helper name conflicts/);
});


test('native address variable introspection compiles with the explicit profile', async () => {
  const source = 'pragma solidity ^0.8.20; contract NativeMembers { function inspect(address target) external view returns(uint256,bytes32,bytes memory) {return(target.balance,target.codehash,target.code);} }';
  const options = {sources:[{path:'NativeMembers.sol',content:source}],contractName:'NativeMembers',target:'pqvm'};
  await assert.rejects(compileSolidity(options), /nativeAddressContextHeight/);
  const native = await compileSolidity({...options,nativeAddressContextHeight:2});
  const original = await compileSolidity({...options,target:'evm'});
  assert.deepEqual(native.abi, original.abi);
  await assert.rejects(compileSolidity({...options,sources:[{path:'NativeMembers.sol',content:source.replace('target.balance','getTarget().balance').replace('function inspect', 'function getTarget() internal view returns(address) {return msg.sender;} function inspect')}],nativeAddressContextHeight:2}), /does not yet support/);
});


test('native context introspection preserves compound receivers and ABI', async () => {
  const source = 'pragma solidity ^0.8.20; contract NativeCompound { function inspect() external view returns(uint256,bytes32,bytes memory) {return(address(this).balance,msg.sender.codehash,msg.sender.code);} }';
  const options = {sources:[{path:'NativeCompound.sol',content:source}],contractName:'NativeCompound',target:'pqvm'};
  await assert.rejects(compileSolidity(options), /nativeAddressContextHeight/);
  const native = await compileSolidity({...options,nativeAddressContextHeight:2});
  const original = await compileSolidity({...options,target:'evm'});
  assert.deepEqual(native.abi,original.abi);
  for (const receiver of ['address(this)', 'msg.sender', 'tx.origin', 'block.coinbase']) {
    await compileSolidity({...options,sources:[{path:'NativeCompound.sol',content:source.replaceAll('address(this)',receiver).replaceAll('msg.sender',receiver)}],nativeAddressContextHeight:2});
  }
});


test('native low-level call retains full address ABI and explicit activation', async () => {
 const source='pragma solidity ^0.8.20; contract NativeCall { function invoke(address target, bytes memory data, uint256 value) external payable returns(bool,bytes memory) {return target.call{value:value}(data);} }';
 const options={sources:[{path:'NativeCall.sol',content:source}],contractName:'NativeCall',target:'pqvm'};
 await assert.rejects(compileSolidity(options),/nativeAddressContextHeight/);
 const native=await compileSolidity({...options,nativeAddressContextHeight:2});
 const evm=await compileSolidity({...options,target:'evm'});assert.deepEqual(native.abi,evm.abi);
 await compileSolidity({...options,sources:[{path:'NativeCall.sol',content:source.replace('{value:value}','')}],nativeAddressContextHeight:2});
 await compileSolidity({...options,sources:[{path:'NativeCall.sol',content:source.replace('value:value','gas:value')}],nativeAddressContextHeight:2});
});


test('native static and delegate calls keep ABI, mode and activation', async () => {
 for(const mode of ['staticcall','delegatecall']) {
  const source=`pragma solidity ^0.8.20; contract NativeModes { function invoke(address target, bytes memory data) external ${mode==='staticcall'?'view':'payable'} returns(bool,bytes memory) {return target.${mode}(data);} }`;
  const options={sources:[{path:'NativeModes.sol',content:source}],contractName:'NativeModes',target:'pqvm'};
  await assert.rejects(compileSolidity(options),/nativeAddressContextHeight/);
  const native=await compileSolidity({...options,nativeAddressContextHeight:2});
  const evm=await compileSolidity({...options,target:'evm'});assert.deepEqual(native.abi,evm.abi);
  await assert.rejects(compileSolidity({...options,sources:[{path:'NativeModes.sol',content:source.replace(`target.${mode}(data)`,`target.${mode}(abi.encode(target))`)}],nativeAddressContextHeight:2}),/address and bytes variables/);
 }
});


test('native low-level calls accept full-word context receivers', async () => {
 for(const receiver of ['address(this)','msg.sender','tx.origin','block.coinbase']) {
  for(const mode of ['call','staticcall','delegatecall']) {
   const source=`pragma solidity ^0.8.20; contract ContextCall { function invoke(bytes memory data) external returns(bool,bytes memory) {return ${receiver}.${mode}(data);} }`;
   const options={sources:[{path:'ContextCall.sol',content:source}],contractName:'ContextCall',target:'pqvm'};
   await assert.rejects(compileSolidity(options),/nativeAddressContextHeight/);
   const native=await compileSolidity({...options,nativeAddressContextHeight:2});
   const evm=await compileSolidity({...options,target:'evm'});assert.deepEqual(native.abi,evm.abi);
  }
 }
});


test('native call evaluates an internal address receiver once without narrowing', async () => {
 const source='pragma solidity ^0.8.20; contract NativeFunctionReceiver { address private target; uint256 public selections; function choose() internal returns(address) {selections+=1; return target;} function invoke(bytes memory data) external returns(bool,bytes memory) {return choose().call(data);} }';
 const options={sources:[{path:'NativeFunctionReceiver.sol',content:source}],contractName:'NativeFunctionReceiver',target:'pqvm'};
 await assert.rejects(compileSolidity(options),/nativeAddressContextHeight/);
 const native=await compileSolidity({...options,nativeAddressContextHeight:2});const evm=await compileSolidity({...options,target:'evm'});assert.deepEqual(native.abi,evm.abi);
 for (const argument of ['1', 'count']) {
  await compileSolidity({...options,sources:[{path:'NativeFunctionReceiver.sol',content:source.replace('choose() internal','choose(uint256 n) internal').replace('invoke(bytes memory data)', 'invoke(bytes memory data,uint256 count)').replace('choose().call',`choose(${argument}).call`)}],nativeAddressContextHeight:2});
 }
 await assert.rejects(compileSolidity({...options,sources:[{path:'NativeFunctionReceiver.sol',content:source.replace('choose() internal','choose(uint256 n) internal').replace('choose().call','choose(1+2).call')}],nativeAddressContextHeight:2}),/does not yet support/);
});


test('native function literal arguments preserve UTF-8 signature source ranges', async () => {
 const source='pragma solidity ^0.8.20; contract Receiver {address private target; function choose(string memory value) internal view returns(address){return target;} function invoke(bytes memory data) external returns(bool,bytes memory){return choose(unicode"地址").call(data);} error Denied(address value); function reject(address value) external pure {revert Denied(value);} }';
 const artifact=await compileSolidity({...options,target:'pqvm',evmVersion:'shanghai',contractName:'Receiver',sources:[{path:'Receiver.sol',content:source}],nativeAddressContextHeight:2});
 assert.deepEqual(artifact.abi.find(entry=>entry.type==='error').inputs.map(entry=>entry.type),['address']);
});


test('typed external address calls preserve the original selector and ABI', async () => {
 const source='pragma solidity ^0.8.20; interface I {function echo(address value) external returns(address);} contract Typed {function invoke(address target,address value) external returns(address){return I(target).echo(value);}}';
 for (const mutability of ['', 'view ', 'pure ']) {
  const artifact=await compileSolidity({...options,target:'pqvm',evmVersion:'shanghai',contractName:'Typed',sources:[{path:'Typed.sol',content:source.replace('external returns(address);', `external ${mutability}returns(address);`)}],nativeAddressContextHeight:2});
  assert.deepEqual(artifact.abi.find(entry=>entry.name==='invoke').inputs.map(entry=>entry.type),['address','address']);
  const original=await compileSolidity({...options,target:'evm',contractName:'Typed',sources:[{path:'Typed.sol',content:source.replace('external returns(address);', `external ${mutability}returns(address);`)}]});
  assert.deepEqual(artifact.abi,original.abi);
 }
 await assert.rejects(compileSolidity({...options,target:'pqvm',contractName:'Typed',sources:[{path:'Typed.sol',content:source}]}),/typed call requires nativeAddressContextHeight/);
});


const payableSource = `pragma solidity ^0.8.30;
interface IPay { function pay(address owner) external payable returns(address); }
contract PayableReader {
 struct Entry { address target; address owner; uint256 amount; }
 mapping(uint256 => Entry) entries;
 function invoke(address target, address owner, uint256 amount) external payable returns(address) {
  return IPay(target).pay{value:amount}(owner);
 }
 function plain(address target, address owner) external returns(address) { return IPay(target).pay(owner); }
 function stored(uint256 id) external returns(address) {
  return IPay(entries[id].target).pay{value:entries[id].amount}(entries[id].owner);
 }
}`;

test('typed payable calls preserve original ABI with value and plain calls to the same declaration', async () => {
 for (const input of ['address','uint256']) for (const result of ['address','bytes32','uint256']) {
  const content=payableSource.replaceAll('returns(address)',`returns(${result})`).replaceAll('address owner',`${input} owner`);
  const args={sources:[{path:'Payable.sol',content}],contractName:'PayableReader',evmVersion:'shanghai'};
  const original=await compileSolidity(args);
  const native=await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2});
  assert.deepEqual(native.abi,original.abi);
  await assert.rejects(compileSolidity({...args,target:'pqvm'}),/typed call requires nativeAddressContextHeight/);
 }
 const args={sources:[{path:'Payable.sol',content:payableSource}],contractName:'PayableReader',target:'pqvm',nativeAddressContextHeight:2};
 for(const value of ['0','type(uint256).max']) {
  await compileSolidity({...args,sources:[{path:'Payable.sol',content:payableSource.replace('value:amount',`value:${value}`)}]});
 }
 for(const option of ['gas:amount','value:amount,gas:100000','gas:100000,value:amount']) {
  const content=payableSource.replace('value:amount',option);
  const native=await compileSolidity({...args,sources:[{path:'Payable.sol',content}]});
  assert.deepEqual(native.abi,(await compileSolidity({...args,target:'evm',nativeAddressContextHeight:undefined,sources:[{path:'Payable.sol',content}]})).abi);
 }
 await assert.rejects(compileSolidity({...args,sources:[{path:'Payable.sol',content:payableSource.replace('external payable returns(address);','external returns(address);')}]}),/non-payable|payable/);
});


test('native gas options preserve CALL STATICCALL DELEGATECALL ABI and reject complex option expressions', async () => {
 for(const mode of ['call','staticcall','delegatecall']) {
  const source=`pragma solidity ^0.8.30; contract Gas { function invoke(address target,bytes memory data,uint256 budget) external ${mode==='staticcall'?'view':''} returns(bool,bytes memory) {return target.${mode}{gas:budget}(data);} }`;
  const args={sources:[{path:'Gas.sol',content:source}],contractName:'Gas',evmVersion:'shanghai'};
  const native=await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2});
  assert.deepEqual(native.abi,(await compileSolidity(args)).abi);
  await assert.rejects(compileSolidity({...args,target:'pqvm'}),/nativeAddressContextHeight/);
  for(const gas of ['0','type(uint256).max']) await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2,sources:[{path:'Gas.sol',content:source.replace('gas:budget',`gas:${gas}`)}]});
  await assert.rejects(compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2,sources:[{path:'Gas.sol',content:source.replace('gas:budget','gas:gasleft()')}]}),/optional simple value\/gas/);
 }
 const content=payableSource.replace('value:amount','value:amount,gas:amount');
 const args={sources:[{path:'Payable.sol',content}],contractName:'PayableReader',target:'pqvm',nativeAddressContextHeight:2};
 await compileSolidity({...args,sources:[{path:'Payable.sol',content:content.replaceAll('value:entries[id].amount','value:entries[id].amount,gas:entries[id].amount')}]});
 await assert.rejects(compileSolidity({...args,sources:[{path:'Payable.sol',content:content.replace('gas:amount','gas:gasleft()')}]}),/typed call options/);
});


test('nested native context survives typed struct receivers, arguments and call options', async () => {
 const source=`pragma solidity ^0.8.30;
 interface I {function pay(address owner) external payable returns(address);}
 contract Reader {
  struct Entry {address target;address owner;uint256 amount;uint256 budget;}
  mapping(address=>Entry) entries;
  function pick(address owner) internal pure returns(address){return owner;}
  function pick(uint256 owner) internal pure returns(uint256){return owner;}
  /* full-width caller 💧 */
  function invoke(address target,bytes memory data) external payable returns(address) {
   (bool success,bytes memory output)=target.call{gas:entries[msg.sender].budget,value:entries[tx.origin].amount}(data);
   require(success);
   return I(entries[pick(msg.sender)].target).pay{value:entries[tx.origin].amount,gas:entries[address(this)].budget}(entries[block.coinbase].owner);
  }
 }`;
 const args={sources:[{path:'Reader.sol',content:source}],contractName:'Reader',evmVersion:'shanghai'};
 const original=await compileSolidity(args);
 const native=await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2});
 assert.deepEqual(native.abi,original.abi);
 await assert.rejects(compileSolidity({...args,target:'pqvm'}),/nativeAddressContextHeight/);
 for(const context of ['msg.sender','tx.origin','block.coinbase','address(this)']) {
  const content=source.replaceAll('pick(msg.sender)',context).replaceAll('entries[msg.sender]',`entries[${context}]`);
  await compileSolidity({...args,sources:[{path:'Reader.sol',content}],target:'pqvm',nativeAddressContextHeight:2});
 }
 await assert.rejects(compileSolidity({...args,sources:[{path:'Reader.sol',content:source.replace('I(entries[pick(msg.sender)].target)','I(entries[pick(true)].target)')}],target:'pqvm',nativeAddressContextHeight:2}),/compile failed|compilation failed/i);
});


test('native typed calls preserve zero/multiple static inputs and bool results', async () => {
 const source=`pragma solidity ^0.8.30;
 interface IAsset {
  function transfer(address recipient,uint256 amount) external returns(bool);
  function totalSupply() external view returns(uint256);
  function allowance(address owner,address spender) external view returns(uint256);
  function check(bytes32 tag,bool enabled) external pure returns(bool);
 }
 contract Reader {
  function send(address token,uint256 amount) external returns(bool){return IAsset(token).transfer(msg.sender,amount);}
  function supply(address token) external view returns(uint256){return IAsset(token).totalSupply();}
  function allowed(address token,address owner,address spender) external view returns(uint256){return IAsset(token).allowance(owner,spender);}
  function tagged(address token,bytes32 tag,bool enabled) external view returns(bool){return IAsset(token).check(tag,enabled);}
 }`;
 const args={sources:[{path:'Reader.sol',content:source}],contractName:'Reader',evmVersion:'shanghai'};
 const original=await compileSolidity(args);
 const native=await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2});
 assert.deepEqual(native.abi,original.abi);
 await assert.rejects(compileSolidity({...args,target:'pqvm'}),/nativeAddressContextHeight/);
 for(const result of ['string memory','uint256[] memory','bytes memory']) {
  await assert.rejects(compileSolidity({...args,sources:[{path:'Reader.sol',content:source.replace('returns(bool);',`returns(${result});`).replace('function send(address token,uint256 amount) external returns(bool)','function send(address token,uint256 amount) external returns('+result+')')}],target:'pqvm',nativeAddressContextHeight:2}),/static address, integer, fixed bytes or bool/);
 }
});


test('native void interface calls preserve empty results, mutability and call options', async () => {
 const source=`pragma solidity ^0.8.30;
 interface INFT {function transferFrom(address from,address to,uint256 id) external;}
 interface IVoid {function touch(address owner,uint256 id) external payable;function ping() external;function checkOwner(address owner,uint256 id) external view;function pureCheck(uint256 value) external pure;}
 contract Reader {
  function deliver(address nft,address recipient,uint256 id) external {INFT(nft).transferFrom(address(this),recipient,id);}
  function valued(address target,address owner,uint256 id,uint256 amount,uint256 budget) external payable {IVoid(target).touch{value:amount,gas:budget}(owner,id);}
  function ping(address target) external {IVoid(target).ping();}
  function read(address target,address owner,uint256 id) external view {IVoid(target).checkOwner{gas:100000}(owner,id);}
  function check(address target,uint256 value) external pure {IVoid(target).pureCheck(value);}
 }`;
 const args={sources:[{path:'Reader.sol',content:source}],contractName:'Reader',evmVersion:'shanghai'};
 const original=await compileSolidity(args);
 const native=await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2});
 assert.deepEqual(native.abi,original.abi);
 assert.equal(native.abi.find(entry=>entry.name==='deliver').outputs.length,0);
 assert.equal(native.abi.find(entry=>entry.name==='check').stateMutability,'pure');
 await assert.rejects(compileSolidity({...args,target:'pqvm'}),/nativeAddressContextHeight/);
});


test('native static return tuples preserve original ABI and mixed field order', async () => {
 const source=`pragma solidity ^0.8.30;
 interface IPosition {
  function snapshot(address owner) external view returns(address,uint256,bool,bytes32);
  function capture(address owner) external payable returns(address,uint256,bool,bytes32);
  function pair() external pure returns(uint256,uint256);
 }
 contract Reader {
  function lookup(address target,address owner) external view returns(address,uint256,bool,bytes32){return IPosition(target).snapshot(owner);}
  function save(address target,address owner,uint256 amount,uint256 budget) external payable returns(address,uint256,bool,bytes32){
   (address who,uint256 size,bool ok,bytes32 tag)=IPosition(target).capture{gas:budget,value:amount}(owner);return(who,size,ok,tag);
  }
  function pair(address target) external pure returns(uint256,uint256){return IPosition(target).pair();}
 }`;
 const args={sources:[{path:'Reader.sol',content:source}],contractName:'Reader',evmVersion:'shanghai'};
 const original=await compileSolidity(args);
 const native=await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2});
 assert.deepEqual(native.abi,original.abi);
 assert.deepEqual(native.abi.find(entry=>entry.name==='lookup').outputs.map(entry=>entry.type),['address','uint256','bool','bytes32']);
 await assert.rejects(compileSolidity({...args,target:'pqvm'}),/nativeAddressContextHeight/);
});

test('typed uint256 input and address result retain the original interface ABI', async () => {
 const source='pragma solidity ^0.8.20; interface I {function ownerOf(uint256 tokenId) external view returns(address);} contract Reader {function lookup(address target,uint256 tokenId) external view returns(address){return I(target).ownerOf(tokenId);} function last(address target) external view returns(address){return I(target).ownerOf(0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff);}}';
 const args={sources:[{path:'Reader.sol',content:source}],contractName:'Reader',evmVersion:'shanghai'};
 const original=await compileSolidity({...args,target:'evm'});
 const native=await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2});
 assert.deepEqual(native.abi,original.abi);
 await assert.rejects(compileSolidity({...args,target:'pqvm'}),/typed call requires nativeAddressContextHeight/);
 const narrow={...args,sources:[{path:'Reader.sol',content:source.replaceAll('uint256 tokenId','uint64 tokenId').replace('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff','1')}]};
 const narrowOriginal=await compileSolidity(narrow);
 const narrowNative=await compileSolidity({...narrow,target:'pqvm',nativeAddressContextHeight:2});
 assert.deepEqual(narrowNative.abi,narrowOriginal.abi);
 assert.equal(narrowNative.abi.find(entry=>entry.name==='lookup').inputs[1].type,'uint64');
});


test('native narrow unsigned interface inputs and return lists retain their widths', async () => {
 const source=`pragma solidity ^0.8.30;
 interface IReserves {
  function getReserves() external view returns(uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast);
  function setReserves(uint112 first,uint112 second,uint32 at) external payable returns(uint112,uint112,uint32);
 }
 contract Reader {
  function read(address target) external view returns(uint112,uint112,uint32){return IReserves(target).getReserves();}
  function write(address target,uint112 a,uint112 b,uint32 at,uint256 amount,uint256 budget) external payable returns(uint112,uint112,uint32){return IReserves(target).setReserves{gas:budget,value:amount}(a,b,at);}
  function limits(address target) external returns(uint112,uint112,uint32){return IReserves(target).setReserves(type(uint112).max,0,type(uint32).max);}
 }`;
 const args={sources:[{path:'Reader.sol',content:source}],contractName:'Reader',evmVersion:'shanghai'};
 const original=await compileSolidity(args);
 const native=await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2});
 assert.deepEqual(native.abi,original.abi);
 assert.deepEqual(native.abi.find(entry=>entry.name==='read').outputs.map(entry=>entry.type),['uint112','uint112','uint32']);
 await assert.rejects(compileSolidity({...args,target:'pqvm'}),/nativeAddressContextHeight/);
});

test('standard block.timestamp remains a scalar read in native source and typed calls', async () => {
 const source=`pragma solidity ^0.8.30;
 interface IClock {function echo(uint256 value) external view returns(uint256);}
 contract Clock {
  uint256 stored;
  function stamp() external {stored=block.timestamp;}
  function time() external view returns(uint256){return block.timestamp;}
  function read(address target) external view returns(uint256){return IClock(target).echo{gas:block.timestamp}(block.timestamp);}
 }`;
 const args={sources:[{path:'Clock.sol',content:source}],contractName:'Clock',evmVersion:'shanghai'};
 const original=await compileSolidity(args);
 const native=await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2});
 assert.deepEqual(native.abi,original.abi);
 const plain={sources:[{path:'Clock.sol',content:'pragma solidity ^0.8.30; contract Clock {function time() external view returns(uint256){return block.timestamp;}}'}],contractName:'Clock',evmVersion:'shanghai'};
 assert.deepEqual((await compileSolidity({...plain,target:'pqvm'})).abi,(await compileSolidity(plain)).abi);
});

test('native signed interfaces retain negative literals, widths and feed result order', async () => {
 const source=`pragma solidity ^0.8.30;
 interface IOracle {
  function latestRoundData() external view returns(uint80,int256,uint256,uint256,uint80);
  function setRound(int256 price,int112 delta,uint80 round) external payable returns(int256,int112,uint80);
  function echo(int112 value) external pure returns(int112);
 }
 contract Reader {
  function latest(address target) external view returns(uint80,int256,uint256,uint256,uint80){return IOracle(target).latestRoundData();}
  function write(address target,int256 price,int112 delta,uint80 round,uint256 amount,uint256 budget) external payable returns(int256,int112,uint80){return IOracle(target).setRound{value:amount,gas:budget}(price,delta,round);}
  function literal(address target) external pure returns(int112){return IOracle(target).echo(-1);}
  function minimum(address target) external pure returns(int112){return IOracle(target).echo(type(int112).min);}
 }`;
 const args={sources:[{path:'Reader.sol',content:source}],contractName:'Reader',evmVersion:'shanghai'};
 const original=await compileSolidity(args);
 const native=await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2});
 assert.deepEqual(native.abi,original.abi);
 assert.deepEqual(native.abi.find(entry=>entry.name==='latest').outputs.map(entry=>entry.type),['uint80','int256','uint256','uint256','uint80']);
 await assert.rejects(compileSolidity({...args,target:'pqvm'}),/nativeAddressContextHeight/);
});

test('native fixed bytes preserve original ABI widths for inputs and results', async () => {
 for(const width of [1,4,16,31,32]) {
  const type=`bytes${width}`;
  const source=`pragma solidity ^0.8.30; interface I {function echo(${type} value) external pure returns(${type});} contract Reader {function read(address target,${type} value) external pure returns(${type}){return I(target).echo(value);}}`;
  const args={sources:[{path:'Reader.sol',content:source}],contractName:'Reader',evmVersion:'shanghai'};
  const original=await compileSolidity(args);
  const native=await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2});
  assert.deepEqual(native.abi,original.abi);
  assert.equal(native.abi.find(entry=>entry.name==='read').inputs[1].type,type);
  assert.equal(native.abi.find(entry=>entry.name==='read').outputs[0].type,type);
  await assert.rejects(compileSolidity({...args,target:'pqvm'}),/nativeAddressContextHeight/);
 }
});

test('typed bytes32 owner result retains its ABI and uint256 argument', async () => {
 const source='pragma solidity ^0.8.20; interface I {function ownerOf(uint256 tokenId) external view returns(bytes32);} contract Reader {function lookup(address target,uint256 tokenId) external view returns(bytes32){return I(target).ownerOf(tokenId);} function last(address target) external view returns(bytes32){return I(target).ownerOf(0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff);}}';
 const args={sources:[{path:'Reader.sol',content:source}],contractName:'Reader',evmVersion:'shanghai'};
 const original=await compileSolidity({...args,target:'evm'});
 const native=await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2});
 assert.deepEqual(native.abi,original.abi);
 assert.equal(native.abi.find(entry=>entry.name==='lookup').outputs[0].type,'bytes32');
 await assert.rejects(compileSolidity({...args,target:'pqvm'}),/typed call requires nativeAddressContextHeight/);
 for (const result of ['uint256[] memory','bytes memory']) {
  await assert.rejects(compileSolidity({...args,sources:[{path:'Reader.sol',content:source.replaceAll('bytes32',result)}],target:'pqvm',nativeAddressContextHeight:2}),/static address, integer, fixed bytes or bool/);
 }
});

test('typed balance calls retain integer results and the original address ABI', async () => {
 const source='pragma solidity ^0.8.20; interface I {function balanceOf(address owner) external view returns(uint256);} contract Reader {function lookup(address token,address owner) external view returns(uint256){return I(token).balanceOf(owner);}}';
 for (const result of ['uint256','uint','uint8','uint112','uint128','uint248','int','int8','int112','int256']) {
  for (const mutability of ['view','pure','']) {
   let content=source.replaceAll('uint256',result).replace('external view returns','external '+mutability+' returns');
   if (!mutability) content=content.replace('owner) external view','owner) external');
   const args={sources:[{path:'Reader.sol',content}],contractName:'Reader',evmVersion:'shanghai'};
   const original=await compileSolidity({...args,target:'evm'});
   const native=await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2});
   assert.deepEqual(native.abi,original.abi);
   assert.equal(native.abi.find(entry=>entry.name==='lookup').outputs[0].type,result==='uint'?'uint256':result==='int'?'int256':result);
   await assert.rejects(compileSolidity({...args,target:'pqvm'}),/typed call requires nativeAddressContextHeight/);
  }
 }
 for (const result of ['string memory','bytes memory','uint256[] memory']) {
  await assert.rejects(compileSolidity({sources:[{path:'Reader.sol',content:source.replaceAll('uint256',result)}],contractName:'Reader',target:'pqvm',nativeAddressContextHeight:2}),/static address, integer, fixed bytes or bool/);
 }
});

test('pure typed callers preserve original ABI through imported internal calls and overrides', async () => {
 for (const result of ['address','bytes32','uint256']) {
  const sources=[
   {path:'Base.sol',content:`pragma solidity ^0.8.20;
interface I {function echo(address value) external pure returns(${result});}
abstract contract Base {
 function read(address target,address value) internal pure returns(${result}) {return I(target).echo(value);}
 function lookup(address target,address value) external virtual pure returns(${result});
}`},
   {path:'Reader.sol',content:`pragma solidity ^0.8.20; import './Base.sol';
contract Reader is Base {
 modifier labeled(string memory label) {_;}
 function lookup(address target,address value) external /* pure 地址 */ pure override labeled("pure") returns(${result}) {return read(target,value);}
 function local(address value) external pure returns(address) {return value;}
}`},
  ];
  const args={sources,contractName:'Reader',evmVersion:'shanghai'};
  const original=await compileSolidity({...args,target:'evm'});
  const native=await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2});
  assert.deepEqual(native.abi,original.abi);
  assert.equal(native.abi.find(entry=>entry.name==='lookup').stateMutability,'pure');
  await assert.rejects(compileSolidity({...args,target:'pqvm'}),/typed call requires nativeAddressContextHeight/);
 }
 const source='pragma solidity ^0.8.20; interface I {function echo(address value) external view returns(uint256);} contract Reader {function lookup(address target,address value) external pure returns(uint256){return I(target).echo(value);}}';
 await assert.rejects(compileSolidity({sources:[{path:'Reader.sol',content:source}],contractName:'Reader',target:'pqvm',nativeAddressContextHeight:2}),/Function declared as pure/);
 const writes=source.replace('return I(target).echo(value);','stored=value; return 1;').replace('contract Reader {','contract Reader {address stored;');
 await assert.rejects(compileSolidity({sources:[{path:'Reader.sol',content:writes}],contractName:'Reader',target:'pqvm',nativeAddressContextHeight:2}),/Function cannot be declared as pure/);
});

// Independently compute limits from the integer width. Literal equivalents
// exercise the same address lowering while providing a separate value oracle.
function executableBytecode(artifact) {
  const hex = artifact.deployedBytecode.slice(2);
  const metadataBytes = Number.parseInt(hex.slice(-4), 16);
  return hex.slice(0, -(metadataBytes + 2) * 2);
}

test('integer type limits retain every signed and unsigned width through address lowering', async () => {
  for (const signed of [false, true]) {
    const declarations = [];
    const literals = [];
    for (let width = 8; width <= 256; width += 8) {
      const type = `${signed ? 'int' : 'uint'}${width}`;
      const min = signed ? -(1n << BigInt(width - 1)) : 0n;
      const max = (1n << BigInt(width - (signed ? 1 : 0))) - 1n;
      declarations.push(`${type} public constant min${width} = type(${type}).min; ${type} public constant max${width} = type(${type}).max;`);
      literals.push(`${type} public constant min${width} = ${min}; ${type} public constant max${width} = ${max};`);
    }
    // uint/int aliases also resolve to 256-bit typed metatype AST nodes.
    const alias = signed ? 'int' : 'uint';
    declarations.push(`${alias} public constant aliasMax = type(${alias}).max;`);
    literals.push(`${alias} public constant aliasMax = ${(1n << BigInt(signed ? 255 : 256)) - 1n};`);
    const compile = (body) => compileSolidity({sources:[{path:'Limits.sol',content:`pragma solidity ^0.8.20; contract Limits {address public owner; ${body.join(' ')} function echo(address value) external pure returns(address) {return value;}}`}],contractName:'Limits',target:'pqvm',evmVersion:'shanghai'});
    const native = await compile(declarations);
    const literal = await compile(literals);
    assert.deepEqual(native.abi, literal.abi);
    assert.equal(executableBytecode(native), executableBytecode(literal));
  }
});

test('typed owner calls accept integer type limits and preserve activation and rejection boundaries', async () => {
  const content='pragma solidity ^0.8.20; interface I {function ownerOf(uint256 tokenId) external view returns(bytes32);} contract Reader {function last(address target) external view returns(bytes32){return I(target).ownerOf(type(uint256).max);} function zero(address target) external view returns(bytes32){return I(target).ownerOf(type(uint256).min);}}';
  const args={sources:[{path:'Reader.sol',content}],contractName:'Reader',target:'pqvm',evmVersion:'shanghai'};
  await assert.rejects(compileSolidity(args), /typed call requires nativeAddressContextHeight/);
  const native = await compileSolidity({...args,nativeAddressContextHeight:2});
  const literal = await compileSolidity({...args,sources:[{path:'Reader.sol',content:content.replace('type(uint256).max', ((1n << 256n) - 1n).toString()).replace('type(uint256).min','0')}],nativeAddressContextHeight:2});
  assert.deepEqual(native.abi,literal.abi);
  assert.equal(executableBytecode(native),executableBytecode(literal));
  for (const body of [
    'function name() external pure returns(string memory) {return type(Other).name;}',
    'function unsafe(address target,bytes memory data) external returns(bool,bytes memory) {return target.call{gas:gasleft()}(data);}',
  ]) {
    await assert.rejects(compileSolidity({sources:[{path:'Unsupported.sol',content:`pragma solidity ^0.8.20; contract Other {} contract Unsupported {address stored; ${body}}`}],contractName:'Unsupported',target:'pqvm',nativeAddressContextHeight:2}), /does not yet support|optional simple value/);
  }
  await assert.rejects(compileSolidity({...args,sources:[{path:'Reader.sol',content:content.replace('type(uint256).max','type(int256).min')}],nativeAddressContextHeight:2}), /compile failed|compilation failed/i);
});


test('PQABI lowers typed storage and memory struct fields while retaining the original ABI', async () => {
  const content = `pragma solidity ^0.8.20;
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
  }`;
  const options={sources:[{path:'Ledger.sol',content}],contractName:'Ledger',evmVersion:'shanghai'};
  const original=await compileSolidity(options);
  const native=await compileSolidity({...options,target:'pqvm'});
  assert.deepEqual(native.abi,original.abi);
  const compiled=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'Ledger.sol':{content}},settings:{outputSelection:{'*':{'*':['evm.methodIdentifiers']}}}})));
  for(const selector of Object.values(compiled.contracts['Ledger.sol'].Ledger.evm.methodIdentifiers)) {
    assert.ok(native.deployedBytecode.includes(selector));
  }
  assert.notEqual(native.deployedBytecode,original.deployedBytecode);
});


test('struct fields named max retain field access rather than integer metatype lowering', async () => {
  const content='pragma solidity ^0.8.20; contract Fields {address stored; struct S {uint256 max;} function read(S memory value) external pure returns(uint256) {return value.max;}}';
  const options={sources:[{path:'Fields.sol',content}],contractName:'Fields'};
  assert.deepEqual((await compileSolidity({...options,target:'pqvm'})).abi,(await compileSolidity(options)).abi);
});


test('typed calls accept stored, memory and nested address struct fields with the original ABI', async () => {
  const original='pragma solidity ^0.8.35; interface I {function ownerOf(uint256 id) external view returns(bytes32);} contract Ledger { struct Entry {address owner;} mapping(uint256=>Entry) private entries; function set(uint256 id,address owner) external {entries[id].owner=owner;} function lookup(uint256 id) external view returns(bytes32) {return I(entries[id].owner).ownerOf(type(uint256).max);} }';
  const sources=[original,
    original.replace('return I(entries[id].owner)', 'Entry memory entry=entries[id]; return I(entry.owner)'),
    original.replace('mapping(uint256=>Entry)', 'struct Book {Entry entry;} mapping(uint256=>Book)').replaceAll('entries[id].owner','entries[id].entry.owner'),
    original.replace('function lookup(uint256 id) external view', 'uint256 public selections; function select(uint256 id) internal returns(uint256) {selections++; return id;} function lookup(uint256 id) external').replace('I(entries[id].owner)', 'I(entries[select(id)].owner)'),
  ];
  for(const source of sources) {
    for(const result of ['bytes32','address','uint256']) {
      const args={sources:[{path:'Ledger.sol',content:source.replaceAll('returns(bytes32)',`returns(${result})`)}],contractName:'Ledger',evmVersion:'shanghai'};
      const evm=await compileSolidity({...args,target:'evm'});
      const pqvm=await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2});
      assert.deepEqual(pqvm.abi,evm.abi);
      await assert.rejects(compileSolidity({...args,target:'pqvm'}),/typed call requires nativeAddressContextHeight/);
    }
  }
  await assert.rejects(compileSolidity({sources:[{path:'Ledger.sol',content:original.replaceAll('address owner','address payable owner')}],contractName:'Ledger',target:'pqvm',nativeAddressContextHeight:2}),/address variable or typed struct field/);
});


test('typed calls retain struct field arguments and their original ABI', async () => {
  const original='pragma solidity ^0.8.35; interface I {function balanceOf(address beneficiary) external view returns(uint256);} contract Ledger {struct Entry {address token; address beneficiary;} mapping(uint256=>Entry) private entries; function set(uint256 id,address token,address beneficiary) external {entries[id]=Entry(token,beneficiary);} function lookup(uint256 id) external view returns(uint256) {return I(entries[id].token).balanceOf(entries[id].beneficiary);} }';
  const sources=[original,
    original.replace('return I(entries[id].token)', 'Entry memory entry=entries[id]; return I(entry.token)').replace('.balanceOf(entries[id].beneficiary)', '.balanceOf(entry.beneficiary)'),
    original.replace('mapping(uint256=>Entry)', 'struct Book {Entry entry;} mapping(uint256=>Book)').replace('entries[id]=Entry(token,beneficiary)', 'entries[id]=Book(Entry(token,beneficiary))').replaceAll('entries[id].','entries[id].entry.'),
    original.replace('function lookup(uint256 id) external view', 'uint256 public selections; function select(uint256 id) internal returns(uint256) {selections++; return id;} function lookup(uint256 id) external').replace('.balanceOf(entries[id].beneficiary)', '.balanceOf(entries[select(id)].beneficiary)'),
  ];
  for(const content of sources) {
    const args={sources:[{path:'Ledger.sol',content}],contractName:'Ledger',evmVersion:'shanghai'};
    const original=await compileSolidity({...args,target:'evm'});
    const native=await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2});
    assert.deepEqual(native.abi,original.abi);
    await assert.rejects(compileSolidity({...args,target:'pqvm'}),/typed call requires nativeAddressContextHeight/);
  }
  for(const field of ['uint256','uint96']) {
    const content=original.replace('function balanceOf(address beneficiary)','function balanceOf(uint256 beneficiary)').replaceAll('address beneficiary',`${field} beneficiary`);
    const args={sources:[{path:'Ledger.sol',content}],contractName:'Ledger',evmVersion:'shanghai'};
    assert.deepEqual((await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2})).abi,(await compileSolidity({...args,target:'evm'})).abi);
  }
});

const overloadedSource = `pragma solidity ^0.8.35;
contract Overloads {
  function echo(address value) public pure returns(address) { return value; }
  function echo(uint256 value) public pure returns(uint256) { return value + 1; }
  function pick(address value) external pure returns(address) { return echo(value); }
  function pick(uint256 value) external pure returns(uint256) { return echo(value); }
}`;
const overloadedOptions = {sources:[{path:'Overloads.sol',content:overloadedSource}],contractName:'Overloads',evmVersion:'shanghai'};

test('PQABI overloads keep address and uint256 declarations and original public selectors', async () => {
  const original = await compileSolidity(overloadedOptions);
  const native = await compileSolidity({...overloadedOptions,target:'pqvm',nativeAddressContextHeight:2});
  assert.deepEqual(native.abi,original.abi);
  for (const selector of ['2ffdbf1a','6279e43c','a0eba259','7701ea4a']) {
    assert.ok(native.deployedBytecode.includes(selector));
  }
  assert.deepEqual(await compileSolidity(overloadedOptions),original);
});

const derivedOverloads = [
  {kind:'inherited',addressSelector:'fc68521a',integerSelector:'b3de648b',array:false,
    content:'pragma solidity ^0.8.35; contract Base {function f(address value) public pure virtual returns(address){return value;}} contract Derived is Base {function f(address value) public pure override returns(address){return value;} function f(uint256 value) public pure returns(uint256){return value+1;}}'},
  {kind:'internal',addressSelector:'666e1b39',integerSelector:'8b0d0258',array:false,
    content:'pragma solidity ^0.8.35; contract Derived {function f(address value) internal pure returns(address){return value;} function f(uint256 value) internal pure returns(uint256){return value+1;} function owner(address value) public pure returns(address){return f(value);} function amount(uint256 value) public pure returns(uint256){return f(value);}}'},
  {kind:'free',addressSelector:'666e1b39',integerSelector:'8b0d0258',array:false,
    content:'pragma solidity ^0.8.35; function f(address value) pure returns(address){return value;} function f(uint256 value) pure returns(uint256){return value+1;} contract Derived {function owner(address value) public pure returns(address){return f(value);} function amount(uint256 value) public pure returns(uint256){return f(value);}}'},
  {kind:'array',addressSelector:'290c05ea',integerSelector:'7bc5bbbf',array:true,
    content:'pragma solidity ^0.8.35; contract Derived {function f(address[] memory values) public pure returns(address){return values[0];} function f(uint256[] memory values) public pure returns(uint256){return values[0]+1;}}'},
];

test('PQABI overloads preserve inherited overrides and nonpublic typed references', async () => {
  for (const {content} of derivedOverloads) {
    const options={sources:[{path:'Derived.sol',content}],contractName:'Derived',evmVersion:'shanghai'};
    const original=await compileSolidity(options);
    assert.deepEqual((await compileSolidity({...options,target:'pqvm'})).abi,original.abi);
  }
});

// Occupy every legal one-character identifier, plus likely fallback names.
const occupiedNames = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz$'].filter(name=>name!=='f')
  .concat(['$0','$1','AA','_a']).map(name=>`uint256 private ${name};`).join('');
const crowdedOverloads = [
  {kind:'public',scalar:true,addressSelector:'fc68521a',integerSelector:'b3de648b',array:false,
    content:`pragma solidity ^0.8.35; contract Derived {${occupiedNames}
      // Non-ASCII source text checks byte offsets: 地址
      function f(address value) public pure returns(address){return value;}
      function f(uint256 value) public pure returns(uint256){return value+1;}}`},
  {kind:'inherited',addressSelector:'fc68521a',integerSelector:'b3de648b',array:false,
    content:derivedOverloads[0].content.replace('contract Derived is Base {',`contract Derived is Base {${occupiedNames}`)},
  {kind:'internal',addressSelector:'666e1b39',integerSelector:'8b0d0258',array:false,
    content:derivedOverloads[1].content.replace('contract Derived {',`contract Derived {${occupiedNames}`)},
  {kind:'free',addressSelector:'666e1b39',integerSelector:'8b0d0258',array:false,
    content:derivedOverloads[2].content.replace('contract Derived {',`contract Derived {${occupiedNames}`)},
  {kind:'array',addressSelector:'290c05ea',integerSelector:'7bc5bbbf',array:true,
    content:derivedOverloads[3].content.replace('contract Derived {',`contract Derived {${occupiedNames}`)},
];

test('PQABI crowded overloads allocate longer names without changing the original ABI', async () => {
  for(const {content} of crowdedOverloads) {
    const options={sources:[{path:'Derived.sol',content}],contractName:'Derived',evmVersion:'shanghai'};
    assert.deepEqual((await compileSolidity({...options,target:'pqvm'})).abi,(await compileSolidity(options)).abi);
  }
});

const crowdedSignatureSource=`pragma solidity ^0.8.35; contract Derived {${occupiedNames}
    uint256 public count;
    function f(address value) public returns(address){count++;emit Seen(value);if(value==address(0))revert Bad(value);return value;}
    function f(uint256 value) public pure returns(uint256){return value+1;}
    event Seen(address value); error Bad(address value); error Denied(address value);
    function reject(address value) public {count++;emit Seen(value);require(false,Denied(value));}
  }`;

test('PQABI longer overload names preserve shifted event and custom-error signatures', async () => {
  const options={sources:[{path:'Derived.sol',content:crowdedSignatureSource}],contractName:'Derived',evmVersion:'shanghai',optimizer:{enabled:false}};
  const original=await compileSolidity(options);
  const native=await compileSolidity({...options,target:'pqvm'});
  assert.deepEqual(native.abi,original.abi);
  const {keccak256,stringToHex}=await import('viem');
  const topic=keccak256(stringToHex('Seen(address)')).slice(2);
  const error=keccak256(stringToHex('Denied(address)')).slice(2,10);
  assert.ok(native.deployedBytecode.includes(topic));assert.ok(native.deployedBytecode.includes(error));
  assert.ok(!native.deployedBytecode.includes(keccak256(stringToHex('Seen(uint256)')).slice(2)));
});

test('PQABI longer overload names translate signature locations across source files', async () => {
  const sources=[{path:'Base.sol',content:'pragma solidity ^0.8.35; contract Base {event Seen(address value);error Denied(address value);function f(address value) public pure virtual returns(address){return value;}}'},
    {path:'Derived.sol',content:`pragma solidity ^0.8.35; import "./Base.sol"; contract Derived is Base {${occupiedNames}
      function f(address value) public pure override returns(address){return value;}
      function f(uint256 value) public pure returns(uint256){return value+1;}
      event Later(address value);
      function invoke(address value) public {emit Seen(value);emit Later(value);revert Denied(value);}
    }`}];
  const options={sources,contractName:'Derived',evmVersion:'shanghai'};
  const original=await compileSolidity(options);
  const native=await compileSolidity({...options,target:'pqvm'});
  assert.deepEqual(native.abi,original.abi);
  const {keccak256,stringToHex}=await import('viem');
  for(const signature of ['Seen(address)','Later(address)']) {
    // Reverts erase logs at runtime; unoptimized IR still contains typed emission.
    const unoptimized=await compileSolidity({...options,target:'pqvm',optimizer:{enabled:false}});
    assert.ok(unoptimized.deployedBytecode.includes(keccak256(stringToHex(signature)).slice(2)));
  }
});

test('PQABI longer overload names preserve later typed pure-call normalization', async () => {
  const content=`pragma solidity ^0.8.35; interface Echo {function echo(address value) external pure returns(address);}
    contract Derived {${occupiedNames}
      function f(address value) public pure returns(address){return value;}
      function f(uint256 value) public pure returns(uint256){return value+1;}
      function invoke(address target,address value) public pure returns(address){return Echo(target).echo(value);}
    }`;
  const options={sources:[{path:'Derived.sol',content}],contractName:'Derived',evmVersion:'shanghai'};
  assert.deepEqual((await compileSolidity({...options,target:'pqvm',nativeAddressContextHeight:2})).abi,
    (await compileSolidity(options)).abi);
});

test('PQABI longer overload references survive whole native-call rewrites', async () => {
  const content=`pragma solidity ^0.8.35; contract Derived {${occupiedNames}
    function f(address value) internal pure returns(address){return value;}
    function f(uint256 value) internal pure returns(uint256){return value+1;}
    function invoke(address target,bytes memory data) public returns(bool,bytes memory){return f(target).call(data);}
  }`;
  const options={sources:[{path:'Derived.sol',content}],contractName:'Derived',evmVersion:'shanghai'};
  assert.deepEqual((await compileSolidity({...options,target:'pqvm',nativeAddressContextHeight:2})).abi,
    (await compileSolidity(options)).abi);
});

test('nested context rendering composes with longer overload names and nested balance reads', async () => {
 const content=`pragma solidity ^0.8.35;
 interface IPayee {function pay(address owner) external returns(address);}
 contract Derived {${occupiedNames}
  struct Entry {address target;address owner;}
  mapping(address=>Entry) entries;
  mapping(uint256=>Entry) numeric;
  function f(address owner) internal pure returns(address){return owner;}
  function f(uint256 owner) internal pure returns(uint256){return owner+1;}
  function invoke() external returns(address){return IPayee(entries[f(msg.sender)].target).pay(entries[f(tx.origin)].owner);}
  function balanceRead() external returns(address){return IPayee(numeric[msg.sender.balance].target).pay(numeric[msg.sender.balance].owner);}
 }`;
 const args={sources:[{path:'Derived.sol',content}],contractName:'Derived',evmVersion:'shanghai'};
 const original=await compileSolidity(args);
 assert.deepEqual((await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2})).abi,original.abi);
});


test('PQABI overloads do not repair invalid original type resolution', async () => {
  const content='pragma solidity ^0.8.35; contract Invalid {function f(uint8 value) public pure returns(uint256){return value;} function f(uint256 value) public pure returns(uint256){return value;} function bad() public pure returns(uint256){return f(50);}}';
  for (const target of ['evm','pqvm']) {
    await assert.rejects(compileSolidity({sources:[{path:'Invalid.sol',content}],contractName:'Invalid',target}),/No unique declaration/);
  }
});

test('PQABI overload real VM: original selectors distinguish full-word address and integer results', {skip:!process.env.SHELL_PQABI_RPC_URL}, async () => {
  const word=BigInt('0x'+first);const padded=value=>value.toString(16).padStart(64,'0');
  const cases=[['2ffdbf1a',word],['6279e43c',word+1n],['a0eba259',word],['7701ea4a',word+1n]];
  for (const target of ['evm','pqvm']) {
    const artifact=await compileSolidity({...overloadedOptions,target,...(target==='pqvm'?{nativeAddressContextHeight:2}:{})});
    const calls=cases.map(([selector],index)=>`mstore(0,shl(224,0x${selector})) mstore(4,0x${first}) mstore(128,0) let success${index}:=staticcall(gas(),child,0,36,128,32) mstore(${256+index*64},success${index}) mstore(${288+index*64},mload(128))`).join('\n');
    const refusals = `mstore(0,shl(224,0x2ffdbf1a)) if staticcall(gas(),child,0,35,0,0){revert(0,0)}
      mstore(0,shl(224,0xffffffff)) if staticcall(gas(),child,0,36,0,0){revert(0,0)}
      mstore(0,shl(224,0x6279e43c)) mstore(4,not(0)) if staticcall(gas(),child,0,36,0,0){revert(0,0)}
      if iszero(eq(returndatasize(),36)){revert(0,0)} returndatacopy(0,0,36)
      if iszero(eq(shr(224,mload(0)),0x4e487b71)){revert(0,0)} if iszero(eq(mload(4),0x11)){revert(0,0)}`;
    const harness=`object "Probe" {code {datacopy(0,dataoffset("child"),datasize("child")) let child:=create(0,0,datasize("child")) if iszero(child){revert(0,0)} ${calls} ${refusals} return(256,256)} data "child" hex"${artifact.bytecode.slice(2)}"}`;
    const output=JSON.parse(solc.compile(JSON.stringify({language:'Yul',sources:{'Probe.yul':{content:harness}},settings:{evmVersion:'shanghai',outputSelection:{'*':{'*':['evm.bytecode.object']}}}})));
    assert.equal(output.errors?.filter(error=>error.severity==='error').length??0,0);
    const response=await fetch(process.env.SHELL_PQABI_RPC_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{data:'0x'+output.contracts['Probe.yul'].Probe.evm.bytecode.object,gas:'0x989680'},'latest']}),signal:AbortSignal.timeout(30000)});
    assert.ok(response.ok);const result=await response.json();
    const expected='0x'+cases.map(([,value],index)=>target==='evm'&&index%2===0?padded(0n)+padded(0n):padded(1n)+padded(value)).join('');
    assert.equal(result.result,expected);
  }
});


async function runDerivedOverloadVm(variants, signatureChecks=false) {
    const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
    const {openSync,closeSync}=await import('node:fs');
    const {tmpdir}=await import('node:os');
    const {join}=await import('node:path');
    const {spawn,spawnSync}=await import('node:child_process');
    const {createServer}=await import('node:net');
    const {once}=await import('node:events');
    const {MlDsa65Adapter}=await import('../dist/adapters.js');
    const {ShellSigner}=await import('../dist/signer.js');
    const binary=process.env.SHELL_NODE_BIN;
    const directory=await mkdtemp(join(tmpdir(),'shell-sdk-derived-overloads-'));
    const signer=new ShellSigner('MlDsa65',MlDsa65Adapter.generate());
    let child,exit,log,passed=false;
    const results=[];
    try {
      const genesis={chain_id:1337,timestamp:0,network_type:'Dev',
        consensus:{engine:'poa',authorities:[signer.getAddress()],
          authority_pubkeys:[Buffer.from(signer.getPublicKey()).toString('hex')],block_time_secs:600}};
      const input=join(directory,'input-genesis.json');await writeFile(input,JSON.stringify(genesis));
      const init=spawnSync(binary,['--datadir',directory,'init','--genesis',input,'--network','dev','--chain-id','1337'],{encoding:'utf8',timeout:30000});
      assert.equal(init.status,0,init.stderr||init.stdout);
      const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
      const port=server.address().port;await new Promise(resolve=>server.close(resolve));
      const config=join(directory,'config.toml');await writeFile(config,'[metrics]\nenabled = false\n');
      log=openSync(join(directory,'node.log'),'w');
      child=spawn(binary,['--datadir',directory,'run','--network','dev','--chain-id','1337',
        '--block-time','600000','--db','memory','--consensus-engine','poa',
        '--rpc-addr',`127.0.0.1:${port}`,'--config',config],{stdio:['ignore',log,log]});
      exit=once(child,'exit');
      async function rpc(method,params) {
        const response=await fetch(`http://127.0.0.1:${port}`,{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(30000)});
        assert.ok(response.ok);const body=await response.json();assert.equal(body.error,undefined,JSON.stringify(body));return body.result;
      }
      const deadline=Date.now()+15000;
      while(true) {
        try {if(await rpc('eth_chainId',[])==='0x539')break;} catch {}
        assert.equal(child.exitCode,null,'node exited during startup');assert.equal(child.signalCode,null);
        assert.ok(Date.now()<deadline,'node RPC startup timeout');await new Promise(resolve=>setTimeout(resolve,50));
      }
      const before=await rpc('eth_getBlockByNumber',['latest',false]);
      const padded=value=>BigInt(value).toString(16).padStart(64,'0');
      for(const variant of variants) {
        const options={sources:[{path:'Derived.sol',content:variant.content}],contractName:'Derived',evmVersion:'shanghai'};
        const original=await compileSolidity(options);
        for(const target of ['evm','pqvm']) {
          const artifact=target==='evm'?original:await compileSolidity({...options,target});
          assert.deepEqual(artifact.abi,original.abi);
          const {addressSelector,integerSelector,array}=variant;
          const signature=i=>i===3
            ?(array?'f(uint256[])':variant.kind==='inherited'||variant.scalar?'f(uint256)':'amount(uint256)')
            :(array?'f(address[])':variant.kind==='inherited'||variant.scalar?'f(address)':'owner(address)');
          // Original ABI words and selectors are independent of the lowered compiler output.
          const input=(selector,value)=>`mstore(0,shl(224,0x${selector})) ${array?'mstore(4,32) mstore(36,1)':''} mstore(${array?68:4},0x${padded(value)})`;
          const length=array?100:36;
          const calls=[[addressSelector,'0x'+first],[addressSelector,'0x'+second],
            [addressSelector,(1n<<256n)-1n],[integerSelector,'0x'+first]];
          const valid=calls.map(([selector,value],i)=>`${input(selector,value)} mstore(128,0)
            mstore(${256+i*64},staticcall(gas(),child,0,${length},128,32)) mstore(${288+i*64},mload(128))`).join('\n');
          const panic=code=>`if iszero(eq(returndatasize(),36)){revert(0,0)} returndatacopy(0,0,36)
            if iszero(eq(shr(224,mload(0)),0x4e487b71)){revert(0,0)} if iszero(eq(mload(4),${code})){revert(0,0)}`;
          const invalid=`${input(addressSelector,'0x'+first)} if staticcall(gas(),child,0,${length-1},0,0){revert(0,0)}
            mstore(0,shl(224,0xffffffff)) if staticcall(gas(),child,0,${length},0,0){revert(0,0)}
            ${input(integerSelector,(1n<<256n)-1n)} if staticcall(gas(),child,0,${length},0,0){revert(0,0)} ${panic('0x11')}
            ${array?[addressSelector,integerSelector].map(selector=>`mstore(0,shl(224,0x${selector})) mstore(4,32) mstore(36,0)
              if staticcall(gas(),child,0,68,0,0){revert(0,0)} ${panic('0x32')}`).join('\n'):''}`;
          const probe=`object "Probe" {code {datacopy(0,dataoffset("child"),datasize("child"))
            let child:=create(0,0,datasize("child")) if iszero(child){revert(0,0)} ${valid} ${invalid} return(256,256)}
            data "child" hex"${artifact.bytecode.slice(2)}"}`;
          const output=JSON.parse(solc.compile(JSON.stringify({language:'Yul',sources:{'Probe.yul':{content:probe}},
            settings:{evmVersion:'shanghai',outputSelection:{'*':{'*':['evm.bytecode.object']}}}})));
          assert.equal(output.errors?.filter(error=>error.severity==='error').length??0,0);
          const actual=await rpc('eth_call',[{data:'0x'+output.contracts['Probe.yul'].Probe.evm.bytecode.object,gas:'0x989680'},'latest']);
          const expected='0x'+calls.map(([,value],i)=>target==='evm'&&i<3?padded(0n)+padded(0n):padded(1n)+padded(i===3?BigInt(value)+1n:value)).join('');
          assert.equal(actual,expected,`${variant.kind}/${target}`);
          if(target==='pqvm') {
            for(const [i,[selector,value]] of calls.entries()) {
              const argument=i===3?BigInt(value):'0x'+padded(value);
              const encoded=encodeFunctionData({abi:artifact.abi,functionName:signature(i),args:[array?[argument]:argument]});
              assert.equal(encoded,'0x'+selector+(array?padded(32)+padded(1):'')+padded(value));
              const data='0x'+actual.slice(2+i*128+64,2+(i+1)*128);
              assert.equal(decodeFunctionResult({abi:artifact.abi,functionName:signature(i),data}),
                i===3?BigInt(value)+1n:'0x'+padded(value));
            }
          }
          results.push({kind:variant.kind,target,actual,expected,malformedRejected:true,
            unknownRejected:true,overflowPanic:'0x11',...(array?{emptyArrayPanic:'0x32'}:{})});
        }
      }
      if(signatureChecks) {
        const {toFunctionSelector}=await import('viem');
        const artifact=await compileSolidity({sources:[{path:'Derived.sol',content:crowdedSignatureSource}],
          contractName:'Derived',target:'pqvm',evmVersion:'shanghai'});
        const selector=signature=>toFunctionSelector(signature).slice(2);
        const revert=signature=>`if iszero(eq(returndatasize(),36)){revert(0,0)} returndatacopy(128,0,36)
          if iszero(eq(shr(224,mload(128)),0x${selector(signature)})){revert(0,0)}`;
        const probe=`object "Probe" {code {datacopy(0,dataoffset("child"),datasize("child"))
          let child:=create(0,0,datasize("child")) if iszero(child){revert(0,0)}
          mstore(0,shl(224,0xfc68521a)) mstore(4,0x${first})
          if iszero(call(gas(),child,0,0,36,256,32)){revert(0,0)}
          if iszero(eq(mload(256),0x${first})){revert(0,0)}
          mstore(4,0) if call(gas(),child,0,0,36,0,0){revert(0,0)} ${revert('Bad(address)')}
          if mload(132){revert(0,0)}
          mstore(0,shl(224,0x${selector('reject(address)')})) mstore(4,0x${second})
          if call(gas(),child,0,0,36,0,0){revert(0,0)} ${revert('Denied(address)')}
          if iszero(eq(mload(132),0x${second})){revert(0,0)}
          mstore(0,shl(224,0x${selector('count()')}))
          if iszero(staticcall(gas(),child,0,4,288,32)){revert(0,0)}
          if iszero(eq(mload(288),1)){revert(0,0)} return(256,64)}
          data "child" hex"${artifact.bytecode.slice(2)}"}`;
        const output=JSON.parse(solc.compile(JSON.stringify({language:'Yul',sources:{'Probe.yul':{content:probe}},
          settings:{evmVersion:'shanghai',outputSelection:{'*':{'*':['evm.bytecode.object']}}}})));
        assert.equal(output.errors?.filter(error=>error.severity==='error').length??0,0);
        const actual=await rpc('eth_call',[{data:'0x'+output.contracts['Probe.yul'].Probe.evm.bytecode.object,gas:'0x989680'},'latest']);
        const expected='0x'+first+padded(1);
        assert.equal(actual,expected);
        results.push({kind:'shifted-signatures',target:'pqvm',actual,expected,
          revertSelector:selector('Bad(address)'),requireSelector:selector('Denied(address)'),fullWordError:true,rollback:true});
      }
      const after=await rpc('eth_getBlockByNumber',['latest',false]);
      assert.equal(after.hash,before.hash);assert.equal(after.stateRoot,before.stateRoot);
      console.log('derived overload VM acceptance',JSON.stringify(results));passed=true;
    } catch(error) {
      throw new Error(`derived overload VM regression failed; retained ${directory}`,{cause:error});
    } finally {
      signer.dispose();
      if(child) {
        if(child.exitCode===null && child.signalCode===null)child.kill('SIGTERM');
        const timer=setTimeout(()=>{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');},5000);timer.unref();
        try {await exit;} finally {clearTimeout(timer);}
      }
      if(log!==undefined)closeSync(log);
      if(passed)await rm(directory,{recursive:true});
    }
  }

test('PQABI derived overload real VM: inherited internal free and array dispatch',
  {skip:!process.env.SHELL_NODE_BIN,timeout:120000},()=>runDerivedOverloadVm(derivedOverloads));
test('PQABI crowded overload real VM: longer names preserve dispatch and rejection',
  {skip:!process.env.SHELL_NODE_BIN,timeout:120000},()=>runDerivedOverloadVm(crowdedOverloads,true));


test('native static function selectors retain original address signatures and pure XOR', async () => {
 const sources=[{path:'I.sol',content:'pragma solidity ^0.8.30; interface I {function pay(address owner) external payable returns(address);function peek(address owner) external view returns(address);}'} ,{path:'Reader.sol',content:`pragma solidity ^0.8.30; import {I as Imported} from "I.sol";
 contract Reader {
  function _j0() internal pure returns(uint256){return 1;}
  function who(address owner) external pure returns(address){return owner;}
  function selectors() external pure returns(bytes4,bytes4,bytes4,bytes4){Imported i;return(Imported.pay.selector,i.peek.selector,this.who.selector,Imported.pay.selector ^ Imported.peek.selector);}
  function register(address target) external view returns(address){return Imported(target).peek(address(0));}
 }`}];
 // Keep the supported typed-call argument a variable; selectors themselves need
 // no activation, while the external call uses the ordinary native call guard.
 sources[1].content=sources[1].content.replace('register(address target)','register(address target,address owner)').replace('peek(address(0))','peek(owner)');
 const args={sources,contractName:'Reader',evmVersion:'shanghai'};
 const original=await compileSolidity(args);
 const native=await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2});
 assert.deepEqual(native.abi,original.abi);
 assert.equal(native.abi.find(entry=>entry.name==='selectors').stateMutability,'pure');
 const only=sources[1].content.slice(0,sources[1].content.indexOf('  function register'))+'}';
 await compileSolidity({...args,sources:[sources[0],{path:'Reader.sol',content:only}],target:'pqvm'});
});

test('native selector fields are data and effectful function receivers still reject', async () => {
 const content=`pragma solidity ^0.8.30; interface I {function pay(address owner) external returns(address);}
 contract Reader {struct Item {bytes4 selector;} Item private item;
 function data(address owner) external view returns(address,bytes4){return(owner,item.selector);}
 function choose() internal returns(I){item.selector=0x11223344;return I(address(0));}
 function unsafe() external returns(bytes4){return choose().pay.selector;}}`;
 const args={sources:[{path:'Reader.sol',content}],contractName:'Reader',evmVersion:'shanghai'};
 await compileSolidity(args);
 await assert.rejects(compileSolidity({...args,target:'pqvm'}),/MemberAccess \.selector/);
 await compileSolidity({...args,sources:[{path:'Reader.sol',content:content.slice(0,content.indexOf(' function choose'))+'}'}],target:'pqvm'});
});


test('native interfaceId uses original direct selectors across inheritance and imports', async () => {
 const interfaces=`pragma solidity ^0.8.30;
 interface Base {function pay(address owner) external returns(address);}
 interface Child is Base {function peek(address owner) external view returns(address);event Seen(address owner);error Denied(address owner);}
 interface Empty is Child {}
 interface Over is Base {function pay(address owner) external override returns(address);function pay(uint256 owner) external returns(uint256);}
 interface Sink {function put(bytes4 value) external returns(bytes4);}`;
 const content=`pragma solidity ^0.8.30;import * as Spec from "Spec.sol";
 contract Reader {
  bytes4 constant ID=type(Spec.Child).interfaceId;
  function ids(address owner) external pure returns(address,bytes4,bytes4,bytes4,bytes4){return(owner,ID,type(Spec.Base).interfaceId,type(Spec.Empty).interfaceId,type(Spec.Over).interfaceId);}
  function store(address target) external returns(bytes4){return Spec.Sink(target).put(type(Spec.Child).interfaceId);}
 }`;
 const args={sources:[{path:'Spec.sol',content:interfaces},{path:'Reader.sol',content}],contractName:'Reader',evmVersion:'shanghai'};
 const original=await compileSolidity(args);const native=await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2});assert.deepEqual(native.abi,original.abi);
 assert.equal(native.abi.find(entry=>entry.name==='ids').stateMutability,'pure');
 // The constant expression itself does not depend on native activation.
 await compileSolidity({...args,sources:[args.sources[0],{path:'Reader.sol',content:content.slice(0,content.indexOf('  function store'))+'}'}],target:'pqvm'});
});

test('native interfaceId excludes events/errors and leaves same-named struct fields alone', async () => {
 const content=`pragma solidity ^0.8.30;interface Empty {event Ping(address owner);error Denied(address owner);}
 contract Reader {struct Entry {bytes4 interfaceId;} Entry private entry;
 function ids(address owner) external view returns(address,bytes4,bytes4){return(owner,entry.interfaceId,type(Empty).interfaceId);}}`;
 const args={sources:[{path:'Reader.sol',content}],contractName:'Reader',evmVersion:'shanghai'};
 assert.deepEqual((await compileSolidity({...args,target:'pqvm'})).abi,(await compileSolidity(args)).abi);
});


test('native original ERC165 assembly query keeps ABI and requires explicit activation', async () => {
 const {readFile}=await import('node:fs/promises');
 const content=await readFile(new URL('./fixtures/ERC165Query.sol',import.meta.url),'utf8');
 const args={sources:[{path:'ERC165Query.sol',content}],contractName:'ERC165Query',evmVersion:'shanghai'};
 const original=await compileSolidity(args);
 await assert.rejects(compileSolidity({...args,target:'pqvm'}),/InlineAssembly without nativeAddressContextHeight/);
 const native=await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2});assert.deepEqual(native.abi,original.abi);
 assert.notEqual(native.deployedBytecode,(await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:3})).deployedBytecode);
});

test('native Yul context without address syntax is guarded; ordinary arithmetic remains unchanged', async () => {
 const content='pragma solidity ^0.8.30; contract Words {function inspect() external view returns(uint256 value){assembly{value:=caller()}}}';
 const args={sources:[{path:'Words.sol',content}],contractName:'Words',evmVersion:'shanghai'};
 await assert.rejects(compileSolidity({...args,target:'pqvm'}),/InlineAssembly without nativeAddressContextHeight/);
 assert.deepEqual((await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2})).abi,(await compileSolidity(args)).abi);
 const arithmetic={...args,sources:[{path:'Words.sol',content:content.replace('external view','external pure').replace('caller()','add(1,2)')}]};
 assert.equal((await compileSolidity({...arithmetic,target:'pqvm'})).deployedBytecode,(await compileSolidity(arithmetic)).deployedBytecode);
 for(const operation of ['value:=create(0,0,0)','value:=create2(0,0,0,0)','value:=callcode(gas(),owner,0,0,0,0,0)','selfdestruct(owner)']) {
  const source=`pragma solidity ^0.8.30;contract Unsafe {function run(address owner) external returns(address value){assembly{${operation}}}}`;
  const input={sources:[{path:'Unsafe.sol',content:source}],contractName:'Unsafe',evmVersion:'shanghai'};await compileSolidity(input);
  await assert.rejects(compileSolidity({...input,target:'pqvm',nativeAddressContextHeight:2}),/native InlineAssembly does not yet support/);
 }
});

test('native assembly guards preserve later signatures and literal switch cases with longer overload aliases', async () => {
 const {toFunctionSelector,keccak256,toHex}=await import('viem');
 const literal=toFunctionSelector('probe(uint256)');
 const names=[...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'].map(name=>`function ${name}() private pure returns(uint256){return 0;}`).join('\n');
 const content=`pragma solidity ^0.8.30;contract AssemblySignatures {
 // Unicode before byte offsets: 地址
 ${names}
 function f(address owner) public pure returns(address){return owner;}
 function f(uint256 owner) public pure returns(uint256){return owner;}
 function probe(address owner) external pure returns(uint256 value){assembly{switch owner case ${literal}{value:=1}default{value:=2}}}
 function note(address owner) external {assembly("memory-safe"){mstore(0,owner)}emit Seen(owner);if(owner==address(0))revert Denied(owner);}
 event Seen(address indexed owner);error Denied(address owner);
 }`;
 const input={sources:[{path:'AssemblySignatures.sol',content}],contractName:'AssemblySignatures',evmVersion:'shanghai'};
 const native=await compileSolidity({...input,target:'pqvm',nativeAddressContextHeight:2});assert.deepEqual(native.abi,(await compileSolidity(input)).abi);
 assert.ok(native.deployedBytecode.includes(literal.slice(2)));
 assert.ok(native.deployedBytecode.includes(keccak256(toHex('Seen(address)')).slice(2)));
 assert.ok(native.deployedBytecode.includes(toFunctionSelector('Denied(address)').slice(2)));
});
