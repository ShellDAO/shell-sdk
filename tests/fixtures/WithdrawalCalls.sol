// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.4;
import "./WithdrawalContract.sol";

// Original withdrawal example: https://docs.soliditylang.org/en/latest/common-patterns.html#withdrawal-from-contracts
contract Payee is WithdrawalContract {}
interface IWithdrawal {
    function becomeRichest() external payable;
    function withdraw() external;
}
interface IActor {
    function bid(address target, uint amount) external payable;
    function claim(address target) external;
}
contract Reader {
    uint public count;
    address public last;
    uint public received;
    uint public lastValue;
    uint public entered;
    uint public rejectValue;
    uint public callbacks;
    address public lastSender;
    uint public lastSuccess;
    event Received(address indexed sender, uint amount);
    event Sent(address indexed recipient, uint amount, bool success);
    function bid(address target, uint amount) external payable {
        count++; last = target;
        IWithdrawal(target).becomeRichest{value: amount}();
    }
    function bidVia(address target, address actor, uint amount) external payable {
        count++; last = target;
        IActor(actor).bid{value: amount}(target, amount);
    }
    function claim(address target) external {
        count++; last = target;
        IWithdrawal(target).withdraw();
    }
    function claimVia(address target, address actor) external {
        count++; last = target;
        IActor(actor).claim(target);
    }
    function pay(address payable recipient, uint amount) external returns (bool) {
        count++; last = recipient;
        (bool success, ) = recipient.call{value: amount}("");
        lastSuccess = success ? 1 : 0;
        emit Sent(recipient, amount, success);
        return success;
    }
    receive() external payable {
        require(rejectValue == 0);
        callbacks++; received += msg.value; lastSender = msg.sender;
        emit Received(msg.sender, msg.value);
        if (msg.value > 0) {
            lastValue = msg.value;
            if (entered == 0) {
                entered = 1;
                address target = msg.sender;
                IWithdrawal(target).withdraw();
            }
        }
    }
}
