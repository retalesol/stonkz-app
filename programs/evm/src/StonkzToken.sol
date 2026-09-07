// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title A launched Stonkz memecoin.
/// @notice Fixed supply, minted once in the constructor to the launchpad. There
/// is no mint function and no owner, which is the EVM equivalent of the Solana
/// side setting mint and freeze authority to `None` at creation. `burn` exists
/// only so the launchpad can destroy the unsold allocation on an early
/// oracle-triggered graduation, and it can only burn its own balance.
contract StonkzToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice The launchpad. Immutable, and holds no privilege beyond `burn`.
    address public immutable launchpad;
    string public uri;

    /* ------------------------------------------------------------- EIP-2612 */

    /// @dev Present so the sell path can stay a single signature once the
    /// `StonkzRouter` periphery lands. Selling starts from this token, so a
    /// router has to be able to pull it; without `permit` that is an `approve`
    /// transaction followed by a swap transaction, which is two signatures and
    /// leaves the user stranded mid-flow if they only sign the first. See
    /// `docs/robinhood-chain.md` §3.3.
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    mapping(address => uint256) public nonces;

    uint256 private immutable _cachedChainId;
    bytes32 private immutable _cachedDomainSeparator;
    bytes32 private immutable _hashedName;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, string memory _uri, uint256 _supply) {
        name = _name;
        symbol = _symbol;
        uri = _uri;
        launchpad = msg.sender;
        totalSupply = _supply;
        balanceOf[msg.sender] = _supply;
        emit Transfer(address(0), msg.sender, _supply);

        _hashedName = keccak256(bytes(_name));
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    /// @dev Rebuilt if the chain id has moved, so a signature cannot be replayed
    /// from a fork onto the canonical chain.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                _hashedName,
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(block.timestamp <= deadline, "permit expired");
        require(owner != address(0), "owner zero");
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0) && signer == owner, "bad signature");
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    /// @notice Destroy tokens the launchpad itself holds. Nothing else can be burned.
    function burn(uint256 value) external {
        require(msg.sender == launchpad, "only launchpad");
        require(balanceOf[msg.sender] >= value, "balance");
        unchecked {
            balanceOf[msg.sender] -= value;
            totalSupply -= value;
        }
        emit Transfer(msg.sender, address(0), value);
    }

    function _transfer(address from, address to, uint256 value) private {
        require(to != address(0), "to zero");
        require(balanceOf[from] >= value, "balance");
        unchecked {
            balanceOf[from] -= value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
