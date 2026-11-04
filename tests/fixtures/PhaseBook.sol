pragma solidity ^0.8.24;
contract PhaseBook {
    enum Phase { Unset, Approved, Rejected }
    mapping(address => Phase) public phases;
    function set(address owner, Phase phase) external { phases[owner] = phase; }
    function approve(address owner) external { phases[owner] = Phase.Approved; }
}
