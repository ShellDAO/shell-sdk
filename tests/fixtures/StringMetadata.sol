// Original metadata interface: https://eips.ethereum.org/EIPS/eip-1155#metadata
// The writer and Reader are isolated acceptance helpers, not a complete token.
pragma solidity ^0.8.30;

interface ERC1155Metadata_URI {
    function uri(uint256 id) external view returns (string memory);
}
interface IMetadataWriter {
    function setURI(address owner, uint256 id, string calldata value) external;
    function echo(string calldata value) external pure returns (string memory);
}
contract Payee {
    uint256 public count;
    address public seen;
    mapping(uint256 => string) values;
    event URI(string value, uint256 indexed id);
    function uri(uint256 id) external view returns (string memory) {return values[id];}
    function setURI(address owner, uint256 id, string calldata value) external {
        require(owner == msg.sender);
        count++; seen = msg.sender; values[id] = value;
        emit URI(value, id);
        require(id != 99);
    }
    function echo(string calldata value) external pure returns (string memory) {return value;}
}
contract Reader {
    uint256 public count;
    address public last;
    bytes32 public digest;
    uint256 public length;
    function read(address target, uint256 id) external view returns (string memory) {return ERC1155Metadata_URI(target).uri(id);}
    function record(address target, uint256 id) external returns (string memory) {
        count++; last = target;
        string memory result = ERC1155Metadata_URI(target).uri(id);
        digest = keccak256(bytes(result)); length = bytes(result).length;
        return result;
    }
    function update(address target, uint256 id, string memory value, uint256 budget) external returns (string memory) {
        count++; last = target;
        IMetadataWriter(target).setURI{gas:budget}(address(this), id, value);
        string memory result = ERC1155Metadata_URI(target).uri(id);
        digest = keccak256(bytes(result)); length = bytes(result).length;
        return result;
    }
    function updateFrom(address target, address owner, uint256 id, string memory value) external {
        count++; last = target;
        IMetadataWriter(target).setURI(owner, id, value);
    }
    function echo(address target, string memory value) external returns (string memory) {
        count++; last = target;
        string memory result = IMetadataWriter(target).echo(value);
        digest = keccak256(bytes(result)); length = bytes(result).length;
        return result;
    }
}
