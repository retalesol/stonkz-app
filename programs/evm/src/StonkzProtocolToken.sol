// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title `$STONKZ` protocol token.
/// @notice Distinct from `StonkzToken`, which is the immutable memecoin each
/// launchpad create deploys. This is the named protocol coin: 1B initial
/// supply, 18 decimals, EIP-2612 permits, plus mint / admin-burn / per-account
/// freeze that can each be sealed forever and then have their roles revoked.
///
/// Not upgradeable. Sealing a capability is a one-way storage flag; revoking
/// the matching role afterwards is how the admin key is taken out of the loop.
/// The last step is a two-step default-admin renounce (see
/// `AccessControlDefaultAdminRules`): `beginDefaultAdminTransfer(address(0))`,
/// wait one block (delay is 0), then `renounceRole(DEFAULT_ADMIN_ROLE, admin)`.
contract StonkzProtocolToken is ERC20, ERC20Burnable, ERC20Permit, AccessControlDefaultAdminRules {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant FREEZER_ROLE = keccak256("FREEZER_ROLE");

    uint256 public constant INITIAL_SUPPLY = 1_000_000_000 ether;

    /// @dev ERC-7572 metadata. Image is the orange Mememan Stonkz head
    /// (`programs/evm/token-metadata/stonkz-logo.png` → IPFS).
    string public constant INITIAL_CONTRACT_URI =
        "ipfs://bafkreibsg7gnnregbb5lugs5rlg3dyoeszsed6oj4gk3padfvg5mdgdgjm";

    mapping(address account => bool) public frozen;

    bool public mintingSealed;
    bool public freezingSealed;
    bool public adminBurnSealed;
    bool public contractURISealed;

    string public contractURI;

    error ZeroAddress();
    error MintingSealed();
    error FreezingSealed();
    error AdminBurnSealed();
    error ContractURISealed();
    error AccountFrozen(address account);

    event Frozen(address indexed account, bool isFrozen);
    event MintingPermanentlyDisabled();
    event FreezingPermanentlyDisabled();
    event AdminBurnPermanentlyDisabled();
    event ContractURIUpdated(string uri);
    event ContractURIPermanentlyDisabled();

    constructor(address admin, address initialRecipient)
        ERC20("Stonkz", "STONKZ")
        ERC20Permit("Stonkz")
        AccessControlDefaultAdminRules(0, admin)
    {
        if (initialRecipient == address(0)) revert ZeroAddress();

        _grantRole(MINTER_ROLE, admin);
        _grantRole(BURNER_ROLE, admin);
        _grantRole(FREEZER_ROLE, admin);

        _mint(initialRecipient, INITIAL_SUPPLY);
        contractURI = INITIAL_CONTRACT_URI;
        emit ContractURIUpdated(INITIAL_CONTRACT_URI);
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (mintingSealed) revert MintingSealed();
        _mint(to, amount);
    }

    /// @notice Destroy `amount` from `from` without an allowance. Freeze does
    /// not block this — freeze + admin-burn is the seize path until sealed.
    function adminBurn(address from, uint256 amount) external onlyRole(BURNER_ROLE) {
        if (adminBurnSealed) revert AdminBurnSealed();
        _burn(from, amount);
    }

    function freeze(address account) external onlyRole(FREEZER_ROLE) {
        if (freezingSealed) revert FreezingSealed();
        if (account == address(0)) revert ZeroAddress();
        frozen[account] = true;
        emit Frozen(account, true);
    }

    function unfreeze(address account) external onlyRole(FREEZER_ROLE) {
        if (freezingSealed) revert FreezingSealed();
        frozen[account] = false;
        emit Frozen(account, false);
    }

    /// @notice One-way. `mint` reverts afterwards even if `MINTER_ROLE` is still held.
    function disableMintingForever() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (mintingSealed) revert MintingSealed();
        mintingSealed = true;
        emit MintingPermanentlyDisabled();
    }

    /// @notice One-way. Existing `frozen` flags stay; nobody can freeze or unfreeze.
    function disableFreezingForever() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (freezingSealed) revert FreezingSealed();
        freezingSealed = true;
        emit FreezingPermanentlyDisabled();
    }

    /// @notice One-way. Holders can still `burn` / `burnFrom` their own tokens.
    function disableAdminBurnForever() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (adminBurnSealed) revert AdminBurnSealed();
        adminBurnSealed = true;
        emit AdminBurnPermanentlyDisabled();
    }

    /// @notice Optional explorer/wallet image. Not required to deploy or mint.
    function setContractURI(string calldata uri) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (contractURISealed) revert ContractURISealed();
        contractURI = uri;
        emit ContractURIUpdated(uri);
    }

    function disableContractURIForever() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (contractURISealed) revert ContractURISealed();
        contractURISealed = true;
        emit ContractURIPermanentlyDisabled();
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            if (frozen[from]) revert AccountFrozen(from);
            if (frozen[to]) revert AccountFrozen(to);
        } else if (from == address(0) && frozen[to]) {
            revert AccountFrozen(to);
        }
        super._update(from, to, value);
    }
}
