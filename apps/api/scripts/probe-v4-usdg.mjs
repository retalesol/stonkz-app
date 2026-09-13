import { createPublicClient, encodeAbiParameters, http, keccak256 } from 'viem';

const quoterAbi = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          {
            name: 'poolKey',
            type: 'tuple',
            components: [
              { name: 'currency0', type: 'address' },
              { name: 'currency1', type: 'address' },
              { name: 'fee', type: 'uint24' },
              { name: 'tickSpacing', type: 'int24' },
              { name: 'hooks', type: 'address' },
            ],
          },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'exactAmount', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
];

const stateAbi = [
  {
    type: 'function',
    name: 'getLiquidity',
    stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [{ type: 'uint128' }],
  },
];

const client = createPublicClient({ transport: http('https://rpc.testnet.chain.robinhood.com') });
const WETH = '0x7943e237c7F95DA44E0301572D358911207852Fa';
const USDG = '0x7E955252E15c84f5768B83c41a71F9eba181802F';
const ZERO = '0x0000000000000000000000000000000000000000';
const QUOTER = '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94';
const STATE = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
const amount = 10n ** 16n;

function poolId(key) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'uint24' },
        { type: 'int24' },
        { type: 'address' },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

const combos = [
  [500, 10],
  [3000, 60],
  [10000, 200],
  [100, 1],
  [100, 10],
  [500, 60],
  [3000, 10],
  [200, 2],
  [200, 10],
];

let hits = 0;
for (const [fee, tickSpacing] of combos) {
  for (const [c0, c1, zfo, label] of [
    [WETH, USDG, true, 'WETH→USDG'],
    [ZERO, USDG, true, 'ETH→USDG'],
  ]) {
    const key = { currency0: c0, currency1: c1, fee, tickSpacing, hooks: ZERO };
    const id = poolId(key);
    try {
      const liq = await client.readContract({
        address: STATE,
        abi: stateAbi,
        functionName: 'getLiquidity',
        args: [id],
      });
      if (liq > 0n) console.log('LIQ', label, fee, tickSpacing, liq.toString());
    } catch {
      /* ignore */
    }
    try {
      const { result } = await client.simulateContract({
        address: QUOTER,
        abi: quoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            poolKey: key,
            zeroForOne: zfo,
            exactAmount: amount,
            hookData: '0x',
          },
        ],
      });
      console.log('HIT', label, 'fee', fee, 'tick', tickSpacing, 'out', result[0].toString());
      hits++;
    } catch {
      /* ignore */
    }
  }
}
console.log('hits', hits);
