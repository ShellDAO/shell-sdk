import {compileSolidity} from '../dist/contracts-compiler.js';
import {writeFileSync} from 'node:fs';
import {toFunctionSelector} from 'viem';
import solc from 'solc';

if (!process.argv[2]) throw new Error('usage: node scripts/compile-native-balance-fixture.mjs <output.json> [struct]');
if (process.argv[3] && process.argv[3] !== 'struct') throw new Error('fixture option must be struct');
if (process.argv[3] === 'struct') {
    const original='pragma solidity ^0.8.35; interface I {function balanceOf(address beneficiary) external view returns(uint256);} contract Ledger {struct Entry {address token; address beneficiary;} mapping(uint256=>Entry) private entries; function set(uint256 id,address token,address beneficiary) external {entries[id]=Entry(token,beneficiary);} function lookup(uint256 id) external view returns(uint256) {return I(entries[id].token).balanceOf(entries[id].beneficiary);} }';
    const selecting=original.replace('contract Ledger','contract SelectingLedger').replace('function lookup(uint256 id) external view', 'uint256 public selections; function select(uint256 id) internal returns(uint256) {selections++; return id;} function lookup(uint256 id) external').replace('.balanceOf(entries[id].beneficiary)', '.balanceOf(entries[select(id)].beneficiary)');
    const token='pragma solidity ^0.8.35; contract Token {mapping(address=>uint256) private balances; error Missing(address beneficiary); function balanceOf(address beneficiary) external view returns(uint256) {if(beneficiary==address(0)) revert Missing(beneficiary);return balances[beneficiary];}}';
    // The fallback accepts all 32 argument bytes, so rejection tests STATICCALL,
    // rather than the retained EVM address decoder rejecting a wide argument.
    const writer='pragma solidity ^0.8.35; contract Writer {fallback() external {assembly {sstore(0,calldataload(4)) mstore(0,99) return(0,32)}}}';
    const sources={Ledger:original,SelectingLedger:selecting,Token:token,Writer:writer};
    const artifacts={};
    for (const [contractName,content] of Object.entries(sources)) {
        artifacts[contractName]=await compileSolidity({sources:[{path:`${contractName}.sol`,content}],contractName,target:contractName==='Writer'?'evm':'pqvm',evmVersion:'shanghai',...(contractName==='Writer'?{}:{nativeAddressContextHeight:2})});
    }
    const signatures=['set(uint256,address,address)','lookup(uint256)','balanceOf(address)','Missing(address)'];
    writeFileSync(process.argv[2],JSON.stringify({sources,compiler:solc.version(),activationHeight:2,selectors:Object.fromEntries(signatures.map(signature=>[signature,toFunctionSelector(signature)])),artifacts},null,2)+'\n');
    process.exit(0);
}
const source=`pragma solidity ^0.8.20;
interface IBalance { function balanceOf(address owner) external view returns(uint256); }
interface IPureBalance { function balanceOf(address owner) external pure returns(uint256); }
contract Reader {
    uint256 public selections;
    function lookup(address token,address owner) external view returns(uint256) {
        return IBalance(token).balanceOf(owner);
    }
    function record(address token,address owner) external returns(uint256) {
        selections++;
        return IBalance(token).balanceOf(owner);
    }
}
contract PureReader {
    uint256 public selections;
    function lookup(address token,address owner) external pure returns(uint256) {
        return IPureBalance(token).balanceOf(owner);
    }
    function record(address token,address owner) external returns(uint256) {
        selections++;
        return IPureBalance(token).balanceOf(owner);
    }
}
interface IPureAddress { function balanceOf(address owner) external pure returns(address); }
contract PureAddressReader {
    uint256 public selections;
    function lookup(address token,address owner) external pure returns(address) {
        return IPureAddress(token).balanceOf(owner);
    }
    function record(address token,address owner) external returns(address) {
        selections++;
        return IPureAddress(token).balanceOf(owner);
    }
}
interface IPureBytes { function balanceOf(address owner) external pure returns(bytes32); }
contract PureBytesReader {
    uint256 public selections;
    function lookup(address token,address owner) external pure returns(bytes32) {
        return IPureBytes(token).balanceOf(owner);
    }
    function record(address token,address owner) external returns(bytes32) {
        selections++;
        return IPureBytes(token).balanceOf(owner);
    }
}
contract Token {
    mapping(address => uint256) private balances;
    error Missing(address owner);
    function balanceOf(address owner) external view returns(uint256) {
        if(owner == address(0)) revert Missing(owner);
        return balances[owner];
    }
}`;
const artifacts={};
for (const contractName of ['Reader','PureReader','PureAddressReader','PureBytesReader','Token']) {
    artifacts[contractName]=await compileSolidity({sources:[{path:'Balance.sol',content:source}],contractName,target:'pqvm',evmVersion:'shanghai',nativeAddressContextHeight:2});
}
// Deliberately violate the interface's view promise to check STATICCALL rollback.
artifacts.Writer=await compileSolidity({sources:[{path:'Writer.sol',content:'pragma solidity ^0.8.20; contract Writer {function balanceOf(address owner) external returns(uint256){assembly {sstore(0,owner)}return 99;}}'}],contractName:'Writer',target:'evm',evmVersion:'shanghai'});
writeFileSync(process.argv[2],JSON.stringify({source,compiler:solc.version(),activationHeight:2,selectors:Object.fromEntries(['lookup(address,address)','record(address,address)','balanceOf(address)','Missing(address)'].map(signature=>[signature,toFunctionSelector(signature)])),artifacts},null,2)+'\n');
