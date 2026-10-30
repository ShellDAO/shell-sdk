// ABI example: https://docs.soliditylang.org/en/latest/abi-spec.html#use-of-dynamic-types
pragma solidity ^0.8.30;
interface INested {
    function g(uint256[][] calldata groups, string[] calldata texts) external returns (uint256[][] memory, string[] memory);
    function read() external view returns (uint256[][] memory, string[] memory);
    function matrix(address[][] calldata owners, uint256[][] calldata amounts, bytes[] calldata notes) external returns (address[][] memory, bytes[] memory);
}
contract Payee {
    uint256 public count;
    address public seen;
    bytes32 public digest;
    uint256 public total;
    bytes32 public addressDigest;
    uint256 public rows;
    uint256[][] values;
    string[] labels;
    mapping(address => uint256) public weights;
    event Grouped(address indexed caller, uint256[][] groups, string[] texts);
    event Matrix(address indexed caller, address[][] owners, bytes[] notes);
    function g(uint256[][] calldata groups, string[] calldata texts) external returns (uint256[][] memory, string[] memory) {
        count++; seen = msg.sender; rows = groups.length;
        delete values; delete labels;
        uint256 sum;
        for (uint256 i; i < groups.length; i++) {
            values.push();
            for (uint256 j; j < groups[i].length; j++) {values[i].push(groups[i][j]); sum += groups[i][j];}
        }
        for (uint256 i; i < texts.length; i++) labels.push(texts[i]);
        total = sum; digest = keccak256(abi.encode(groups, texts));
        emit Grouped(msg.sender, groups, texts);
        require(sum != 99);
        return (values, labels);
    }
    function read() external view returns (uint256[][] memory, string[] memory) {return (values, labels);}
    function matrix(address[][] calldata owners, uint256[][] calldata amounts, bytes[] calldata notes) external returns (address[][] memory, bytes[] memory) {
        require(owners.length == amounts.length);
        for (uint256 i; i < owners.length; i++) {
            require(owners[i].length == amounts[i].length);
            for (uint256 j; j < owners[i].length; j++) weights[owners[i][j]] += amounts[i][j];
        }
        addressDigest = keccak256(abi.encode(owners, notes)); rows = owners.length;
        emit Matrix(msg.sender, owners, notes);
        return (owners, notes);
    }
}
contract Reader {
    uint256 public count;
    address public last;
    bytes32 public digest;
    uint256 public total;
    bytes32 public addressDigest;
    uint256 public rows;
    function run(address target, uint256[][] memory groups, string[] memory texts, uint256 budget) external returns (uint256[][] memory, string[] memory) {
        count++; last = target;
        (uint256[][] memory output, string[] memory names) = INested(target).g{gas:budget}(groups, texts);
        uint256 sum; for (uint256 i; i < output.length; i++) for (uint256 j; j < output[i].length; j++) sum += output[i][j];
        digest = keccak256(abi.encode(output, names)); total = sum; rows = output.length;
        return (output, names);
    }
    function read(address target) external view returns (uint256[][] memory, string[] memory) {return INested(target).read();}
    function matrix(address target, address[][] memory owners, uint256[][] memory amounts, bytes[] memory notes) external returns (address[][] memory, bytes[] memory) {
        count++; last = target;
        (address[][] memory output, bytes[] memory data) = INested(target).matrix(owners, amounts, notes);
        addressDigest = keccak256(abi.encode(output, data)); rows = output.length;
        return (output, data);
    }
}
