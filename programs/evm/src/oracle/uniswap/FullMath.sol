// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Uniswap V3 `FullMath`, ported to Solidity 0.8.
/// @notice 512-bit `a * b / denominator` without intermediate overflow, by
/// Remco Bloemen (MIT). The logic is Uniswap v3-core's `libraries/FullMath.sol`
/// line for line; the only 0.8 changes are the `unchecked` block (the original
/// relies on 0.7 wrapping arithmetic) and `(0 - denominator) & denominator` for
/// the largest power of two dividing `denominator`, which 0.8 will not compute
/// as `-denominator`. Tested against OpenZeppelin's `Math.mulDiv` in
/// `test/StockPriceSource.t.sol`.
library FullMath {
    /// @dev Reverts if the result overflows 256 bits or `denominator == 0`.
    function mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0; // least significant 256 bits of the product
            uint256 prod1; // most significant 256 bits of the product
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }

            if (prod1 == 0) {
                require(denominator > 0);
                assembly {
                    result := div(prod0, denominator)
                }
                return result;
            }

            require(denominator > prod1);

            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, denominator)
            }
            assembly {
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }

            uint256 twos = (0 - denominator) & denominator;
            assembly {
                denominator := div(denominator, twos)
            }
            assembly {
                prod0 := div(prod0, twos)
            }
            assembly {
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;

            // Newton-Raphson inverse of `denominator` mod 2^256, correct to 4
            // bits to start and doubling each step.
            uint256 inv = (3 * denominator) ^ 2;
            inv *= 2 - denominator * inv; // 2^8
            inv *= 2 - denominator * inv; // 2^16
            inv *= 2 - denominator * inv; // 2^32
            inv *= 2 - denominator * inv; // 2^64
            inv *= 2 - denominator * inv; // 2^128
            inv *= 2 - denominator * inv; // 2^256

            result = prod0 * inv;
            return result;
        }
    }
}
