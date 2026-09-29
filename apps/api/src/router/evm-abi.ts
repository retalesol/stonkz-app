/**
 * ABI fragments for `programs/evm/src/StonkzLaunchpad.sol` and the ERC-20/WETH9
 * pieces `router/evm-tx.ts` needs to encode calldata against, trimmed to the
 * functions this API calls. Hand-written from the Solidity source rather than
 * imported from a Foundry build artifact — `programs/evm` has no committed
 * ABI JSON, and this keeps `apps/api` from depending on a Forge build
 * existing in whatever environment runs it.
 */

export const LAUNCHPAD_ABI = [
  {
    type: 'function',
    name: 'createToken',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'ticker', type: 'string' },
      { name: 'uri', type: 'string' },
      { name: 'supply', type: 'uint256' },
      { name: 'baseToken', type: 'address' },
      { name: 'feeBps', type: 'uint16' },
      { name: 'cashback', type: 'bool' },
    ],
    outputs: [{ name: 'token', type: 'address' }],
  },
  {
    type: 'function',
    name: 'buy',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amountBase', type: 'uint256' },
      { name: 'minOut', type: 'uint256' },
    ],
    outputs: [{ name: 'tokensOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'sell',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amountToken', type: 'uint256' },
      { name: 'minOut', type: 'uint256' },
    ],
    outputs: [{ name: 'baseOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'claimCreatorFees',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'stake',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'lockDays', type: 'uint16' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'unstake',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'claimStake',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [],
  },
  {
    // Permissionless. Reverts "not graduable" / "stale oracle" / "graduated".
    type: 'function',
    name: 'graduate',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'coinInfo',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'token', type: 'address' },
          { name: 'baseToken', type: 'address' },
          { name: 'creator', type: 'address' },
          { name: 'baseDecimals', type: 'uint8' },
          { name: 'feeBps', type: 'uint16' },
          { name: 'cashback', type: 'bool' },
          { name: 'complete', type: 'bool' },
          { name: 'graduated', type: 'bool' },
          { name: 'graduationReason', type: 'uint8' },
          { name: 'cbStart', type: 'uint64' },
          { name: 'graduatedAt', type: 'uint64' },
          { name: 'supply', type: 'uint256' },
          { name: 'virtualBase', type: 'uint256' },
          { name: 'virtualToken', type: 'uint256' },
          { name: 'realBase', type: 'uint256' },
          { name: 'realToken', type: 'uint256' },
          { name: 'k', type: 'uint256' },
          { name: 'tokensForSale', type: 'uint256' },
          { name: 'lpReserve', type: 'uint256' },
          { name: 'gradMcapBase', type: 'uint256' },
          { name: 'creationPrice1e6', type: 'uint256' },
          { name: 'protocolAccrued', type: 'uint256' },
          { name: 'opsAccrued', type: 'uint256' },
          { name: 'creatorBucketAccrued', type: 'uint256' },
          { name: 'creatorClaimableBase', type: 'uint256' },
          { name: 'creatorClaimableToken', type: 'uint256' },
          { name: 'bucketBase', type: 'uint256' },
          { name: 'bucketToken', type: 'uint256' },
          { name: 'eligibleStaked', type: 'uint256' },
          { name: 'flexStaked', type: 'uint256' },
          { name: 'totalWeight', type: 'uint256' },
          { name: 'accBasePerWeight', type: 'uint256' },
          { name: 'accTokenPerWeight', type: 'uint256' },
          { name: 'poolDustBase', type: 'uint256' },
          { name: 'poolDustToken', type: 'uint256' },
          { name: 'stakerAccruedBase', type: 'uint256' },
          { name: 'stakerAccruedToken', type: 'uint256' },
        ],
      },
    ],
  },
] as const;

/**
 * `StonkzLaunchpad.sol`'s `TokenCreated` event. `routes/launch.ts`'s
 * `/launch/confirm` decodes this off the transaction receipt to learn the
 * deployed token address (`CREATE`, not `CREATE2` — unpredictable ahead of
 * signing) and the *exact* curve parameters the chain derived, rather than
 * recomputing them from a possibly-since-moved oracle price.
 */
export const TOKEN_CREATED_EVENT_ABI = [
  {
    type: 'event',
    name: 'TokenCreated',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'baseToken', type: 'address', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'ticker', type: 'string', indexed: false },
      { name: 'supply', type: 'uint256', indexed: false },
      { name: 'feeBps', type: 'uint16', indexed: false },
      { name: 'cashback', type: 'bool', indexed: false },
      { name: 'cbStart', type: 'uint64', indexed: false },
      { name: 'virtualBase', type: 'uint256', indexed: false },
      { name: 'virtualToken', type: 'uint256', indexed: false },
      { name: 'tokensForSale', type: 'uint256', indexed: false },
      { name: 'lpReserve', type: 'uint256', indexed: false },
      { name: 'gradMcapBase', type: 'uint256', indexed: false },
      { name: 'basePrice1e6', type: 'uint256', indexed: false },
    ],
  },
] as const;

export const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/**
 * `programs/evm/src/StonkzRouter.sol` — the atomic native-in/out path
 * `router/evm-router.ts` builds calldata against. Hand-written from source
 * for the same reason as `LAUNCHPAD_ABI` above: no committed build artifact
 * to import from.
 */
export const STONKZ_ROUTER_ABI = [
  {
    type: 'function',
    name: 'buyWithEth',
    stateMutability: 'payable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'minTokenOut', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'tokensOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'sellForEth',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amountToken', type: 'uint256' },
      {
        name: 'permitData',
        type: 'tuple',
        components: [
          { name: 'value', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'v', type: 'uint8' },
          { name: 'r', type: 'bytes32' },
          { name: 's', type: 'bytes32' },
        ],
      },
      { name: 'minBaseOut', type: 'uint256' },
      { name: 'minEthOut', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'ethOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'buyViaV3',
    stateMutability: 'payable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'quotedBaseOut', type: 'uint256' },
      { name: 'maxSlippageBps', type: 'uint256' },
      { name: 'minTokenOut', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'tokensOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'sellViaV3',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amountToken', type: 'uint256' },
      {
        name: 'permitData',
        type: 'tuple',
        components: [
          { name: 'value', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'v', type: 'uint8' },
          { name: 'r', type: 'bytes32' },
          { name: 's', type: 'bytes32' },
        ],
      },
      { name: 'minBaseOut', type: 'uint256' },
      { name: 'fee', type: 'uint24' },
      { name: 'quotedEthOut', type: 'uint256' },
      { name: 'maxSlippageBps', type: 'uint256' },
      { name: 'minEthOut', type: 'uint256' },
      { name: 'amountInBase', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'ethOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'buyViaAggregator',
    stateMutability: 'payable',
    inputs: [
      { name: 'token', type: 'address' },
      {
        name: 'leg',
        type: 'tuple',
        components: [
          { name: 'commands', type: 'bytes' },
          { name: 'inputs', type: 'bytes[]' },
          { name: 'deadline', type: 'uint256' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'quotedOut', type: 'uint256' },
          { name: 'maxSlippageBps', type: 'uint256' },
        ],
      },
      { name: 'minTokenOut', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'tokensOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'sellViaAggregator',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amountToken', type: 'uint256' },
      {
        name: 'permitData',
        type: 'tuple',
        components: [
          { name: 'value', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'v', type: 'uint8' },
          { name: 'r', type: 'bytes32' },
          { name: 's', type: 'bytes32' },
        ],
      },
      { name: 'minBaseOut', type: 'uint256' },
      {
        name: 'leg',
        type: 'tuple',
        components: [
          { name: 'commands', type: 'bytes' },
          { name: 'inputs', type: 'bytes[]' },
          { name: 'deadline', type: 'uint256' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'quotedOut', type: 'uint256' },
          { name: 'maxSlippageBps', type: 'uint256' },
        ],
      },
      { name: 'minEthOut', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'ethOut', type: 'uint256' }],
  },
  {
    // Post a Pyth update, then `StonkzLaunchpad.graduate(token)`: the
    // permissionless oracle-trigger path (the launchpad's Pyth source bounds
    // a feed at ~120 s). `msg.value` pays the update fee; the rest is refunded.
    type: 'function',
    name: 'graduateWithPriceUpdate',
    stateMutability: 'payable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'priceUpdate', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

/** WETH9 — deposit()/withdraw() wrap/unwrap ETH; everything else is plain ERC-20. */
export const WETH_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
  },
  ...ERC20_ABI,
] as const;
