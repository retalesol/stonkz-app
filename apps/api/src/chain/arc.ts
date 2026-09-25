/**
 * Circle's Arc — an EVM L1 whose gas token is USDC.
 *
 * Mainnet (5042) is the only Arc there is: the public testnet (5042002)
 * closed on 17 Sep 2026, so there is no "safe" chain id to default to and
 * `NET_INFO.ARC.maxTradeUsd` caps every trade instead. The RPC and explorer
 * defaults below are placeholders until confirmed against docs.arc.io; both
 * are env-overridable (`ARC_RPC_URL`, `ARC_EXPLORER`) exactly like Base.
 */
export const ARC_CHAIN_ID = 5042;

export const ARC_RPC_URL = 'https://rpc.arc.network';

export const ARC_EXPLORER_URL = 'https://explorer.arc.network';

/** ~1s blocks with sub-second finality. */
export const ARC_BLOCK_MS = 1000;
