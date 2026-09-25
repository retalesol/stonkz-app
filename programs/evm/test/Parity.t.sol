// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CurveMath} from "../src/CurveMath.sol";

/// @notice Holds the Solidity math to `programs/parity-vectors.json`, which is
/// generated from the Rust program. Rust, TypeScript and Solidity all answer to
/// this one table, so a divergence surfaces here rather than as a user whose
/// EVM fill did not match their Solana-derived quote.
///
/// Large values arrive as decimal strings, because the vectors deliberately
/// include `u64::MAX` and 30-digit `k` values that a JSON number cannot carry.
contract ParityTest is Test {
    string json;

    function setUp() public {
        json = vm.readFile("../parity-vectors.json");
    }

    /// Read a column of decimal strings and widen it.
    function _col(string memory path) internal view returns (uint256[] memory out) {
        string[] memory raw = vm.parseJsonStringArray(json, path);
        out = new uint256[](raw.length);
        for (uint256 i = 0; i < raw.length; i++) {
            out[i] = vm.parseUint(raw[i]);
        }
    }

    /// @dev `vm.parseJson` guesses the ABI type from the value's shape and
    /// coerces long numeric strings, so a 33-digit `k` comes back as something
    /// `abi.decode(..., (string))` cannot read. `parseJsonString` is explicit.
    function _one(string memory path) internal view returns (uint256) {
        return vm.parseUint(vm.parseJsonString(json, path));
    }

    /* ------------------------------------------------------------ fee split */

    function test_FeeSplitMatchesRust() public view {
        uint256[] memory fee = _col("$.feeSplit.fee");
        uint256[] memory protocol = _col("$.feeSplit.protocol");
        uint256[] memory ops = _col("$.feeSplit.ops");
        uint256[] memory burn = _col("$.feeSplit.burn");
        uint256[] memory bucket = _col("$.feeSplit.creatorBucket");
        assertGt(fee.length, 0, "vectors present");

        for (uint256 i = 0; i < fee.length; i++) {
            CurveMath.FeeShares memory s = CurveMath.splitFee(fee[i]);
            assertEq(s.protocol, protocol[i], "protocol");
            assertEq(s.stonkzOps, ops[i], "ops");
            assertEq(s.burn, burn[i], "burn");
            assertEq(s.creatorBucket, bucket[i], "creatorBucket");
            assertEq(
                s.protocol + s.stonkzOps + s.burn + s.creatorBucket, fee[i], "shares must reconstruct the fee"
            );
        }
    }

    /* --------------------------------------------------------- bucket split */

    function test_CreatorBucketSplitMatchesRust() public view {
        uint256[] memory bucket = _col("$.creatorBucketSplit.bucket");
        uint256[] memory staked = _col("$.creatorBucketSplit.eligibleStaked");
        uint256[] memory circ = _col("$.creatorBucketSplit.circulating");
        uint256[] memory creatorW = _col("$.creatorBucketSplit.creator");
        uint256[] memory stakerW = _col("$.creatorBucketSplit.stakers");
        assertGt(bucket.length, 0, "vectors present");

        for (uint256 i = 0; i < bucket.length; i++) {
            (uint256 creator, uint256 stakers) =
                CurveMath.splitCreatorBucket(bucket[i], staked[i], circ[i]);
            assertEq(creator, creatorW[i], "creator");
            assertEq(stakers, stakerW[i], "stakers");
            assertEq(creator + stakers, bucket[i], "bucket conserved");
            assertLe(stakers, bucket[i] / 2, "stakers capped at half the bucket");
        }
    }

    /* -------------------------------------------------------------- cashback */

    function test_EffFeeBpsMatchesRust() public view {
        uint256[] memory baseBps = vm.parseJsonUintArray(json, "$.effFeeBps.baseBps");
        uint256[] memory elapsed = vm.parseJsonUintArray(json, "$.effFeeBps.elapsedSecs");
        bool[] memory cashback = vm.parseJsonBoolArray(json, "$.effFeeBps.cashback");
        uint256[] memory want = vm.parseJsonUintArray(json, "$.effFeeBps.effBps");
        assertGt(baseBps.length, 0, "vectors present");

        for (uint256 i = 0; i < baseBps.length; i++) {
            assertEq(
                uint256(CurveMath.effFeeBps(uint16(baseBps[i]), cashback[i], 0, elapsed[i])),
                want[i],
                "effFeeBps"
            );
        }
    }

    /* ---------------------------------------------------------------- curves */

    function test_CurveParamsMatchRust() public view {
        uint256 n = vm.parseJsonUint(json, "$.curveCount");
        assertGt(n, 0, "vectors present");

        for (uint256 i = 0; i < n; i++) {
            string memory cb = string.concat("$.curves[", vm.toString(i), "]");
            uint256 supply = _one(string.concat(cb, ".supplyAtoms"));
            uint8 dec = uint8(vm.parseJsonUint(json, string.concat(cb, ".baseDecimals")));

            CurveMath.CurveParams memory p =
                CurveMath.deriveCurve(supply, _one(string.concat(cb, ".price1e6")), dec);

            assertEq(p.tokensForSale, _one(string.concat(cb, ".tokensForSale")), "tokensForSale");
            assertEq(p.lpReserve, _one(string.concat(cb, ".lpReserve")), "lpReserve");
            assertEq(p.virtualToken, _one(string.concat(cb, ".virtualToken")), "virtualToken");
            assertEq(p.virtualBase, _one(string.concat(cb, ".virtualBase")), "virtualBase");
            assertEq(p.k, _one(string.concat(cb, ".k")), "k");
            assertEq(p.gradMcapBase, _one(string.concat(cb, ".gradMcapBase")), "gradMcapBase");
            assertEq(p.tokensForSale + p.lpReserve, supply, "supply conserved");
            // The whole point of the parameter choice: raised base at
            // graduation is 20% of the $69K cap, so the pool opens at the
            // curve's closing price.
            assertApproxEqRel(3 * p.virtualBase, p.gradMcapBase / 5, 1e12, "raised is 20% of cap");
        }
    }

    struct Fills {
        string[] side;
        uint256[] feeBps;
        uint256[] amountIn;
        uint256[] grossBase;
        uint256[] fee;
        uint256[] netBase;
        uint256[] tokensOut;
        uint256[] protocol;
        uint256[] ops;
        uint256[] burn;
        uint256[] bucket;
        uint256[] stateVb;
        uint256[] stateVt;
        uint256[] stateRb;
        uint256[] stateRt;
    }

    function test_FillsMatchRust() public view {
        uint256 n = vm.parseJsonUint(json, "$.curveCount");
        uint256 checked;
        for (uint256 i = 0; i < n; i++) {
            checked += _replay(string.concat("$.curves[", vm.toString(i), "]"));
        }
        assertGt(checked, 20, "expected a meaningful number of fills");
    }

    function _replay(string memory cb) internal view returns (uint256) {
        uint256 supply = _one(string.concat(cb, ".supplyAtoms"));
        CurveMath.CurveParams memory p = CurveMath.deriveCurve(
            supply,
            _one(string.concat(cb, ".price1e6")),
            uint8(vm.parseJsonUint(json, string.concat(cb, ".baseDecimals")))
        );
        CurveMath.State memory st =
            CurveMath.State(p.virtualBase, p.virtualToken, 0, p.tokensForSale, p.k);

        string memory f = string.concat(cb, ".fills");
        Fills memory v = Fills({
            side: vm.parseJsonStringArray(json, string.concat(f, ".side")),
            feeBps: vm.parseJsonUintArray(json, string.concat(f, ".feeBps")),
            amountIn: _col(string.concat(f, ".amountIn")),
            grossBase: _col(string.concat(f, ".grossBase")),
            fee: _col(string.concat(f, ".fee")),
            netBase: _col(string.concat(f, ".netBase")),
            tokensOut: _col(string.concat(f, ".tokensOut")),
            protocol: _col(string.concat(f, ".protocol")),
            ops: _col(string.concat(f, ".ops")),
            burn: _col(string.concat(f, ".burn")),
            bucket: _col(string.concat(f, ".creatorBucket")),
            stateVb: _col(string.concat(f, ".virtualBase")),
            stateVt: _col(string.concat(f, ".virtualToken")),
            stateRb: _col(string.concat(f, ".realBase")),
            stateRt: _col(string.concat(f, ".realToken"))
        });

        for (uint256 i = 0; i < v.side.length; i++) {
            // The vector records the state each fill was quoted against, so
            // drift is caught at the fill that caused it.
            assertEq(st.virtualBase, v.stateVb[i], "state vb");
            assertEq(st.virtualToken, v.stateVt[i], "state vt");
            assertEq(st.realBase, v.stateRb[i], "state rb");
            assertEq(st.realToken, v.stateRt[i], "state rt");

            uint256 fee;
            if (keccak256(bytes(v.side[i])) == keccak256("buy")) {
                CurveMath.BuyFill memory b =
                    CurveMath.buyQuote(st, uint16(v.feeBps[i]), v.amountIn[i]);
                assertEq(b.grossBase, v.grossBase[i], "grossBase");
                assertEq(b.fee, v.fee[i], "fee");
                assertEq(b.netBase, v.netBase[i], "netBase");
                assertEq(b.tokensOut, v.tokensOut[i], "tokensOut");
                fee = b.fee;
                st.virtualBase += b.netBase;
                st.virtualToken -= b.tokensOut;
                st.realBase += b.netBase;
                st.realToken -= b.tokensOut;
            } else {
                CurveMath.SellFill memory s =
                    CurveMath.sellQuote(st, uint16(v.feeBps[i]), v.amountIn[i]);
                assertEq(s.grossBase, v.grossBase[i], "grossBase");
                assertEq(s.fee, v.fee[i], "fee");
                assertEq(s.netBase, v.netBase[i], "netBase");
                fee = s.fee;
                st.virtualBase -= s.grossBase;
                st.virtualToken += v.amountIn[i];
                st.realBase -= s.grossBase;
                st.realToken += v.amountIn[i];
            }

            CurveMath.FeeShares memory sh = CurveMath.splitFee(fee);
            assertEq(sh.protocol, v.protocol[i], "fill protocol");
            assertEq(sh.stonkzOps, v.ops[i], "fill ops");
            assertEq(sh.burn, v.burn[i], "fill burn");
            assertEq(sh.creatorBucket, v.bucket[i], "fill bucket");
            assertGe(st.virtualBase * st.virtualToken, p.k, "constant product held");
        }

        string memory fin = string.concat(cb, ".final");
        assertEq(st.virtualBase, _one(string.concat(fin, ".virtualBase")), "final vb");
        assertEq(st.virtualToken, _one(string.concat(fin, ".virtualToken")), "final vt");
        assertEq(st.realBase, _one(string.concat(fin, ".realBase")), "final rb");
        assertEq(st.realToken, _one(string.concat(fin, ".realToken")), "final rt");
        assertEq(CurveMath.mcapBase(st, supply), _one(string.concat(fin, ".mcapBase")), "mcapBase");

        // Every one of these curves is driven to exhaustion by the last fill,
        // so each must land on $69,000.
        assertEq(st.realToken, 0, "script exhausts the curve");
        assertApproxEqRel(
            _one(string.concat(fin, ".mcapUsd1e6")),
            CurveMath.GRAD_MCAP_USD_1E6,
            1e12, // 1 part per million
            "graduated at $69,000"
        );
        return v.side.length;
    }
}
