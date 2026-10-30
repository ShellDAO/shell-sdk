import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { toFunctionSelector, keccak256 } from 'viem';
import { compileSolidity } from '../dist/contracts-compiler.js';
import { encodeFunctionData, decodeFunctionResult } from '../dist/contracts.js';
import { ShellSigner, MlDsa65Adapter, decryptKeystore, buildTransaction, createShellProvider,
  buildInnerCall, buildBatchTransaction } from '../dist/index.js';

const source = `pragma solidity ^0.8.30;
interface IPay { function pay(address owner) external payable returns(address); }
interface IRead { function peek(address owner) external view returns(address); }
interface INFT {
 function transferFrom(address from,address to,uint256 id) external;
 function ownerOf(uint256 id) external view returns(address);
 function checkOwner(address owner,uint256 id) external view;
}
interface IVoid {function touch(address owner,uint256 id) external payable;function ping() external;}
interface IOracle {
 function latestRoundData() external view returns(uint80,int256,uint256,uint256,uint80);
 function setRound(int256 price,int112 delta,uint80 round) external payable returns(int256,int112,uint80);
 function signedEcho(int112 value) external pure returns(int112);
}
interface IReserves {
 function getReserves() external view returns(uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast);
 function setReserves(uint112 first,uint112 second,uint32 at) external payable returns(uint112,uint112,uint32);
}
interface IPosition {
 function snapshot(address owner) external view returns(address,uint256,bool,bytes32);
 function capture(address owner) external payable returns(address,uint256,bool,bytes32);
 function facts(address owner,uint256 amount,bool enabled,bytes32 tag) external pure returns(address,uint256,bool,bytes32);
}
interface IAsset {
 function transfer(address recipient,uint256 amount) external returns(bool);
 function totalSupply() external view returns(uint256);
 function balanceOf(address owner) external view returns(uint256);
 function allowance(address owner,address spender) external view returns(uint256);
 function check(bytes32 tag,bool enabled) external pure returns(bool);
}
contract Payee {
 error Denied(address owner);
 uint256 public count;
 address public seen;
 mapping(address=>uint256) balances;
 uint256 supply;
 mapping(address=>mapping(address=>uint256)) allowances;
 mapping(uint256=>address) owners;
 uint112 reserve0;uint112 reserve1;uint32 reserveStamp;
 int256 oraclePrice;int112 oracleDelta;uint80 oracleRound;uint256 oracleTime;
 function setRound(int256 price,int112 delta,uint80 round) external payable returns(int256,int112,uint80){require(round>0);oraclePrice=price;oracleDelta=delta;oracleRound=round;oracleTime=block.timestamp;count++;seen=msg.sender;return(price,delta,round);}
 function latestRoundData() external view returns(uint80,int256,uint256,uint256,uint80){return(oracleRound,oraclePrice,oracleTime,oracleTime,oracleRound);}
 function signedEcho(int112 value) external pure returns(int112){return value;}
 function getReserves() external view returns(uint112,uint112,uint32){return(reserve0,reserve1,reserveStamp);}
 function setReserves(uint112 first,uint112 second,uint32 at) external payable returns(uint112,uint112,uint32){reserve0=first;reserve1=second;reserveStamp=at;count++;seen=msg.sender;return(first,second,at);}
 error WrongOwner(address expected,uint256 id);
 event OwnerMoved(address indexed from,address indexed to,uint256 indexed id);
 function transferFrom(address from,address to,uint256 id) external {
  require(owners[id]==from && msg.sender==from,"owner");owners[id]=to;count++;emit OwnerMoved(from,to,id);
 }
 function ownerOf(uint256 id) external view returns(address){return owners[id];}
 function checkOwner(address owner,uint256 id) external view {if(owners[id]!=owner) revert WrongOwner(owner,id);}
 function touch(address owner,uint256 id) external payable {require(owner!=address(0));owners[id]=owner;seen=owner;count++;}
 function ping() external {count++;}
 function snapshot(address owner) external view returns(address,uint256,bool,bytes32){return(seen,count,seen==owner,bytes32(uint256(7)));}
 function capture(address owner) external payable returns(address,uint256,bool,bytes32){count++;seen=owner;if(owner==address(0)) revert Denied(owner);return(seen,count,true,bytes32(uint256(7)));}
 function facts(address owner,uint256 amount,bool enabled,bytes32 tag) external pure returns(address,uint256,bool,bytes32){return(owner,amount,enabled,tag);}
 event Transfer(address indexed from,address indexed to,uint256 value);
 function transfer(address recipient,uint256 amount) external returns(bool) {
  if(recipient==address(0)) return false;
  require(balances[msg.sender]>=amount,"insufficient");
  balances[msg.sender]-=amount;balances[recipient]+=amount;count++;
  emit Transfer(msg.sender,recipient,amount);return true;
 }
 function totalSupply() external view returns(uint256){return supply;}
 function balanceOf(address owner) external view returns(uint256){return balances[owner];}
 function allowance(address owner,address spender) external view returns(uint256){return allowances[owner][spender];}
 function check(bytes32 tag,bool enabled) external pure returns(bool){return enabled && tag==bytes32(uint256(7));}
 function peek(address owner) external view returns(address) { require(owner==seen); return seen; }
 function pay(address owner) external payable returns(address) {
  count++; seen=owner; if (owner==address(0)) revert Denied(owner); return owner;
 }
}
contract Reader {
 uint256 public count;
 address public last;
 struct Entry {address target;address owner;uint256 amount;uint256 budget;}
 mapping(address=>Entry) entries;
 function configure(address key,address target,address owner,uint256 amount,uint256 budget) external {
  entries[key]=Entry(target,owner,amount,budget);
 }
 function contextual() external payable returns(address) {
  count++; last=IPay(entries[msg.sender].target).pay(entries[msg.sender].owner); return last;
 }
 function contextOptions() external payable returns(address) {
  count++; last=IPay(entries[msg.sender].target).pay{value:entries[msg.sender].amount,gas:entries[msg.sender].budget}(entries[msg.sender].owner); return last;
 }
 function originContext() external returns(address) {
  count++; last=IPay(entries[tx.origin].target).pay{gas:entries[tx.origin].budget,value:entries[tx.origin].amount}(entries[tx.origin].owner); return last;
 }
 function coinbaseContext() external returns(address) {
  count++; last=IPay(entries[block.coinbase].target).pay{value:entries[block.coinbase].amount,gas:entries[block.coinbase].budget}(entries[block.coinbase].owner); return last;
 }
 function selfContext() external returns(address) {
  count++; last=IPay(entries[address(this)].target).pay{value:entries[address(this)].amount,gas:entries[address(this)].budget}(entries[address(this)].owner); return last;
 }
 function lowContext(address target,bytes memory data) external returns(bool,bytes memory) {
  (bool success,bytes memory output)=target.call{value:entries[msg.sender].amount,gas:entries[msg.sender].budget}(data); count++; return(success,output);
 }
 function deliver(address nft,address recipient,uint256 id) external {count++;last=recipient;INFT(nft).transferFrom(address(this),recipient,id);}
 function deliverBudget(address nft,address recipient,uint256 id,uint256 budget) external {count++;last=recipient;INFT(nft).transferFrom{gas:budget}(address(this),recipient,id);}
 function deliverValue(address target,address owner,uint256 id,uint256 amount,uint256 budget) external payable {count++;last=owner;IVoid(target).touch{value:amount,gas:budget}(owner,id);}
 function probe(address target) external {count++;IVoid(target).ping();}
 function verifyOwner(address nft,address owner,uint256 id) external view {INFT(nft).checkOwner(owner,id);}
 function nftOwner(address nft,uint256 id) external view returns(address){return INFT(nft).ownerOf(id);}
 function latestPrice(address target) external view returns(uint80,int256,uint256,uint256,uint80){return IOracle(target).latestRoundData();}
 function recordPrice(address target,int256 price,int112 delta,uint80 round,uint256 amount,uint256 budget) external payable returns(int256,int112,uint80){count++;return IOracle(target).setRound{value:amount,gas:budget}(price,delta,round);}
 function signedLiteral(address target) external pure returns(int112){return IOracle(target).signedEcho(-1);}
 function signedValue(address target,int112 value) external pure returns(int112){return IOracle(target).signedEcho(value);}
 function signedMinimum(address target) external pure returns(int112){return IOracle(target).signedEcho(type(int112).min);}
 function readReserves(address target) external view returns(uint112,uint112,uint32){return IReserves(target).getReserves();}
 function putReserves(address target,uint112 first,uint112 second,uint32 at,uint256 amount,uint256 budget) external payable returns(uint112,uint112,uint32){count++;return IReserves(target).setReserves{value:amount,gas:budget}(first,second,at);}
 function limitReserves(address target) external returns(uint112,uint112,uint32){count++;return IReserves(target).setReserves(type(uint112).max,0,type(uint32).max);}
 function tupleRead(address target,address owner) external view returns(address,uint256,bool,bytes32){return IPosition(target).snapshot(owner);}
 function tupleCapture(address target,address owner,uint256 amount,uint256 budget) external payable returns(address,uint256,bool,bytes32){
  count++;(address who,uint256 size,bool ok,bytes32 tag)=IPosition(target).capture{value:amount,gas:budget}(owner);last=who;return(who,size,ok,tag);
 }
 function tupleFacts(address target,address owner,uint256 amount,bool enabled,bytes32 tag) external pure returns(address,uint256,bool,bytes32){return IPosition(target).facts(owner,amount,enabled,tag);}
 function assetSend(address token,address recipient,uint256 amount) external returns(bool){count++;last=recipient;return IAsset(token).transfer(recipient,amount);}
 function assetToSender(address token,uint256 amount) external returns(bool){count++;last=msg.sender;return IAsset(token).transfer(msg.sender,amount);}
 function assetSupply(address token) external view returns(uint256){return IAsset(token).totalSupply();}
 function assetBalance(address token,address owner) external view returns(uint256){return IAsset(token).balanceOf(owner);}
 function assetAllowance(address token,address owner,address spender) external view returns(uint256){return IAsset(token).allowance(owner,spender);}
 function assetCheck(address token,bytes32 tag,bool enabled) external view returns(bool){return IAsset(token).check(tag,enabled);}
 function invoke(address target,address owner,uint256 amount) external payable returns(address) {
  count++; last=IPay(target).pay{value:amount}(owner); return last;
 }
 function plain(address target,address owner) external returns(address) {
  count++; last=IPay(target).pay(owner); return last;
 }
 function invokeGas(address target,address owner,uint256 amount,uint256 budget) external payable returns(address) {
  count++; last=IPay(target).pay{gas:budget,value:amount}(owner); return last;
 }
 function reverseGas(address target,address owner,uint256 amount,uint256 budget) external payable returns(address) {
  count++; last=IPay(target).pay{value:amount,gas:budget}(owner); return last;
 }
 function lookupGas(address target,address owner,uint256 budget) external view returns(address) {
  return IRead(target).peek{gas:budget}(owner);
 }
 function low(address target,bytes memory data,uint256 amount,uint256 budget) external payable returns(bool,bytes memory) {
  (bool success,bytes memory output)=target.call{gas:budget,value:amount}(data); count++; return(success,output);
 }
 function lowRead(address target,bytes memory data,uint256 amount,uint256 budget) external view returns(bool,bytes memory) {
  return target.staticcall{gas:budget}(data);
 }
 function lowDelegate(address target,bytes memory data,uint256 amount,uint256 budget) external returns(bool,bytes memory) {
  return target.delegatecall{gas:budget}(data);
 }
 function reject(address target,address owner,uint256 amount) external payable {
  count++; last=IPay(target).pay{value:amount}(owner); require(false);
 }
}`;

// Run after npm run build with SHELL_NODE_BIN pointing to a compatible node.
// Isolated genesis allocation avoids making a native CREATE derivation claim.
async function runPayableAcceptance(gasOptions = false, contextOptions = false, staticCalls = false, voidCalls = false, tupleCalls = false, narrowCalls = false, signedCalls = false) {
  const binary = process.env.SHELL_NODE_BIN;
  const resumeDirectory = voidCalls || tupleCalls || narrowCalls || signedCalls ? process.env.SHELL_PQABI_RESUME_DIR : undefined;
  const directory = resumeDirectory ? resolve(resumeDirectory) : await mkdtemp(join(tmpdir(), 'shell-sdk-payable-'));
  const previousReport = resumeDirectory ? JSON.parse(await readFile(join(directory,'report.json'),'utf8')) : undefined;
  const password = resumeDirectory ? await readFile(join(directory,'password.txt'),'utf8') : randomBytes(24).toString('hex');
  const passwordFile = join(directory, 'password.txt');
  const keyFile = join(directory, 'validator.json');
  if(!resumeDirectory) await writeFile(passwordFile, password, { mode: 0o600 });
  if(!resumeDirectory) for (const file of [keyFile, join(directory, 'observer.json'), join(directory, 'payer.json')]) {
    const key = spawnSync(binary, ['--password-file', passwordFile, 'key', 'generate',
      '--algorithm', 'mldsa65', '--output', file], { encoding: 'utf8' });
    assert.equal(key.status, 0, key.stderr);
  }
  const miner = await decryptKeystore(JSON.parse(await readFile(keyFile, 'utf8')), password);
  const payer = await decryptKeystore(JSON.parse(await readFile(join(directory, 'payer.json'), 'utf8')), password);
  const word = value => BigInt(value).toString(16).padStart(64, '0');
  const address = byte => '0x' + byte.repeat(32);
  const reader = address('11'), payee = address('22');
  const alias = '0x' + '33'.repeat(12) + '22'.repeat(20);
  const short = address('44'), missing = address('55'), badBool = address('66'), plain = address('77'), large = address('88');
  const owner = address('aa'), other = '0x' + 'bb'.repeat(12) + 'aa'.repeat(20);
  const zero = '0x' + word(0);
  const lowAlias = account => '0x' + '00'.repeat(12) + account.slice(-40);
  const callerAlias = lowAlias(payer.getAddress());
  const maxId=(1n<<256n)-1n;
  const max112=(1n<<112n)-1n,max32=(1n<<32n)-1n;
  const minInt256=-(1n<<255n),maxInt256=(1n<<255n)-1n,minInt112=-(1n<<111n),maxInt112=(1n<<111n)-1n,max80=(1n<<80n)-1n;
  const signedWord=value=>word(BigInt.asUintN(256,value));
  const badSigned='0x60635f557f'+word(1)+'5f527f'+word(max112)+'602052600160405260605ff3';
  const rawReserves=(first,second,at)=>'0x60635f557f'+word(first)+'5f527f'+word(second)+'6020527f'+word(at)+'60405260605ff3';
  const nftIds=[7n,maxId,99n,100n];
  const nftSlot = id => BigInt(keccak256('0x'+word(id)+word(5)));
  const balanceSlot = key => BigInt(keccak256('0x'+key.slice(2)+word(2)));
  const allowanceSlot = (owner,spender) => BigInt(keccak256('0x'+spender.slice(2)+keccak256('0x'+owner.slice(2)+word(4)).slice(2)));
  const quantity = value => '0x'+BigInt(value).toString(16);
  const entrySlots = key => Array.from({length:4},(_,index)=>'0x'+((BigInt(keccak256('0x'+key.slice(2)+word(2)))+BigInt(index))&((1n<<256n)-1n)).toString(16));
  const artifacts = {};
  for (const contractName of ['Reader', 'Payee']) {
    const options = { sources: [{ path: 'Payable.sol', content: source }], contractName, evmVersion: 'shanghai' };
    const original = await compileSolidity(options);
    artifacts[contractName] = await compileSolidity({ ...options, target: 'pqvm', nativeAddressContextHeight: voidCalls || tupleCalls || narrowCalls || signedCalls ? 2 : 0 });
    assert.deepEqual(artifacts[contractName].abi, original.abi);
  }
  const ports = [];
  for (let i = 0; i < 2; i++) {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    ports.push(server.address().port);
    await new Promise(resolve => server.close(resolve));
  }
  assert.notEqual(...ports);
  const freshReport = { directory, binarySha256: createHash('sha256').update(await readFile(binary)).digest('hex'),
    artifacts, source, opens: [], transactions: [], adaptations: [
      `Source compiler; isolated Dev chain 1337, native context at height ${voidCalls || tupleCalls || narrowCalls || signedCalls ? 2 : 0}, fee accounting at genesis.`,
      'Fresh ML-DSA keys; full RocksDB producer and independent non-authority observer.',
      'Runtime allocation is not native CREATE or public tutorial deployment acceptance.' ] };
  if(previousReport) {
    assert.equal(previousReport.directory,directory);assert.equal(previousReport.binarySha256,freshReport.binarySha256);
    assert.equal(previousReport.source,source);assert.deepEqual(previousReport.artifacts,JSON.parse(JSON.stringify(artifacts)));
    assert.ok(previousReport.opens.every(entry=>entry.exitCode===0));
  }
  const report=previousReport??freshReport;
  const acceptedPrefix=previousReport?.transactions.length??0;let prefixCursor=0;
  if(previousReport) {report.resumedFrom='report.json';report.acceptedPrefix=acceptedPrefix;delete report.error;}
  const reportName=resumeDirectory?'report-resumed.json':'report.json';
  const save = () => writeFile(join(directory, reportName), JSON.stringify(report, null, 2));
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const provider = createShellProvider({ rpcHttpUrl: `http://127.0.0.1:${ports[0]}` });
  const nodes = [], dirs = [join(directory, 'leader'), join(directory, 'observer')];
  async function rpc(i, method, params = []) {
    await pause(100);
    const response = await fetch(`http://127.0.0.1:${ports[i]}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}: ${await response.text()}`);
    const body = await response.json();
    if (body.error) throw Object.assign(new Error(JSON.stringify(body.error)), { rpcError: body.error });
    return body.result;
  }
  async function stop(i) {
    const child = nodes[i]; if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000); timer.unref();
      try { await closed; } finally { clearTimeout(timer); }
    }
    const opened = report.opens.findLast(x => x.pid === child.pid);
    opened.exitCode = child.exitCode; opened.signal = child.signalCode;
    nodes[i] = undefined;
    assert.equal(child.exitCode, 0);
  }
  async function start(i, bootnode) {
    const label = `${i}-${report.opens.length}`;
    const args = ['run', '--datadir', dirs[i], '--keystore', i ? join(directory, 'observer.json') : keyFile,
      '--password-file', passwordFile, '--rpc-addr', `127.0.0.1:${ports[i]}`, '--metrics-addr', '127.0.0.1:0',
      '--block-time', '2000', '--max-idle-interval', '1209600000', '--network', 'dev',
      '--consensus-engine', 'wpoa', '--chain-id', '1337', '--db', 'rocksdb', '--storage-profile', 'full',
      '--rpc-api', 'eth,net,web3,shell,debug,trace', '--p2p', '--p2p-addr', '127.0.0.1:0', '--log-level', 'info'];
    if (bootnode) args.push('--bootnode', bootnode);
    const log = join(directory, label + '.log');
    const fd = openSync(log, 'w');
    const child = spawn(binary, args, { stdio: ['ignore', fd, fd] }); closeSync(fd);
    nodes[i] = child; report.opens.push({ pid: child.pid, args, log }); await save();
    for (let attempt = 0; attempt < 160; attempt++) {
      assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
      try { if (await rpc(i, 'eth_chainId') === '0x539') return log; } catch {}
      await pause(100);
    }
    throw new Error('node startup timeout');
  }
  async function peer(log) {
    for (let attempt = 0; attempt < 160; attempt++) {
      const match = (await readFile(log, 'utf8')).match(/Listening on (\/ip4\/127\.0\.0\.1\/tcp\/\d+\/p2p\/[a-zA-Z0-9]+)/);
      if (match) return match[1]; await pause(100);
    }
    throw new Error('peer address timeout');
  }
  const request = (target, beneficiary, amount, fn = 'invoke', budget = 100000n) => {
    const gas = ['invokeGas','reverseGas','lookupGas'].includes(fn);
    const args = [target, beneficiary, ...(fn === 'plain' || fn === 'lookupGas' ? [] : [amount]), ...(gas ? [budget] : [])];
    const data = encodeFunctionData({ abi: artifacts.Reader.abi, functionName: fn, args });
    const signature = `${fn}(address,address${fn === 'plain' || fn === 'lookupGas' ? '' : ',uint256'}${gas ? ',uint256' : ''})`;
    assert.equal(data, toFunctionSelector(signature) + args.map(word).join(''));
    return { from: payer.getAddress(), to: reader, gas: '0x927c0', data };
  };
  const state = async (i, tag = 'latest') => {
    const accounts = {};
    for (const target of [reader, payee, alias, short, missing, badBool, plain, large, payer.getAddress(), miner.getAddress()]) {
      accounts[target] = { balance: await rpc(i, 'eth_getBalance', [target, tag]),
        nonce: await rpc(i, 'eth_getTransactionCount', [target, tag]), slots: [] };
      for (const slot of ['0x0', '0x1']) accounts[target].slots.push(await rpc(i, 'eth_getStorageAt', [target, slot, tag]));
      if(signedCalls && [payee,alias].includes(target)) {
        accounts[target].oracle={};
        for(const[slot,name]of [['0x7','price'],['0x8','deltaRound'],['0x9','time']]) accounts[target].oracle[name]=await rpc(i,'eth_getStorageAt',[target,slot,tag]);
      }
      if(narrowCalls && [payee,alias].includes(target)) accounts[target].reservesWord=await rpc(i,'eth_getStorageAt',[target,'0x6',tag]);
      if(voidCalls && [payee,alias].includes(target)) {
        accounts[target].owners={};
        for(const id of nftIds) accounts[target].owners[id.toString()]=await rpc(i,'eth_getStorageAt',[target,quantity(nftSlot(id)),tag]);
      }
      if(staticCalls && [payee,alias].includes(target)) {
        accounts[target].tokens={};
        for(const key of [reader,owner,other,payer.getAddress(),callerAlias,zero]) accounts[target].tokens[key]=await rpc(i,'eth_getStorageAt',[target,quantity(balanceSlot(key)),tag]);
      }
      if (contextOptions && target===reader) {
        accounts[target].entryWords={};
        for(const key of [payer.getAddress(),callerAlias]) {
          accounts[target].entryWords[key]=[];
          for(const slot of entrySlots(key)) accounts[target].entryWords[key].push(await rpc(i,'eth_getStorageAt',[reader,slot,tag]));
        }
      }
    }
    return accounts;
  };
  let nonce = 0;
  async function send(label, calls, value, success, aa = false) {
    if(prefixCursor<acceptedPrefix) {
      const entry=report.transactions[prefixCursor++];assert.equal(entry.label,label);assert.equal(entry.aa,aa);
      assert.equal(entry.receipt.status,success?'0x1':'0x0');
      entry.trace??=await rpc(0,'debug_traceTransaction',[entry.hash,{tracer:'callTracer'}]);
      entry.after??=await state(0,entry.receipt.blockNumber);
      if(!aa) assert.equal(entry.trace.input,calls[0].data);
      assert.deepEqual(await rpc(0,'eth_getTransactionReceipt',[entry.hash]),entry.receipt);
      return entry;
    }
    const before = await state(0);
    const built = aa ? buildBatchTransaction({ chainId: 1337, nonce, gasLimit: Math.max(1200000, calls.length * 500000 + 100000),
      innerCalls: calls.map(call => buildInnerCall(reader, call.data, 500000, 0n)) }) : null;
    const tx = built?.tx ?? buildTransaction({ chainId: 1337, nonce, to: reader,
      data: calls[0].data, value, gasLimit: 600000 });
    const signed = await payer.buildSignedTransaction({ tx, ...(built ? { aaBundle: built.aa_bundle } : {}), includePublicKey: true });
    const hash = await provider.sendTransaction(signed);
    const entry = { label, hash, aa, before }; report.transactions.push(entry); await save();
    for (let attempt = 0; attempt < 160; attempt++) {
      entry.receipt = await rpc(0, 'eth_getTransactionReceipt', [hash]);
      if (entry.receipt) break; await pause(100);
    }
    assert.equal(entry.receipt?.status, success ? '0x1' : '0x0', label);
    nonce++; entry.after = await state(0);
    entry.trace = await rpc(0, 'debug_traceTransaction', [hash, { tracer: 'callTracer' }]);
    const fee = BigInt(entry.receipt.gasUsed) * BigInt(entry.receipt.effectiveGasPrice);
    assert.equal(BigInt(before[payer.getAddress()].balance) - BigInt(entry.after[payer.getAddress()].balance), fee + (success ? value : 0n));
    assert.equal(BigInt(entry.after[miner.getAddress()].balance) - BigInt(before[miner.getAddress()].balance), fee);
    assert.equal(BigInt(entry.after[payer.getAddress()].nonce), BigInt(nonce));
    if (!success) for (const target of [reader, payee, alias, short, missing, badBool, plain, large]) assert.deepEqual(entry.after[target], before[target]);
    for (let attempt = 0; attempt < 160; attempt++) {
      const block = await rpc(1, 'eth_getBlockByNumber', [entry.receipt.blockNumber, false]);
      if (block?.hash === entry.receipt.blockHash) break; await pause(100);
    }
    assert.equal((await rpc(1, 'eth_getBlockByNumber', [entry.receipt.blockNumber, false])).hash, entry.receipt.blockHash);
    assert.deepEqual(await rpc(1, 'eth_getTransactionReceipt', [hash]), entry.receipt);
    assert.deepEqual(await state(1), entry.after); await save(); return entry;
  }
  try {
    const genesis = { chain_id: 1337, network_type: 'Dev', timestamp: Math.floor(Date.now() / 1000) - 120,
      gas_limit: 30000000, registered_key_algorithm_height: 0, native_address_context_height: voidCalls || tupleCalls || narrowCalls || signedCalls ? 2 : 0,
      fee_accounting_activation_height: 0, aa_account_manager_height: 0,
      consensus: { engine: 'wpoa', authorities: [miner.getAddress()],
        authority_pubkeys: ['0x' + Buffer.from(miner.getPublicKey()).toString('hex')], weights: [1],
        stakes: [], block_time_secs: 2, max_future_secs: 300, epoch_length: 0 }, alloc: {} };
    for (const account of [miner.getAddress(), payer.getAddress()]) genesis.alloc[account] = { balance: '0x3635c9adc5dea00000', nonce: 0 };
    for (const [account, code] of [[reader, artifacts.Reader.deployedBytecode], [payee, artifacts.Payee.deployedBytecode],
      [alias, artifacts.Payee.deployedBytecode], [short, signedCalls ? badSigned : narrowCalls ? rawReserves(1n,2n,max32+1n) : tupleCalls ? '0x60635f5560605ff3' : '0x60635f55601f5ff3'], [badBool, narrowCalls ? rawReserves(max112+1n,2n,3n) : tupleCalls ? '0x60635f557f'+owner.slice(2)+'5f527f'+word(maxId)+'6020526002604052600760605260805ff3' : '0x60635f5560025f5260205ff3'], [large, '0x60635f556110005ff3']]) {
      genesis.alloc[account] = { balance: '0x0', nonce: 1, code, storage: {} };
    }
    if(voidCalls) {
      genesis.alloc[plain]={balance:'0x9',nonce:1,code:null,storage:null};
      for(const token of [payee,alias]) genesis.alloc[token].storage={['0x'+word(nftSlot(7n))]:reader,['0x'+word(nftSlot(maxId))]:reader};
    }
    if(staticCalls) for(const[token,total]of [[payee,100n],[alias,200n]]) {
      genesis.alloc[token].storage={
        ['0x'+word(balanceSlot(reader))]:'0x'+word(total),['0x'+word(3)]:'0x'+word(total),
        ['0x'+word(allowanceSlot(owner,other))]:'0x'+word(83),['0x'+word(allowanceSlot(other,owner))]:'0x'+word(17),
      };
    }
    if(!resumeDirectory) for (const dir of dirs) { await mkdir(dir); await writeFile(join(dir, 'genesis.json'), JSON.stringify(genesis)); }
    else for(const dir of dirs) {
      const retained=JSON.parse(await readFile(join(dir,'genesis.json'),'utf8'));assert.equal(retained.chain_id,1337);assert.equal(retained.native_address_context_height,2);
    }
    await start(1, await peer(await start(0)));
    if(resumeDirectory) {
      nonce=Number(BigInt(await rpc(0,'eth_getTransactionCount',[payer.getAddress(),'latest'])));assert.equal(nonce,acceptedPrefix);
      const last=report.transactions.at(-1);last.after??=await state(0,last.receipt.blockNumber);
      assert.deepEqual(await state(0),last.after);
    }
    let first;
    const lowRequest = (target, beneficiary, amount, budget, fn = 'low') => {
      const payload = toFunctionSelector(fn === 'lowRead' ? 'peek(address)' : 'pay(address)') + beneficiary.slice(2);
      return { from: payer.getAddress(), to: reader, gas: '0x927c0', data: encodeFunctionData({ abi: artifacts.Reader.abi,
        functionName: fn, args: [target, payload, amount, budget] }) };
    };
    const gasWord = (entry, opcode, budget) => {
      const step = entry.trace.structLogs.find(step => step.depth === 1 && step.op === opcode);
      assert.ok(step, `missing ${opcode}`); assert.equal(BigInt(step.stack.at(-1)), budget);
    };
    const contextRequest = fn => ({from:payer.getAddress(),to:reader,gas:'0x927c0',
      data:toFunctionSelector(`${fn}()`)});
    const configureRequest = (key,target,beneficiary,amount,budget) => {
      const args=[key,target,beneficiary,amount,budget];
      const data=encodeFunctionData({abi:artifacts.Reader.abi,functionName:'configure',args});
      assert.equal(data,toFunctionSelector('configure(address,address,address,uint256,uint256)')+args.map(word).join(''));
      return {from:payer.getAddress(),to:reader,gas:'0x927c0',data};
    };
    const assetRequest = (fn,args) => ({from:payer.getAddress(),to:reader,gas:'0x927c0',
      data:encodeFunctionData({abi:artifacts.Reader.abi,functionName:fn,args})});
    const boolean = (entry,value) => assert.equal(entry.trace.output,'0x'+word(value?1:0));
    const tupleOutput=(who,size,ok,tag='0x'+word(7))=>who+word(size)+word(ok?1:0)+tag.slice(2);
    const reservesOutput=(a,b,at)=>'0x'+word(a)+word(b)+word(at);
    const reservesWord=(a,b,at)=>'0x'+word(a+(b<<112n)+(at<<224n));
    const signedOutput=(price,delta,round)=>'0x'+signedWord(price)+signedWord(delta)+word(round);
    const oracleOutput=(round,price,time)=>'0x'+word(round)+signedWord(price)+word(time)+word(time)+word(round);
    const oracleWords=(price,delta,round,time)=>({price:'0x'+signedWord(price),deltaRound:'0x'+word(BigInt.asUintN(112,delta)+(round<<112n)),time:'0x'+word(time)});
    if(signedCalls) {
      const pre=await send('signed guard before native activation',[assetRequest('latestPrice',[payee])],0n,false);assert.equal(BigInt(pre.receipt.blockNumber),1n);
      const underfunded=await send('signed MIN values at activation boundary',[assetRequest('recordPrice',[payee,minInt256,minInt112,1n,3n,100000n])],9n,false);
      assert.equal(BigInt(underfunded.receipt.blockNumber),2n);assert.match(underfunded.trace.calls[0].error,/OutOfGas/);gasWord(underfunded,'CALL',100000n);
      for(const target of [reader,payee,alias]) assert.deepEqual(underfunded.after[target],underfunded.before[target]);
      first=await send('signed MIN values with sufficient callee gas',[assetRequest('recordPrice',[payee,minInt256,minInt112,1n,3n,200000n])],9n,true);
      assert.equal(BigInt(first.receipt.blockNumber),3n);assert.equal(first.trace.output,signedOutput(minInt256,minInt112,1n));gasWord(first,'CALL',200000n);
      assert.equal(first.trace.calls[0].input,toFunctionSelector('setRound(int256,int112,uint80)')+signedWord(minInt256)+signedWord(minInt112)+word(1));
      const firstTime=BigInt((await rpc(0,'eth_getBlockByNumber',[first.receipt.blockNumber,false])).timestamp);assert.deepEqual(first.after[payee].oracle,oracleWords(minInt256,minInt112,1n,firstTime));report.firstOracleTime=firstTime.toString();
      const maximum=await send('signed MAX and separate same-low20 feed',[assetRequest('recordPrice',[alias,maxInt256,maxInt112,max80,2n,200000n])],0n,true);
      assert.equal(maximum.trace.output,signedOutput(maxInt256,maxInt112,max80));assert.deepEqual(maximum.before[payee],maximum.after[payee]);
      const malformed=await send('signed result bad sign extension restores writes',[assetRequest('recordPrice',[short,-7n,-1n,2n,1n,100000n])],3n,false);
      assert.equal(malformed.trace.calls[0].output,'0x'+word(1)+word(max112)+word(1));
      const invalid=assetRequest('recordPrice',[payee,5n,1n,2n,0n,100000n]);invalid.data=invalid.data.slice(0,138)+word(max112)+invalid.data.slice(202);
      const rejected=await send('signed outer bad sign extension rejects before CALL',[invalid],0n,false);assert.equal((rejected.trace.calls??[]).length,0);
      await send('signed zero-gas stipend rolls back',[assetRequest('recordPrice',[payee,-7n,-1n,2n,1n,0n])],3n,false);
      await send('signed AA later rejection restores price delta round time',[
        assetRequest('recordPrice',[payee,-7n,-1n,2n,1n,100000n]),assetRequest('recordPrice',[alias,42n,0n,0n,1n,100000n])],0n,false,true);
      const batch=await send('signed AA both feed updates persist',[
        assetRequest('recordPrice',[payee,-7n,-1n,2n,1n,100000n]),assetRequest('recordPrice',[alias,42n,0n,3n,1n,100000n])],0n,true,true);
      const batchTime=BigInt((await rpc(0,'eth_getBlockByNumber',[batch.receipt.blockNumber,false])).timestamp);report.lastOracleTime=batchTime.toString();
      assert.deepEqual(batch.after[payee].oracle,oracleWords(-7n,-1n,2n,batchTime));assert.deepEqual(batch.after[alias].oracle,oracleWords(42n,0n,3n,batchTime));
      for(const[target,round,price]of [[payee,2n,-7n],[alias,3n,42n]]) {
        const view=await send('signed latestRoundData '+target.slice(2,4),[assetRequest('latestPrice',[target])],0n,true);
        assert.equal(view.trace.output,oracleOutput(round,price,batchTime));assert.equal(view.trace.calls[0].type,'STATICCALL');assert.equal(view.trace.calls[0].input,toFunctionSelector('latestRoundData()'));
        assert.deepEqual(decodeFunctionResult({abi:artifacts.Reader.abi,functionName:'latestPrice',data:view.trace.output}),[round,price,batchTime,batchTime,round]);
      }
      const literal=await send('signed negative literal executes unchanged',[assetRequest('signedLiteral',[payee])],0n,true);assert.equal(literal.trace.output,'0x'+signedWord(-1n));assert.equal(literal.trace.calls[0].type,'STATICCALL');
      for(const value of [minInt112,maxInt112,0n]) {
        const echo=await send('signed narrow boundary '+value,[assetRequest('signedValue',[payee,value])],0n,true);assert.equal(echo.trace.output,'0x'+signedWord(value));
        assert.equal(decodeFunctionResult({abi:artifacts.Reader.abi,functionName:'signedValue',data:echo.trace.output}),value);
      }
      assert.equal(await rpc(0,'eth_call',[assetRequest('signedMinimum',[payee]),'latest']),'0x'+signedWord(minInt112));
      report.signedCalls={passed:true,activationHeight:2,widths:[112,256],negativeLiteral:true};
    } else if(narrowCalls) {
      const pre=await send('narrow reserves guard before activation',[assetRequest('readReserves',[payee])],0n,false);assert.equal(BigInt(pre.receipt.blockNumber),1n);
      first=await send('narrow MAX values at activation boundary',[assetRequest('putReserves',[payee,max112,1n,max32,3n,100000n])],9n,true);
      assert.equal(BigInt(first.receipt.blockNumber),2n);assert.equal(first.trace.output,reservesOutput(max112,1n,max32));gasWord(first,'CALL',100000n);
      assert.equal(first.trace.calls[0].input,toFunctionSelector('setReserves(uint112,uint112,uint32)')+word(max112)+word(1)+word(max32));
      assert.equal(first.after[payee].reservesWord,reservesWord(max112,1n,max32));
      const alternate=await send('narrow reserves independent same-low20 target',[assetRequest('putReserves',[alias,2n,max112,0n,2n,100000n])],0n,true);
      assert.equal(alternate.trace.output,reservesOutput(2n,max112,0n));assert.deepEqual(alternate.before[payee],alternate.after[payee]);
      for(const[target,output]of [[badBool,reservesOutput(max112+1n,2n,3n)],[short,reservesOutput(1n,2n,max32+1n)]]) {
        const rejected=await send('narrow return overflow '+target.slice(2,4),[assetRequest('putReserves',[target,4n,5n,6n,1n,100000n])],3n,false);
        assert.equal(rejected.trace.calls[0].output,output);
      }
      const invalid=assetRequest('putReserves',[payee,1n,2n,3n,0n,100000n]);invalid.data=invalid.data.slice(0,74)+word(max112+1n)+invalid.data.slice(138);
      const rejectedInput=await send('narrow outer input overflow rejected',[invalid],0n,false);assert.equal((rejectedInput.trace.calls??[]).length,0);
      await send('narrow zero-gas stipend rolls back',[assetRequest('putReserves',[payee,4n,5n,6n,1n,0n])],3n,false);
      await send('narrow AA later decode failure restores earlier reserve write',[
        assetRequest('putReserves',[payee,5n,6n,7n,1n,100000n]),assetRequest('putReserves',[badBool,8n,9n,10n,1n,100000n])],0n,false,true);
      await send('narrow AA both reserve writes persist',[
        assetRequest('putReserves',[payee,11n,12n,13n,1n,100000n]),assetRequest('putReserves',[alias,21n,22n,23n,1n,100000n])],0n,true,true);
      const limits=await send('narrow unsigned metatype limits retained',[assetRequest('limitReserves',[payee])],0n,true);assert.equal(limits.trace.output,reservesOutput(max112,0n,max32));
      for(const[target,expected]of [[payee,[max112,0n,max32]],[alias,[21n,22n,23n]]]) {
        const viewed=await send('narrow reserve view '+target.slice(2,4),[assetRequest('readReserves',[target])],0n,true);
        assert.equal(viewed.trace.output,reservesOutput(...expected));assert.equal(viewed.trace.calls[0].input,toFunctionSelector('getReserves()'));assert.equal(viewed.trace.calls[0].type,'STATICCALL');
        assert.deepEqual(decodeFunctionResult({abi:artifacts.Reader.abi,functionName:'readReserves',data:viewed.trace.output}),[expected[0],expected[1],Number(expected[2])]);
      }
      report.narrowCalls={passed:true,activationHeight:2,widths:[112,32],canonicalArgumentsAndResults:true};
    } else if(tupleCalls) {
      const read=assetRequest('tupleRead',[payee,owner]);
      const pre=await send('tuple guard before native activation',[read],0n,false);assert.equal(BigInt(pre.receipt.blockNumber),1n);
      first=await send('tuple capture at activation boundary',[assetRequest('tupleCapture',[payee,owner,3n,100000n])],9n,true);
      assert.equal(BigInt(first.receipt.blockNumber),2n);assert.equal(first.trace.output,tupleOutput(owner,1n,true));gasWord(first,'CALL',100000n);
      assert.equal(first.trace.calls[0].input,toFunctionSelector('capture(address)')+owner.slice(2));
      const alternate=await send('tuple same-low20 identities',[assetRequest('tupleCapture',[alias,other,2n,100000n])],0n,true);
      assert.equal(alternate.trace.output,tupleOutput(other,1n,true));assert.deepEqual(alternate.before[payee],alternate.after[payee]);
      const malformed=await send('tuple noncanonical bool restores callee writes and value',[assetRequest('tupleCapture',[badBool,other,1n,100000n])],3n,false);
      assert.equal(malformed.trace.calls[0].output,owner+word(maxId)+word(2)+word(7));
      const truncated=await send('tuple truncated result restores callee writes and value',[assetRequest('tupleCapture',[short,other,1n,100000n])],3n,false);
      assert.equal(truncated.trace.calls[0].output.length,194);
      await send('tuple empty-code decode rejection',[assetRequest('tupleCapture',[missing,other,0n,100000n])],0n,false);
      await send('tuple zero-gas stipend failure',[assetRequest('tupleCapture',[payee,other,1n,0n])],3n,false);
      const rollback=await send('tuple AA second failure restores first capture',[
        assetRequest('tupleCapture',[payee,other,1n,100000n]),assetRequest('tupleCapture',[alias,zero,1n,100000n])],0n,false,true);
      assert.equal(rollback.receipt.logs.length,0);
      await send('tuple AA both captures persist',[
        assetRequest('tupleCapture',[payee,other,1n,100000n]),assetRequest('tupleCapture',[alias,owner,1n,100000n])],0n,true,true);
      const viewed=await send('tuple view preserves false',[read],0n,true);
      assert.equal(viewed.trace.output,tupleOutput(other,2n,false));assert.equal(viewed.trace.calls[0].type,'STATICCALL');
      for(const[who,size,ok,tag]of [[other,maxId,false,'0x'+word(maxId)],[owner,0n,true,zero]]) {
        const facts=await send('tuple pure boundary '+size,[assetRequest('tupleFacts',[payee,who,size,ok,tag])],0n,true);
        assert.equal(facts.trace.output,tupleOutput(who,size,ok,tag));assert.equal(facts.trace.calls[0].type,'STATICCALL');
        assert.deepEqual(decodeFunctionResult({abi:artifacts.Reader.abi,functionName:'tupleFacts',data:facts.trace.output}),[who,size,ok,tag]);
      }
      const aliasView=await send('tuple alternate owner remains full32',[assetRequest('tupleRead',[alias,owner])],0n,true);
      assert.equal(aliasView.trace.output,tupleOutput(owner,2n,true));
      report.tupleCalls={passed:true,activationHeight:2,staticFields:['address','uint256','bool','bytes32']};
    } else if(voidCalls) {
      const pre=await send('void guard before native activation',[assetRequest('probe',[payee])],0n,false);
      assert.equal(BigInt(pre.receipt.blockNumber),1n);assert.ok(!pre.trace.structLogs.some(step=>step.depth===1 && step.op==='EXTCODESIZE'));
      first=await send('void NFT transfer at activation boundary',[assetRequest('deliver',[payee,owner,7n])],0n,true);
      assert.equal(BigInt(first.receipt.blockNumber),2n);assert.equal(first.trace.output,'0x');
      assert.equal(first.trace.calls[0].input,toFunctionSelector('transferFrom(address,address,uint256)')+reader.slice(2)+owner.slice(2)+word(7));
      assert.equal(first.after[payee].owners['7'],owner);
      const alternate=await send('void same-low20 NFT target',[assetRequest('deliver',[alias,other,7n])],0n,true);
      assert.deepEqual(alternate.after[payee],alternate.before[payee]);
      await send('void explicit zero gas rejects',[assetRequest('deliverBudget',[payee,other,maxId,0n])],0n,false);
      for(const target of [missing,plain]) {
        const entry=await send('void rejects no-code target '+target.slice(2,4),[assetRequest('deliver',[target,other,maxId])],0n,false);
        assert.equal((entry.trace.calls??[]).length,0);
        const step=entry.trace.structLogs.find(step=>step.depth===1 && step.op==='EXTCODESIZE');assert.ok(step);assert.equal(BigInt(step.stack.at(-1)),BigInt(target));
      }
      for(const target of [badBool,large]) {
        const entry=await send('void ignores success returndata '+target.slice(2,4),[assetRequest('probe',[target])],0n,true);
        assert.equal(entry.trace.output,'0x');assert.equal(entry.after[target].slots[0],'0x'+word(99));
        assert.ok(!entry.trace.structLogs.some(step=>step.depth===1 && step.op==='RETURNDATACOPY'));
        assert.equal(entry.trace.calls[0].output.length,target===large?8194:66);
      }
      const value=await send('void value and gas write persists',[assetRequest('deliverValue',[payee,other,99n,5n,100000n])],9n,true);
      assert.equal(value.after[reader].balance,'0x4');assert.equal(value.after[payee].balance,'0x5');assert.equal(value.after[payee].owners['99'],other);
      gasWord(value,'CALL',100000n);
      await send('void value stipend failure rolls back',[assetRequest('deliverValue',[payee,owner,100n,1n,0n])],3n,false);
      const viewed=await send('void view uses STATICCALL',[assetRequest('verifyOwner',[payee,owner,7n])],0n,true);
      assert.equal(viewed.trace.output,'0x');assert.equal(viewed.trace.calls[0].type,'STATICCALL');
      const denied=await send('void propagates exact custom revert',[assetRequest('verifyOwner',[payee,other,7n])],0n,false);
      assert.equal(denied.trace.output,toFunctionSelector('WrongOwner(address,uint256)')+other.slice(2)+word(7));
      const rolled=await send('void AA second failure restores earlier ownership',[
        assetRequest('deliver',[payee,other,maxId]),assetRequest('deliver',[payee,other,7n])],0n,false,true);assert.equal(rolled.receipt.logs.length,0);
      await send('void AA transfers persist for both full32 NFT identities',[
        assetRequest('deliver',[payee,other,maxId]),assetRequest('deliver',[alias,owner,maxId])],0n,true,true);
      await send('void zero-argument call persists',[assetRequest('probe',[payee])],0n,true);
      report.voidCalls={passed:true,activationHeight:2,codeCheck:true,noSuccessReturndataCopy:true};
    } else if(staticCalls) {
      first=await send('two static arguments return true and transfer',[assetRequest('assetSend',[payee,owner,10n])],0n,true);
      boolean(first,true);assert.equal(first.trace.calls[0].input,toFunctionSelector('transfer(address,uint256)')+owner.slice(2)+word(10));
      assert.equal(first.after[payee].tokens[owner],'0x'+word(10));assert.equal(first.after[alias].tokens[reader],'0x'+word(200));
      const contextual=await send('direct native caller static argument',[assetRequest('assetToSender',[payee,5n])],0n,true);
      boolean(contextual,true);assert.equal(contextual.after[payee].tokens[payer.getAddress()],'0x'+word(5));assert.equal(contextual.after[payee].tokens[callerAlias],'0x'+word(0));
      const refused=await send('false bool is returned without automatic revert',[assetRequest('assetSend',[payee,zero,1n])],0n,true);
      boolean(refused,false);assert.deepEqual(refused.after[payee],refused.before[payee]);assert.equal(refused.receipt.logs.length,0);
      const alternate=await send('same-low20 token identity remains distinct',[assetRequest('assetSend',[alias,other,7n])],0n,true);
      boolean(alternate,true);assert.deepEqual(alternate.after[payee],alternate.before[payee]);
      const malformed=await send('noncanonical bool restores callee writes',[assetRequest('assetSend',[badBool,owner,1n])],0n,false);
      assert.equal(malformed.trace.calls[0].output,'0x'+word(2));
      await send('insufficient token transfer restores parent and token',[assetRequest('assetSend',[payee,owner,1000n])],0n,false);
      const rolled=await send('AA second transfer failure restores earlier token state',[
        assetRequest('assetSend',[payee,owner,4n]),assetRequest('assetSend',[payee,other,1000n])],0n,false,true);
      assert.equal(rolled.receipt.logs.length,0);
      const batch=await send('AA two multiargument token transfers succeed',[
        assetRequest('assetSend',[payee,owner,3n]),assetRequest('assetSend',[payee,other,2n])],0n,true,true);
      assert.equal(batch.receipt.logs.length,2);
      const supplied=await send('zero argument typed supply query',[assetRequest('assetSupply',[payee])],0n,true);
      assert.equal(supplied.trace.output,'0x'+word(100));assert.equal(supplied.trace.calls[0].input,toFunctionSelector('totalSupply()'));assert.equal(supplied.trace.calls[0].type,'STATICCALL');
      const allowed=await send('two full32 view arguments retain their order',[assetRequest('assetAllowance',[payee,owner,other])],0n,true);
      assert.equal(allowed.trace.output,'0x'+word(83));assert.equal(allowed.trace.calls[0].input,toFunctionSelector('allowance(address,address)')+owner.slice(2)+other.slice(2));
      const empty=await send('zero token amount preserves true boolean',[assetRequest('assetSend',[payee,owner,0n])],0n,true);
      boolean(empty,true);assert.equal(empty.receipt.logs[0].data,'0x'+word(0));
      for(const[tag,enabled,expected]of [[7n,true,true],[7n,false,false],[8n,true,false]]) {
        const data=await rpc(0,'eth_call',[assetRequest('assetCheck',[payee,'0x'+word(tag),enabled]),'latest']);
        assert.equal(data,'0x'+word(expected?1:0));
      }
      report.staticCalls={passed:true,boolFalsePreserved:true,malformedBoolRejected:true,zeroAndMultipleArguments:true};
    } else if (contextOptions) {
      const keys=[payer.getAddress(),miner.getAddress(),reader];
      const allKeys=keys.flatMap(key=>[key,lowAlias(key)]);
      assert.equal(new Set(allKeys).size,6);
      await send('configure full32 caller/coinbase/self and alias entries',keys.flatMap(key=>[
        configureRequest(key,payee,owner,1n,100000n),configureRequest(lowAlias(key),alias,other,2n,0n)]),0n,true,true);
      for(const key of allKeys) {
        const expected=keys.includes(key)?[payee,owner,1n,100000n]:[alias,other,2n,0n];
        for(const[index,slot]of entrySlots(key).entries()) assert.equal(await rpc(0,'eth_getStorageAt',[reader,slot,'latest']),'0x'+word(expected[index]));
      }
      first=await send('nested caller receiver and argument', [contextRequest('contextual')],9n,true);
      assert.equal(first.trace.output,owner);assert.equal(first.trace.calls[0].to.toLowerCase(),payee);
      assert.equal(first.after[alias].slots[0],'0x'+word(0));
      for(const fn of ['contextOptions','originContext','coinbaseContext','selfContext']) {
        const entry=await send('nested context target/owner/value/gas '+fn,[contextRequest(fn)],0n,true);
        assert.equal(entry.trace.output,owner);assert.equal(entry.trace.calls[0].to.toLowerCase(),payee);
        assert.equal(BigInt(entry.trace.calls[0].value),1n);gasWord(entry,'CALL',100000n);
      }
      const low=await send('low-level nested caller value and gas',[{from:payer.getAddress(),to:reader,gas:'0x927c0',
        data:encodeFunctionData({abi:artifacts.Reader.abi,functionName:'lowContext',args:[payee,toFunctionSelector('pay(address)')+owner.slice(2)]})}],0n,true);
      assert.deepEqual(decodeFunctionResult({abi:artifacts.Reader.abi,functionName:'lowContext',data:low.trace.output}),[true,owner]);
      gasWord(low,'CALL',100000n);
      await send('AA failure restores mapping policy and earlier callee value',[
        configureRequest(payer.getAddress(),alias,other,2n,100000n),contextRequest('contextOptions'),request(payee,owner,0n,'invokeGas',0n)],0n,false,true);
      await send('AA nested full32 caller context succeeds',[contextRequest('contextOptions')],0n,true,true);
      await send('change caller mapping after original historical block',[configureRequest(payer.getAddress(),payee,other,2n,90000n)],0n,true);
      const changed=await send('updated context uses changed owner value and gas',[contextRequest('contextOptions')],0n,true);
      assert.equal(changed.trace.output,other);gasWord(changed,'CALL',90000n);
      assert.equal(BigInt(changed.trace.calls[0].value),2n);
      report.nestedContext={passed:true,keys,aliases:keys.map(lowAlias),mappingSlot:2,
        nativeContextReads:['caller','origin','coinbase','address'],mappingRollback:true};
    } else if (gasOptions) {
      first = await send('typed explicit gas/value', [request(payee, owner, 7n, 'invokeGas')], 9n, true);
      gasWord(first, 'CALL', 100000n);
      assert.equal(first.trace.calls[0].to.toLowerCase(), payee);
      assert.equal(first.trace.calls[0].input, toFunctionSelector('pay(address)') + owner.slice(2));
      const reversed = await send('reversed options same-low20 alias', [request(alias, other, 4n, 'reverseGas')], 5n, true);
      gasWord(reversed, 'CALL', 100000n);
      const lowGas = await send('typed zero gas reverts', [request(payee, owner, 0n, 'invokeGas', 0n)], 0n, false);
      gasWord(lowGas, 'CALL', 0n);
      const stipend = await send('typed zero gas value stipend cannot store', [request(payee, owner, 1n, 'invokeGas', 0n)], 0n, false);
      gasWord(stipend, 'CALL', 0n);
      const refused = await send('low-level zero gas returns false', [lowRequest(payee, owner, 0n, 0n)], 0n, true);
      gasWord(refused, 'CALL', 0n);
      assert.deepEqual(decodeFunctionResult({abi:artifacts.Reader.abi,functionName:'low',data:refused.trace.output}),[false,'0x']);
      assert.deepEqual(refused.after[payee], refused.before[payee]);
      const paid = await send('low-level gas/value succeeds', [lowRequest(payee, owner, 1n, 100000n)], 0n, true);
      gasWord(paid, 'CALL', 100000n);
      assert.deepEqual(decodeFunctionResult({abi:artifacts.Reader.abi,functionName:'low',data:paid.trace.output}),[true,owner]);
      for(const budget of [0n,100000n]) {
        const delegated=await send('delegatecall explicit gas '+budget,[lowRequest(payee,other,0n,budget,'lowDelegate')],0n,true);
        gasWord(delegated,'DELEGATECALL',budget);
        assert.deepEqual(decodeFunctionResult({abi:artifacts.Reader.abi,functionName:'lowDelegate',data:delegated.trace.output}),[budget>0n,budget>0n?other:'0x']);
        assert.deepEqual(delegated.after[payee],delegated.before[payee]);
      }
      await send('plain call coexists with gas helpers',[request(payee,owner,0n,'plain')],0n,true);
      await send('AA gas failure rolls back earlier value',[request(payee,owner,1n,'invokeGas'),request(alias,other,0n,'invokeGas',0n)],0n,false,true);
      await send('AA gas success',[request(payee,owner,1n,'invokeGas')],0n,true,true);
      const huge=await send('gas above uint64 is EIP150 capped',[request(payee,owner,0n,'invokeGas',1n<<64n)],0n,true);
      gasWord(huge,'CALL',1n<<64n);
      const viewed=await send('typed STATICCALL explicit gas',[request(payee,owner,0n,'lookupGas')],0n,true);
      gasWord(viewed,'STATICCALL',100000n);assert.equal(viewed.trace.output,owner);
      const viewFailed=await send('typed STATICCALL zero gas rejects',[request(payee,owner,0n,'lookupGas',0n)],0n,false);
      gasWord(viewFailed,'STATICCALL',0n);
      const before=await state(0);
      for(const budget of [0n,100000n]) {
        const data=await rpc(0,'eth_call',[lowRequest(payee,owner,0n,budget,'lowRead'),'latest']);
        assert.deepEqual(decodeFunctionResult({abi:artifacts.Reader.abi,functionName:'lowRead',data}),[budget>0n,budget>0n?owner:'0x']);
      }
      assert.deepEqual(await state(0),before);
      report.gasOptions={passed:true,rawGasOperandsVerified:true,staticcallReadonly:true};
    } else {
    first = await send('pay full32 target', [request(payee, owner, 7n)], 9n, true);
    assert.equal(first.after[payee].balance, '0x7'); assert.equal(first.after[reader].balance, '0x2');
    assert.equal(first.after[alias].balance, '0x0'); assert.equal(first.after[payee].slots[1], owner);
    assert.equal(first.trace.output, owner); assert.equal(first.trace.calls[0].to.toLowerCase(), payee);
    assert.equal(first.trace.calls[0].input, toFunctionSelector('pay(address)') + owner.slice(2));
    assert.equal(BigInt(first.trace.calls[0].value), 7n);
    await send('plain call to same payable declaration', [request(payee, other, 0n, 'plain')], 0n, true);
    const second = await send('same-low20 alias transfer', [request(alias, other, 4n)], 5n, true);
    assert.equal(second.after[payee].balance, '0x7'); assert.equal(second.after[alias].balance, '0x4');
    assert.equal(second.after[alias].slots[1], other); assert.equal(second.after[reader].balance, '0x3');
    const denied = await send('callee rejection', [request(payee, zero, 2n)], 0n, false);
    assert.equal(denied.trace.output, toFunctionSelector('Denied(address)') + word(0));
    await send('insufficient caller funds', [request(payee, owner, 4n)], 0n, false);
    await send('short return restores value and callee storage', [request(short, owner, 2n)], 5n, false);
    await send('missing callee restores value', [request(missing, owner, 1n)], 0n, false);
    await send('outer rejection restores successful callee', [request(payee, owner, 1n, 'reject')], 3n, false);
    await send('AA second call reverts first value and storage', [request(payee, owner, 1n), request(alias, zero, 1n)], 0n, false, true);
    await send('AA successful payable call', [request(payee, owner, 1n)], 0n, true, true);
    }
    const verify = async () => {
      for (const i of [0, 1]) {
        const before = await state(i), head = await rpc(i, 'eth_getBlockByNumber', ['latest', false]);
        if(signedCalls) {
          assert.equal(before[reader].balance,'0x2');assert.equal(before[payee].balance,'0x4');assert.equal(before[alias].balance,'0x3');
          assert.equal(before[reader].slots[0],'0x'+word(4));assert.equal(before[payee].slots[0],'0x'+word(2));assert.equal(before[alias].slots[0],'0x'+word(2));
          assert.deepEqual(before[payee].oracle,oracleWords(-7n,-1n,2n,BigInt(report.lastOracleTime)));assert.deepEqual(before[alias].oracle,oracleWords(42n,0n,3n,BigInt(report.lastOracleTime)));
        } else if(narrowCalls) {
          assert.equal(before[reader].balance,'0x2');assert.equal(before[payee].balance,'0x4');assert.equal(before[alias].balance,'0x3');
          assert.equal(before[reader].slots[0],'0x'+word(5));assert.equal(before[payee].slots[0],'0x'+word(3));assert.equal(before[alias].slots[0],'0x'+word(2));
          assert.equal(before[payee].reservesWord,reservesWord(max112,0n,max32));assert.equal(before[alias].reservesWord,reservesWord(21n,22n,23n));
        } else if(tupleCalls) {
          assert.equal(before[reader].balance,'0x2');assert.equal(before[payee].balance,'0x4');assert.equal(before[alias].balance,'0x3');
          assert.equal(before[reader].slots[0],'0x'+word(4));assert.equal(before[reader].slots[1],owner);
          assert.equal(before[payee].slots[0],'0x'+word(2));assert.equal(before[payee].slots[1],other);
          assert.equal(before[alias].slots[0],'0x'+word(2));assert.equal(before[alias].slots[1],owner);
        } else if(voidCalls) {
          assert.equal(before[reader].balance,'0x4');assert.equal(before[payee].balance,'0x5');assert.equal(before[plain].balance,'0x9');
          assert.equal(before[reader].slots[0],'0x'+word(8));assert.equal(before[payee].slots[0],'0x'+word(4));assert.equal(before[alias].slots[0],'0x'+word(2));
          assert.deepEqual(before[payee].owners,{'7':owner,[maxId.toString()]:other,'99':other,'100':zero});
          assert.deepEqual(before[alias].owners,{'7':other,[maxId.toString()]:owner,'99':zero,'100':zero});
          assert.equal(before[badBool].slots[0],'0x'+word(99));assert.equal(before[large].slots[0],'0x'+word(99));
        } else if(staticCalls) {
          const expected=[[payee,100n,80n,13n,2n,5n,5n],[alias,200n,193n,0n,7n,0n,1n]];
          for(const[token,total,held,firstOwner,secondOwner,payerAmount,count]of expected) {
            assert.equal(before[token].tokens[reader],'0x'+word(held));assert.equal(before[token].tokens[owner],'0x'+word(firstOwner));
            assert.equal(before[token].tokens[other],'0x'+word(secondOwner));assert.equal(before[token].tokens[payer.getAddress()],'0x'+word(payerAmount));
            assert.equal(before[token].tokens[callerAlias],'0x'+word(0));assert.equal(before[token].tokens[zero],'0x'+word(0));
            assert.equal(Object.values(before[token].tokens).reduce((sum,value)=>sum+BigInt(value),0n),total);
            assert.equal(before[token].slots[0],'0x'+word(count));
          }
          assert.equal(before[reader].slots[0],'0x'+word(7));
          for(const[from,to,amount]of [[owner,other,83n],[other,owner,17n]]) {
            const data=await rpc(i,'eth_call',[assetRequest('assetAllowance',[payee,from,to]),'latest']);assert.equal(data,'0x'+word(amount));
          }
        } else {
        assert.equal(before[payee].balance, contextOptions ? '0x8' : gasOptions ? '0x9' : '0x8'); assert.equal(before[alias].balance, contextOptions ? '0x0' : '0x4');
        assert.equal(before[reader].balance, contextOptions || gasOptions ? '0x1' : '0x2'); assert.equal(before[reader].slots[0], '0x' + word(contextOptions || gasOptions ? 8 : 4));
        assert.equal(before[payee].slots[0], '0x' + word(contextOptions ? 8 : gasOptions ? 5 : 3)); assert.equal(before[alias].slots[0], '0x' + word(contextOptions ? 0 : 1));
        }
        for (const entry of report.transactions) assert.deepEqual(await rpc(i, 'eth_getTransactionReceipt', [entry.hash]), entry.receipt);
        assert.deepEqual(await state(i, first.receipt.blockNumber), first.after);
        if(signedCalls) {
          const query=assetRequest('latestPrice',[payee]);
          assert.equal(await rpc(i,'eth_call',[query,first.receipt.blockNumber]),oracleOutput(1n,minInt256,BigInt(report.firstOracleTime)));
          assert.equal(await rpc(i,'eth_call',[query,'latest']),oracleOutput(2n,-7n,BigInt(report.lastOracleTime)));
        } else if(narrowCalls) {
          const query=assetRequest('readReserves',[payee]);
          assert.equal(await rpc(i,'eth_call',[query,first.receipt.blockNumber]),reservesOutput(max112,1n,max32));
          assert.equal(await rpc(i,'eth_call',[query,'latest']),reservesOutput(max112,0n,max32));
        } else if(tupleCalls) {
          const query=assetRequest('tupleRead',[payee,owner]);
          assert.equal(await rpc(i,'eth_call',[query,first.receipt.blockNumber]),tupleOutput(owner,1n,true));
          assert.equal(await rpc(i,'eth_call',[query,'latest']),tupleOutput(other,2n,false));
        } else if(voidCalls) {
          assert.equal(await rpc(i,'eth_call',[assetRequest('nftOwner',[payee,maxId]),first.receipt.blockNumber]),reader);
          assert.equal(await rpc(i,'eth_call',[assetRequest('nftOwner',[payee,maxId]),'latest']),other);
        } else if(staticCalls) {
          assert.equal(await rpc(i,'eth_call',[assetRequest('assetBalance',[payee,owner]),first.receipt.blockNumber]),'0x'+word(10));
          assert.equal(await rpc(i,'eth_call',[assetRequest('assetBalance',[payee,owner]),'latest']),'0x'+word(13));
        } else if(contextOptions) {
          assert.equal(await rpc(i,'eth_call',[contextRequest('contextual'),first.receipt.blockNumber]),owner);
          assert.equal(await rpc(i,'eth_call',[contextRequest('contextOptions'),first.receipt.blockNumber]),owner);
          assert.equal(await rpc(i,'eth_call',[contextRequest('contextual'),'latest']),other);
          assert.deepEqual(before[reader].entryWords[payer.getAddress()],['0x'+word(payee),other,'0x'+word(2),'0x'+word(90000)]);
        } else assert.equal(await rpc(i, 'eth_call', [request(payee, other, 1n), first.receipt.blockNumber]), other);
        assert.deepEqual(await rpc(i, 'debug_traceTransaction', [first.hash, { tracer: 'callTracer' }]), first.trace);
        assert.deepEqual(await state(i), before);
        assert.equal((await rpc(i, 'eth_getBlockByNumber', ['latest', false])).stateRoot, head.stateRoot);
        const final = await rpc(i, 'shell_getFinalityInfo'); assert.equal(BigInt(final.lastFinalizedBlock), BigInt(head.number));
      }
    };
    await verify(); await stop(1); await stop(0);
    await start(1, await peer(await start(0))); await verify(); report.passed = true;
  } catch (error) { report.error = String(error); throw error; }
  finally {
    try { await stop(1); await stop(0); }
    finally { miner.dispose(); payer.dispose(); await save(); console.log(`Payable acceptance report: ${join(directory, reportName)}`); }
  }
 }

test('typed payable calls: signed value, rollback, import, history and disk reopen',
  {skip:!process.env.SHELL_NODE_BIN,timeout:360000},()=>runPayableAcceptance());
test('native gas options: exact operands, limits, rollback, import, history and disk reopen',
  {skip:!process.env.SHELL_NODE_BIN,timeout:360000},()=>runPayableAcceptance(true));
test('nested native context: full32 mapping entries, AA rollback, history and disk reopen',
  {skip:!process.env.SHELL_NODE_BIN,timeout:600000},()=>runPayableAcceptance(false,true));
test('native static interface calls: token balances, bool, views, rollback, history and disk reopen',
  {skip:!process.env.SHELL_NODE_BIN,timeout:600000},()=>runPayableAcceptance(false,false,true));
test('native void interface calls: code guards, NFT state, no copy, rollback, history and disk reopen',
  {skip:!process.env.SHELL_NODE_BIN,timeout:600000},()=>runPayableAcceptance(false,false,false,true));

test('native return tuples: full32 field order, decode rejection, rollback, history and disk reopen',
  {skip:!process.env.SHELL_NODE_BIN,timeout:600000},()=>runPayableAcceptance(false,false,false,false,true));

test('native narrow unsigned calls: reserves, bounds, rollback, history and disk reopen',
  {skip:!process.env.SHELL_NODE_BIN,timeout:600000},()=>runPayableAcceptance(false,false,false,false,false,true));

test('native signed calls: feed state, sign extension, rollback, history and disk reopen',
  {skip:!process.env.SHELL_NODE_BIN,timeout:600000},()=>runPayableAcceptance(false,false,false,false,false,false,true));
