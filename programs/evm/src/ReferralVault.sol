// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SafeErc20} from "./SafeErc20.sol";

interface IERC20Balance {
    function balanceOf(address) external view returns (uint256);
}

interface IWETH9Vault {
    function deposit() external payable;
    function withdraw(uint256) external;
}

/// @dev The one thing this vault reads from the launchpad: who may hit the
/// emergency stop. Same selector as `StonkzLaunchpad.pauser()`; a launchpad
/// implementation that predates the pauser simply has no pauser here.
interface ILaunchpadPauser {
    function pauser() external view returns (address);
}

/// @title Self-serve referral payouts, redeemed against API-signed vouchers.
///
/// Referral commissions (15 / 10 / 5% of a referred trader's curve fee, out of
/// the platform's 15% leg) are accounted off chain. The protocol withdraw
/// authority moves the owed total from the launchpad's protocol vault into
/// this contract (`withdrawTreasury(0, WETH, amount, vault)`, or `fund`), and
/// a referrer pulls their share with a voucher the API signs:
///
///   ReferralClaim(address recipient, address asset, uint256 cumulativeAmount, uint256 deadline)
///
/// under an EIP-712 domain bound to this chain and this vault. The voucher
/// carries the referrer's **lifetime** entitlement; the vault pays
/// `cumulativeAmount - claimed[recipient][asset]` and remembers the new
/// cumulative. Replaying a voucher pays nothing, an older voucher pays
/// nothing, and no nonce is needed — the API only ever signs a number it has
/// already booked as earned, so the most a recipient can ever pull is what
/// the latest voucher says.
///
/// Trust boundaries:
/// - `signer` is a message-signing key held by the API. It holds no funds and
///   pays no gas; its blast radius is bounded by `maxPerDay[asset]` and by
///   what the operator chose to move into the vault. `admin` (the timelock on
///   mainnet) rotates it.
/// - `admin` is a two-step role (`proposeAdmin` / `acceptAdmin`). It sets the
///   signer and the caps, unpauses, and can sweep funds back to the treasury.
/// - `pause` is open to `admin` and to the launchpad's `pauser()`, so the same
///   hot key that can stop trading can stop payouts. Only `admin` unpauses.
/// - Nothing here is upgradeable and nothing here can reach the launchpad's
///   vaults: what is not funded cannot be claimed.
contract ReferralVault {
    using SafeErc20 for address;

    /* ------------------------------------------------------------- errors */

    error NotAdmin();
    error NotPauser();
    error NotPendingAdmin();
    error NotRecipient();
    error ZeroAddress();
    error ClaimsPaused();
    error VoucherExpired(uint256 deadline, uint256 nowTs);
    error BadSignature();
    error NothingToClaim(uint256 cumulativeAmount, uint256 alreadyClaimed);
    error AssetDisabled(address asset);
    error DailyCapExceeded(address asset, uint256 requested, uint256 remaining);
    error InsufficientVaultBalance(address asset, uint256 needed, uint256 held);
    error EthTransferFailed(address to, uint256 amount);
    error Reentrancy();

    /* ------------------------------------------------------------- events */

    event ReferralClaimed(
        address indexed recipient,
        address indexed asset,
        uint256 amount,
        uint256 cumulativeAmount,
        bool unwrapped,
        address caller
    );
    event SignerSet(address indexed previous, address indexed signer);
    event Funded(address indexed asset, address indexed from, uint256 amount);
    event MaxPerDaySet(address indexed asset, uint256 maxPerDay);
    event PauseSet(bool paused, address indexed by);
    event AdminProposed(address indexed pending);
    event AdminChanged(address indexed previous, address indexed admin);
    event Swept(address indexed asset, address indexed to, uint256 amount);

    /* ---------------------------------------------------------- constants */

    string public constant NAME = "StonkzReferralVault";
    string public constant VERSION = "1";

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant CLAIM_TYPEHASH =
        keccak256("ReferralClaim(address recipient,address asset,uint256 cumulativeAmount,uint256 deadline)");

    /// @notice `maxPerDay[asset]` value meaning "no daily cap".
    uint256 public constant UNCAPPED = type(uint256).max;

    /* ------------------------------------------------------------ storage */

    /// @notice Wrapped native token this vault can unwrap on the way out.
    address public immutable weth;
    /// @notice Where `pauser()` is read from.
    address public immutable launchpad;

    address public admin;
    address public pendingAdmin;
    /// @notice The API's voucher-signing key. Zero disables claims.
    address public signer;
    bool public paused;

    /// @notice Per-asset ceiling on what all recipients together may claim in
    /// one rolling day. `0` means the asset is not enabled at all (fail
    /// closed); `UNCAPPED` means no ceiling.
    mapping(address asset => uint256) public maxPerDay;
    mapping(address asset => uint256) public dayStart;
    mapping(address asset => uint256) public claimedToday;

    /// @notice Lifetime amount already paid, per recipient and asset. The
    /// voucher's `cumulativeAmount` is compared against this.
    mapping(address recipient => mapping(address asset => uint256)) public claimed;

    uint256 private _lock;

    /* ---------------------------------------------------------- modifiers */

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier nonReentrant() {
        if (_lock == 1) revert Reentrancy();
        _lock = 1;
        _;
        _lock = 0;
    }

    /* -------------------------------------------------------- constructor */

    /// @param admin_ Governance (the timelock on mainnet). Rotates the signer, sets caps, unpauses, sweeps.
    /// @param signer_ The API's message-signing key. May be zero at deploy and set later.
    /// @param weth_ The chain's WETH9, the asset every native-denominated commission is paid in.
    /// @param launchpad_ The `StonkzLaunchpad` whose `pauser()` may pause claims here.
    /// @param wethMaxPerDay Initial `maxPerDay[weth_]`, in wei. `0` leaves WETH disabled until admin enables it.
    constructor(address admin_, address signer_, address weth_, address launchpad_, uint256 wethMaxPerDay) {
        if (admin_ == address(0) || weth_ == address(0) || launchpad_ == address(0)) revert ZeroAddress();
        admin = admin_;
        signer = signer_;
        weth = weth_;
        launchpad = launchpad_;
        emit AdminChanged(address(0), admin_);
        emit SignerSet(address(0), signer_);
        if (wethMaxPerDay != 0) {
            maxPerDay[weth_] = wethMaxPerDay;
            emit MaxPerDaySet(weth_, wethMaxPerDay);
        }
    }

    /// @dev Only WETH's `withdraw` may push ETH here (on its way to a recipient).
    receive() external payable {
        if (msg.sender != weth) revert NotRecipient();
    }

    /* ------------------------------------------------------------ funding */

    /// @notice Pull `amount` of `asset` from the caller. Anyone may fund; the
    /// protocol withdraw authority normally funds through
    /// `withdrawTreasury(0, asset, amount, vault)` instead, which lands here
    /// without this call (and without the `Funded` event).
    function fund(address asset, uint256 amount) external {
        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(asset, msg.sender, amount);
    }

    /// @notice Wrap the sent ETH into WETH held by the vault.
    function fundEth() external payable {
        IWETH9Vault(weth).deposit{value: msg.value}();
        emit Funded(weth, msg.sender, msg.value);
    }

    /* ------------------------------------------------------------- claims */

    /// @notice Redeem a voucher, paying the ERC-20 `asset` to `to`. Anyone may
    /// submit it: the payment only ever goes to the voucher's recipient.
    function claim(address to, address asset, uint256 cumulativeAmount, uint256 deadline, bytes calldata sig)
        external
        nonReentrant
        returns (uint256 paid)
    {
        return _claim(to, asset, cumulativeAmount, deadline, sig, false);
    }

    /// @notice Redeem a WETH voucher as ETH. Only the recipient may choose
    /// this, so nobody can force ETH at a contract that cannot take it.
    function claimAsEth(address to, uint256 cumulativeAmount, uint256 deadline, bytes calldata sig)
        external
        nonReentrant
        returns (uint256 paid)
    {
        if (msg.sender != to) revert NotRecipient();
        return _claim(to, weth, cumulativeAmount, deadline, sig, true);
    }

    function _claim(
        address to,
        address asset,
        uint256 cumulativeAmount,
        uint256 deadline,
        bytes calldata sig,
        bool unwrap
    ) private returns (uint256 delta) {
        if (paused) revert ClaimsPaused();
        if (block.timestamp > deadline) revert VoucherExpired(deadline, block.timestamp);
        if (to == address(0)) revert ZeroAddress();

        address recovered = ECDSA.recover(hashClaim(to, asset, cumulativeAmount, deadline), sig);
        if (recovered == address(0) || recovered != signer) revert BadSignature();

        uint256 already = claimed[to][asset];
        if (cumulativeAmount <= already) revert NothingToClaim(cumulativeAmount, already);
        delta = cumulativeAmount - already;

        _consumeDailyCap(asset, delta);

        uint256 held = IERC20Balance(asset).balanceOf(address(this));
        if (held < delta) revert InsufficientVaultBalance(asset, delta, held);

        // Effects before interactions.
        claimed[to][asset] = cumulativeAmount;

        if (unwrap) {
            IWETH9Vault(weth).withdraw(delta);
            (bool ok,) = to.call{value: delta}("");
            if (!ok) revert EthTransferFailed(to, delta);
        } else {
            asset.safeTransfer(to, delta);
        }
        emit ReferralClaimed(to, asset, delta, cumulativeAmount, unwrap, msg.sender);
    }

    function _consumeDailyCap(address asset, uint256 delta) private {
        uint256 cap = maxPerDay[asset];
        if (cap == 0) revert AssetDisabled(asset);
        if (cap == UNCAPPED) return;
        uint256 start = dayStart[asset];
        uint256 used = claimedToday[asset];
        if (block.timestamp >= start + 1 days) {
            start = block.timestamp;
            used = 0;
            dayStart[asset] = start;
        }
        uint256 remaining = cap - used;
        if (delta > remaining) revert DailyCapExceeded(asset, delta, remaining);
        claimedToday[asset] = used + delta;
    }

    /* -------------------------------------------------------------- views */

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(NAME)), keccak256(bytes(VERSION)), block.chainid, address(this))
        );
    }

    /// @notice The EIP-712 digest the API signs.
    function hashClaim(address recipient, address asset, uint256 cumulativeAmount, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(CLAIM_TYPEHASH, recipient, asset, cumulativeAmount, deadline));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice What a voucher for `cumulativeAmount` would pay `recipient` right now.
    function claimable(address recipient, address asset, uint256 cumulativeAmount) external view returns (uint256) {
        uint256 already = claimed[recipient][asset];
        return cumulativeAmount > already ? cumulativeAmount - already : 0;
    }

    /// @notice Headroom left under today's cap for `asset` (`UNCAPPED` when unlimited, 0 when disabled).
    function remainingToday(address asset) external view returns (uint256) {
        uint256 cap = maxPerDay[asset];
        if (cap == 0) return 0;
        if (cap == UNCAPPED) return UNCAPPED;
        if (block.timestamp >= dayStart[asset] + 1 days) return cap;
        return cap - claimedToday[asset];
    }

    /// @notice The launchpad's emergency pauser, or zero when it has none.
    function launchpadPauser() public view returns (address) {
        (bool ok, bytes memory ret) = launchpad.staticcall(abi.encodeCall(ILaunchpadPauser.pauser, ()));
        if (!ok || ret.length != 32) return address(0);
        return abi.decode(ret, (address));
    }

    /* -------------------------------------------------------- governance */

    function setSigner(address next) external onlyAdmin {
        emit SignerSet(signer, next);
        signer = next;
    }

    /// @notice `0` disables the asset; `UNCAPPED` removes the ceiling.
    function setMaxPerDay(address asset, uint256 cap) external onlyAdmin {
        if (asset == address(0)) revert ZeroAddress();
        maxPerDay[asset] = cap;
        emit MaxPerDaySet(asset, cap);
    }

    /// @notice Stop claims. Admin, or the launchpad's pauser (an instant hot key).
    function pause() external {
        if (msg.sender != admin) {
            address p = launchpadPauser();
            if (p == address(0) || msg.sender != p) revert NotPauser();
        }
        paused = true;
        emit PauseSet(true, msg.sender);
    }

    /// @notice Admin only: the pauser can stop things, never start them again.
    function unpause() external onlyAdmin {
        paused = false;
        emit PauseSet(false, msg.sender);
    }

    function proposeAdmin(address next) external onlyAdmin {
        pendingAdmin = next;
        emit AdminProposed(next);
    }

    function acceptAdmin() external {
        if (pendingAdmin == address(0) || msg.sender != pendingAdmin) revert NotPendingAdmin();
        emit AdminChanged(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    /// @notice Return over-funded balance to the treasury. Admin only, so on
    /// mainnet it runs through the timelock like any other treasury move.
    function sweep(address asset, address to, uint256 amount) external onlyAdmin nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        asset.safeTransfer(to, amount);
        emit Swept(asset, to, amount);
    }
}
