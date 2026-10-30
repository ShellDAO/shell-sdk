// ERC-1155 batch call shapes: https://eips.ethereum.org/EIPS/eip-1155
// This fixture exercises batch balances, transfers and hooks, not the full token standard.
pragma solidity ^0.8.30;

interface IMulti {
    function balanceOfBatch(address[] calldata owners, uint256[] calldata ids) external view returns (uint256[] memory);
    function safeBatchTransferFrom(address from, address to, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data) external;
}
interface IBatchReceiver {
    function onERC1155BatchReceived(address operator, address from, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data) external returns (bytes4);
}
contract Payee {
    uint256 public count;
    address public seen;
    mapping(uint256 => mapping(address => uint256)) balances;
    mapping(address => mapping(address => bool)) approvals;
    event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    function setApprovalForAll(address operator, bool approved) external {
        approvals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }
    function isApprovedForAll(address owner, address operator) external view returns (bool) {return approvals[owner][operator];}
    function balanceOfBatch(address[] calldata owners, uint256[] calldata ids) external view returns (uint256[] memory) {
        require(owners.length == ids.length);
        uint256[] memory result = new uint256[](owners.length);
        for (uint256 i; i < owners.length; i++) {require(owners[i] != address(0)); result[i] = balances[ids[i]][owners[i]];}
        return result;
    }
    function safeBatchTransferFrom(address from, address to, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data) external {
        require(from == msg.sender || approvals[from][msg.sender]);
        require(to != address(0) && ids.length == amounts.length);
        for (uint256 i; i < ids.length; i++) {
            require(balances[ids[i]][from] >= amounts[i]);
            balances[ids[i]][from] -= amounts[i]; balances[ids[i]][to] += amounts[i];
        }
        count++; seen = from;
        emit TransferBatch(msg.sender, from, to, ids, amounts);
        if (to.code.length > 0) require(IBatchReceiver(to).onERC1155BatchReceived(msg.sender, from, ids, amounts, data) == IBatchReceiver.onERC1155BatchReceived.selector);
    }
}
contract Reader {
    uint256 public count;
    address public last;
    uint256 public readSum;
    function batchBalances(address target, address[] memory owners, uint256[] memory ids) external returns (uint256[] memory) {
        count++;
        uint256[] memory result = IMulti(target).balanceOfBatch(owners, ids);
        uint256 sum; for (uint256 i; i < result.length; i++) sum += result[i];
        readSum = sum; return result;
    }
    function readBatch(address target, address[] memory owners, uint256[] memory ids) external view returns (uint256[] memory) {return IMulti(target).balanceOfBatch(owners, ids);}
    function batchSend(address target, address recipient, uint256[] memory ids, uint256[] memory amounts, bytes memory data, uint256 budget) external {
        count++; last = recipient;
        IMulti(target).safeBatchTransferFrom{gas:budget}(address(this), recipient, ids, amounts, data);
    }
    function batchFrom(address target, address from, address recipient, uint256[] memory ids, uint256[] memory amounts, bytes memory data) external {
        count++; last = recipient;
        IMulti(target).safeBatchTransferFrom(from, recipient, ids, amounts, data);
    }
}
contract BatchReceiver {
    address public operator;
    address public from;
    address public token;
    uint256 public length;
    uint256 public total;
    bytes32 public dataHash;
    uint256 public calls;
    function onERC1155BatchReceived(address caller, address sender, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data) external returns (bytes4) {
        require(ids.length == amounts.length);
        operator = caller; from = sender; token = msg.sender; length = ids.length; calls++;
        uint256 sum; for (uint256 i; i < amounts.length; i++) sum += amounts[i]; total = sum;
        dataHash = keccak256(data);
        return IBatchReceiver.onERC1155BatchReceived.selector;
    }
}
