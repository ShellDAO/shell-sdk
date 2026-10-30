// ABI address payable mapping: https://docs.soliditylang.org/en/latest/abi-spec.html#mapping-solidity-to-abi-types
pragma solidity ^0.8.30;
interface IPay {
    function pay(address payable owner) external payable returns (address payable);
}
contract Payee {
    error Denied(address payable owner);
    event Paid(address indexed owner, uint256 value);
    uint256 public count;
    address payable public seen;
    function pay(address payable owner) external payable returns (address payable) {
        count++; seen = owner;
        if (owner == address(0)) revert Denied(owner);
        emit Paid(owner, msg.value);
        return owner;
    }
}
contract Reader {
    uint256 public count;
    address payable public last;
    function invoke(address target, address payable owner, uint256 amount) external payable returns (address payable) {
        count++; last = IPay(target).pay{value:amount}(owner);
        return last;
    }
    function plain(address payable target, address payable owner) external returns (address payable) {
        count++; last = IPay(target).pay(owner);
        return last;
    }
    function reject(address target, address owner, uint256 amount) external payable {
        count++; last = IPay(target).pay{value:amount}(payable(owner));
        require(false);
    }
}
