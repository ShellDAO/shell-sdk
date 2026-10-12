import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const CLI = path.resolve('dist', 'cli.js');

test('cli prints contract help', () => {
  const result = spawnSync(process.execPath, [CLI, 'contract', 'help'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /contract compile/);
  assert.match(result.stdout, /contract deploy/);
});

test('cli contract compile writes artifact', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'shell-sdk-cli-'));
  try {
    const out = path.join(tempDir, 'PqvmCounter.json');
    const result = spawnSync(process.execPath, [
      CLI,
      'contract',
      'compile',
      '--source',
      'contracts/PqvmCounter.sol',
      '--contract',
      'PqvmCounter',
      '--out',
      out,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"contractName":"PqvmCounter"/);
    const artifact = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(out, 'utf8')));
    assert.equal(artifact.contractName, 'PqvmCounter');
    assert.match(artifact.bytecode, /^0x[0-9a-f]+$/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test('cli native context compile enforces explicit activation arguments', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'shell-sdk-cli-native-'));
  try {
    const source = path.join(tempDir, 'Context.sol');
    await writeFile(source, 'pragma solidity ^0.8.20; contract Context { function caller() external view returns(address) {return msg.sender;} }');
    const out = path.join(tempDir, 'Context.json');
    const base = [CLI, 'contract', 'compile', '--source', source, '--contract', 'Context', '--out', out];
    for (const args of [[], ['--pqvm'], ['--pqvm','--native-address-context-height'], ['--pqvm','--native-address-context-height','1.5'], ['--native-address-context-height','2']]) {
      // Ordinary EVM compilation remains valid; PQVM requires the profile.
      const result = spawnSync(process.execPath, [...base,...args], {encoding:'utf8'});
      assert.equal(result.status, args.length === 0 ? 0 : 1, result.stderr);
    }
    const result = spawnSync(process.execPath, [...base,'--pqvm','--native-address-context-height','2'], {encoding:'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(out,'utf8')).contractName, 'Context');
  } finally { await rm(tempDir, {recursive:true,force:true}); }
});


test('cli preserves nested bigint array and tuple words and refuses unsafe JSON integers', async () => {
  const {createServer}=await import('node:http');
  const {spawn}=await import('node:child_process');
  const {once}=await import('node:events');
  const {toFunctionSelector}=await import('viem');
  const requests=[];
  const server=createServer(async(request,response)=>{
    let raw='';for await(const chunk of request)raw+=chunk;
    const body=JSON.parse(raw);requests.push(body);
    response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result:'0x'+'00'.repeat(32)}));
  });
  const directory=await mkdtemp(path.join(os.tmpdir(),'shell-sdk-cli-args-'));
  const artifact=path.join(directory,'Arguments.json');
  const abi=[
    {type:'function',name:'array',stateMutability:'pure',inputs:[{name:'values',type:'uint256[]'}],outputs:[{type:'uint256'}]},
    {type:'function',name:'tuple',stateMutability:'pure',inputs:[{name:'value',type:'tuple',components:[{name:'signed',type:'int256'},{name:'values',type:'uint256[]'}]}],outputs:[{type:'uint256'}]},
  ];
  const word=value=>BigInt.asUintN(256,BigInt(value)).toString(16).padStart(64,'0');
  try {
    await writeFile(artifact,JSON.stringify({contractName:'Arguments',abi,bytecode:'0x00'}));
    server.listen(0,'127.0.0.1');await once(server,'listening');
    async function run(fun,args) {
      const child=spawn(process.execPath,[CLI,'contract','read','--artifact',artifact,'--address','0x'+'99'.repeat(32),
        '--function',fun,'--args',args,'--rpc',`http://127.0.0.1:${server.address().port}`],{stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
      const [status]=await once(child,'exit');return {status,stdout,stderr};
    }
    const value=(1n<<200n)+73n;
    const array=await run('array(uint256[])',JSON.stringify([[value.toString()+'n','7n']]));
    assert.equal(array.status,0,array.stderr);assert.equal(array.stdout.trim(),'"0"');
    assert.equal(requests.at(-1).params[0].data,toFunctionSelector('array(uint256[])')+word(32)+word(2)+word(value)+word(7));
    for(const tupleArgs of [[['-7n',[value.toString()+'n','7n']]], [{signed:'-7n',values:[value.toString()+'n','7n']}]] ) {
      const tuple=await run('tuple((int256,uint256[]))',JSON.stringify(tupleArgs));
      assert.equal(tuple.status,0,tuple.stderr);
      assert.equal(requests.at(-1).params[0].data,toFunctionSelector('tuple((int256,uint256[]))')+word(32)+word(-7)+word(64)+word(2)+word(value)+word(7));
    }
    const count=requests.length;
    const unsafe=await run('array(uint256[])','[[9007199254740993]]');
    assert.equal(unsafe.status,1);assert.match(unsafe.stderr,/unsafe integer.*n-suffixed/);assert.equal(requests.length,count);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    await rm(directory,{recursive:true,force:true});
  }
});
