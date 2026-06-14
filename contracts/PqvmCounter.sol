// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract PqvmCounter {
    uint256 private number;

    event NumberSet(uint256 value);
    event Incremented(uint256 value);

    function setNumber(uint256 newNumber) external {
        number = newNumber;
        emit NumberSet(newNumber);
    }

    function increment() external {
        number += 1;
        emit Incremented(number);
    }

    function getNumber() external view returns (uint256) {
        return number;
    }
}
