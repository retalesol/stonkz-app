// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

import {IPriceSource} from "./IPriceSource.sol";

/// @title The EVM mirror of the Solana program's `BaseOracle` account.
/// @notice Solana has no Chainlink, so that program carries a program-owned
/// price account written by an `oracle_authority`. This is the same shape, and
/// it exists on the EVM side for two reasons: it keeps the two programs' oracle
/// semantics comparable, and it is what the Foundry suite drives so the tests
/// do not depend on a forked mainnet aggregator.
///
/// On Robinhood Chain mainnet the deployed source is `ChainlinkPriceSource`.
/// This UUPS-upgradeable push oracle is for testnet, local runs, and any base
/// token that has no Chainlink feed — kept upgradeable through public beta so
/// oracle semantics can change without redeploying every consumer.
contract PushPriceSource is Initializable, UUPSUpgradeable, IPriceSource {
    struct Price {
        uint256 price1e6;
        uint256 conf1e6;
        uint64 publishedAt;
    }

    address public admin;
    address public oracleAuthority;
    mapping(address => Price) public prices;
    mapping(address => uint64) public maxAge;

    uint64 public defaultMaxAge;
    /// Widest confidence interval, in bps of the price, that still counts as an
    /// answer. Mirrors the Solana program's `MAX_ORACLE_CONF_BPS`.
    uint256 public constant MAX_CONF_BPS = 200;

    event PricePushed(address indexed baseToken, uint256 price1e6, uint256 conf1e6);
    event MaxAgeSet(address indexed baseToken, uint64 secs);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _admin, address _oracleAuthority, uint64 _defaultMaxAge) external initializer {
        require(_admin != address(0), "zero admin");
        require(_defaultMaxAge > 0, "maxAge");
        admin = _admin;
        oracleAuthority = _oracleAuthority;
        defaultMaxAge = _defaultMaxAge;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    function _authorizeUpgrade(address) internal override onlyAdmin {}

    function setOracleAuthority(address a) external onlyAdmin {
        oracleAuthority = a;
    }

    function setDefaultMaxAge(uint64 s) external onlyAdmin {
        require(s > 0, "maxAge");
        defaultMaxAge = s;
    }

    function setMaxAge(address baseToken, uint64 s) external onlyAdmin {
        maxAge[baseToken] = s;
        emit MaxAgeSet(baseToken, s);
    }

    function pushPrice(address baseToken, uint256 price1e6, uint256 conf1e6) external {
        require(msg.sender == oracleAuthority, "not oracle");
        require(price1e6 > 0, "price");
        prices[baseToken] = Price(price1e6, conf1e6, uint64(block.timestamp));
        emit PricePushed(baseToken, price1e6, conf1e6);
    }

    /// @inheritdoc IPriceSource
    function priceUsd1e6(address baseToken)
        external
        view
        returns (uint256 price1e6, uint256 publishedAt, uint256 maxAgeSecs)
    {
        uint64 age = maxAge[baseToken];
        maxAgeSecs = age == 0 ? defaultMaxAge : age;
        Price memory p = prices[baseToken];
        if (p.price1e6 == 0) return (0, 0, maxAgeSecs);
        // A price the publisher itself is unsure about is not an answer.
        if ((p.conf1e6 * 10_000) / p.price1e6 > MAX_CONF_BPS) return (0, 0, maxAgeSecs);
        return (p.price1e6, p.publishedAt, maxAgeSecs);
    }
}
