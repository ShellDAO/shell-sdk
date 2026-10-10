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
 await assert.rejects(compileSolidity({...options,sources:[{path:'NativeCall.sol',content:source.replace('value:value','gas:value')}],nativeAddressContextHeight:2}),/optional simple value/);
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


test('typed uint256 input and address result retain the original interface ABI', async () => {
 const source='pragma solidity ^0.8.20; interface I {function ownerOf(uint256 tokenId) external view returns(address);} contract Reader {function lookup(address target,uint256 tokenId) external view returns(address){return I(target).ownerOf(tokenId);} function last(address target) external view returns(address){return I(target).ownerOf(0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff);}}';
 const args={sources:[{path:'Reader.sol',content:source}],contractName:'Reader',evmVersion:'shanghai'};
 const original=await compileSolidity({...args,target:'evm'});
 const native=await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2});
 assert.deepEqual(native.abi,original.abi);
 await assert.rejects(compileSolidity({...args,target:'pqvm'}),/typed call requires nativeAddressContextHeight/);
 await assert.rejects(compileSolidity({...args,sources:[{path:'Reader.sol',content:source.replaceAll('uint256 tokenId','uint64 tokenId').replace('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff','1')}],target:'pqvm',nativeAddressContextHeight:2}),/one address or uint256 argument/);
});


test('typed bytes32 owner result retains its ABI and uint256 argument', async () => {
 const source='pragma solidity ^0.8.20; interface I {function ownerOf(uint256 tokenId) external view returns(bytes32);} contract Reader {function lookup(address target,uint256 tokenId) external view returns(bytes32){return I(target).ownerOf(tokenId);} function last(address target) external view returns(bytes32){return I(target).ownerOf(0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff);}}';
 const args={sources:[{path:'Reader.sol',content:source}],contractName:'Reader',evmVersion:'shanghai'};
 const original=await compileSolidity({...args,target:'evm'});
 const native=await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2});
 assert.deepEqual(native.abi,original.abi);
 assert.equal(native.abi.find(entry=>entry.name==='lookup').outputs[0].type,'bytes32');
 await assert.rejects(compileSolidity({...args,target:'pqvm'}),/typed call requires nativeAddressContextHeight/);
 for (const result of ['bytes16','bytes memory']) {
  await assert.rejects(compileSolidity({...args,sources:[{path:'Reader.sol',content:source.replaceAll('bytes32',result)}],target:'pqvm',nativeAddressContextHeight:2}),/one address, bytes32 or uint256 result/);
 }
});

test('typed balance calls retain numeric uint256 results and the original address ABI', async () => {
 const source='pragma solidity ^0.8.20; interface I {function balanceOf(address owner) external view returns(uint256);} contract Reader {function lookup(address token,address owner) external view returns(uint256){return I(token).balanceOf(owner);}}';
 for (const result of ['uint256','uint']) {
  for (const mutability of ['view','pure','']) {
   let content=source.replaceAll('uint256',result).replace('external view returns','external '+mutability+' returns');
   if (!mutability) content=content.replace('owner) external view','owner) external');
   const args={sources:[{path:'Reader.sol',content}],contractName:'Reader',evmVersion:'shanghai'};
   const original=await compileSolidity({...args,target:'evm'});
   const native=await compileSolidity({...args,target:'pqvm',nativeAddressContextHeight:2});
   assert.deepEqual(native.abi,original.abi);
   assert.equal(native.abi.find(entry=>entry.name==='lookup').outputs[0].type,'uint256');
   await assert.rejects(compileSolidity({...args,target:'pqvm'}),/typed call requires nativeAddressContextHeight/);
  }
 }
 for (const result of ['uint128','int256','bool','bytes16']) {
  await assert.rejects(compileSolidity({sources:[{path:'Reader.sol',content:source.replaceAll('uint256',result)}],contractName:'Reader',target:'pqvm',nativeAddressContextHeight:2}),/one address, bytes32 or uint256 result/);
 }
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
    'struct S {uint256 max;} function read(S memory value) external pure returns(uint256) {return value.max;}',
    'function name() external pure returns(string memory) {return type(Other).name;}',
    'function unsafe(address target,bytes memory data) external returns(bool,bytes memory) {return target.call{gas:100000}(data);}',
  ]) {
    await assert.rejects(compileSolidity({sources:[{path:'Unsupported.sol',content:`pragma solidity ^0.8.20; contract Other {} contract Unsupported {address stored; ${body}}`}],contractName:'Unsupported',target:'pqvm',nativeAddressContextHeight:2}), /does not yet support|optional simple value/);
  }
  await assert.rejects(compileSolidity({...args,sources:[{path:'Reader.sol',content:content.replace('type(uint256).max','type(int256).min')}],nativeAddressContextHeight:2}), /compile failed|compilation failed/i);
});
