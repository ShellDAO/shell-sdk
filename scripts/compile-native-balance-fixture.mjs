import {compileSolidity} from '../dist/contracts-compiler.js';
import {writeFileSync} from 'node:fs';
import {toFunctionSelector} from 'viem';
import solc from 'solc';

if (!process.argv[2]) throw new Error('usage: node scripts/compile-native-balance-fixture.mjs <output.json>');
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
contract Token {
    mapping(address => uint256) private balances;
    error Missing(address owner);
    function balanceOf(address owner) external view returns(uint256) {
        if(owner == address(0)) revert Missing(owner);
        return balances[owner];
    }
}`;
const artifacts={};
for (const contractName of ['Reader','PureReader','Token']) {
    artifacts[contractName]=await compileSolidity({sources:[{path:'Balance.sol',content:source}],contractName,target:'pqvm',evmVersion:'shanghai',nativeAddressContextHeight:2});
}
// Deliberately violate the interface's view promise to check STATICCALL rollback.
artifacts.Writer=await compileSolidity({sources:[{path:'Writer.sol',content:'pragma solidity ^0.8.20; contract Writer {function balanceOf(address owner) external returns(uint256){assembly {sstore(0,owner)}return 99;}}'}],contractName:'Writer',target:'evm',evmVersion:'shanghai'});
writeFileSync(process.argv[2],JSON.stringify({source,compiler:solc.version(),activationHeight:2,selectors:Object.fromEntries(['lookup(address,address)','record(address,address)','balanceOf(address)','Missing(address)'].map(signature=>[signature,toFunctionSelector(signature)])),artifacts},null,2)+'\n');
