// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

/// @dev Tiny UUPS implementation whose storage layout matches `StonkzLaunchpad`
/// through `admin`, used once on RH testnet to retarget a coin's `baseToken`
/// (real USDG is not mintable by the deployer). Upgrade to this, call
/// `adminRetargetBase`, upgrade back to the previous implementation.
contract LaunchpadRetargetPatch is Initializable, UUPSUpgradeable {
    struct Coin {
        address token;
        address baseToken;
        address creator;
        uint8 baseDecimals;
        uint16 feeBps;
        bool cashback;
        bool complete;
        bool graduated;
        uint8 graduationReason;
        uint64 cbStart;
        uint64 graduatedAt;
        uint256 supply;
        uint256 virtualBase;
        uint256 virtualToken;
        uint256 realBase;
        uint256 realToken;
        uint256 k;
        uint256 tokensForSale;
        uint256 lpReserve;
        uint256 gradMcapBase;
        uint256 creationPrice1e6;
        uint256 protocolAccrued;
        uint256 opsAccrued;
        uint256 creatorBucketAccrued;
        uint256 creatorClaimableBase;
        uint256 creatorClaimableToken;
        uint256 bucketBase;
        uint256 bucketToken;
        uint256 eligibleStaked;
        uint256 flexStaked;
        uint256 totalWeight;
        uint256 accBasePerWeight;
        uint256 accTokenPerWeight;
        uint256 poolDustBase;
        uint256 poolDustToken;
        uint256 stakerAccruedBase;
        uint256 stakerAccruedToken;
    }

    struct Position {
        uint256 amount;
        uint256 weight;
        uint256 baseDebt;
        uint256 tokenDebt;
        uint256 unclaimedBase;
        uint256 unclaimedToken;
        uint64 lockUntil;
        uint16 lockDays;
    }

    mapping(address => Coin) public coins;
    mapping(address => mapping(address => Position)) public positions;
    mapping(bytes32 => address) public tokenByTicker;
    mapping(address => uint256) public protocolRevenue;
    mapping(address => uint256) public stonkzOps;

    address public admin;
    address public pendingAdmin;
    address public protocolWithdrawAuthority;
    address public opsWithdrawAuthority;
    address public migrationAuthority;
    address public migrator;
    address public priceSource;

    bool public tradingPaused;
    bool public launchPaused;
    bool public protocolWithdrawalsPaused;
    bool public opsWithdrawalsPaused;
    bool public oracleGraduationPaused;

    uint64 public maxOracleStaleness;
    uint256 public tokenCount;
    uint256 private _lock;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function adminRetargetBase(address token, address newBase) external {
        require(msg.sender == admin, "not admin");
        require(newBase != address(0), "zero");
        Coin storage c = coins[token];
        require(c.token != address(0), "unknown");
        require(!c.complete && !c.graduated, "closed");
        require(c.realBase == 0, "has reserves");
        c.baseToken = newBase;
        c.baseDecimals = 6;
    }

    function _authorizeUpgrade(address) internal override {
        require(msg.sender == admin, "not admin");
    }
}
