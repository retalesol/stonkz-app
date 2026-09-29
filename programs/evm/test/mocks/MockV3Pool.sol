// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {TickMath} from "../../src/oracle/uniswap/TickMath.sol";

/// @notice The oracle surface of a Uniswap V3 pool — `slot0`, `liquidity`,
/// `observe`, `increaseObservationCardinalityNext` — with V3's accumulator
/// semantics: `tickCumulative` grows by `tick · dt`, and
/// `secondsPerLiquidityCumulativeX128` by `(dt << 128) / max(liquidity, 1)`,
/// piecewise-constant between `set` calls. `observe` reverts "OLD" for a
/// target before the first checkpoint, like a pool whose buffer does not reach
/// back that far. No swaps: tests move the price with `set`.
contract MockV3Pool {
    struct Checkpoint {
        uint32 ts;
        int56 tickCumulative;
        uint160 secondsPerLiquidityX128;
        int24 tick;
        uint128 liquidity;
    }

    address public token0;
    address public token1;
    int24 public tick;
    uint128 internal _liquidity;
    uint16 public observationCardinalityNext = 1;
    bool public broken;
    Checkpoint[] internal _cps;

    constructor(address a, address b, int24 tick_, uint128 liquidity_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        tick = tick_;
        _liquidity = liquidity_;
        _cps.push(Checkpoint(uint32(block.timestamp), 0, 0, tick_, liquidity_));
    }

    function liquidity() external view returns (uint128) {
        require(!broken, "broken");
        return _liquidity;
    }

    /// From now on the pool sits at `_tick` with `_liquidity` in range.
    function set(int24 tick_, uint128 liquidity_) external {
        (int56 tc, uint160 spl) = _cumulativeAt(uint32(block.timestamp));
        Checkpoint storage last = _cps[_cps.length - 1];
        if (last.ts == uint32(block.timestamp)) {
            (last.tick, last.liquidity) = (tick_, liquidity_);
        } else {
            _cps.push(Checkpoint(uint32(block.timestamp), tc, spl, tick_, liquidity_));
        }
        tick = tick_;
        _liquidity = liquidity_;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        require(!broken, "broken");
        return (TickMath.getSqrtRatioAtTick(tick), tick, 0, 1, observationCardinalityNext, 0, true);
    }

    function increaseObservationCardinalityNext(uint16 next) external {
        if (next > observationCardinalityNext) observationCardinalityNext = next;
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        require(!broken, "broken");
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            uint32 target = uint32(block.timestamp) - secondsAgos[i];
            require(target >= _cps[0].ts, "OLD");
            (tickCumulatives[i], secondsPerLiquidityCumulativeX128s[i]) = _cumulativeAt(target);
        }
    }

    function _cumulativeAt(uint32 t) internal view returns (int56 tc, uint160 spl) {
        uint256 i = _cps.length;
        while (i > 1 && _cps[i - 1].ts > t) i--;
        Checkpoint memory c = _cps[i - 1];
        uint32 dt = t - c.ts;
        unchecked {
            tc = c.tickCumulative + int56(c.tick) * int56(uint56(dt));
            uint128 l = c.liquidity > 0 ? c.liquidity : 1;
            spl = c.secondsPerLiquidityX128 + uint160((uint256(dt) << 128) / l);
        }
    }
}
