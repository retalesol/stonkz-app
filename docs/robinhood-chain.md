# Robinhood Chain — sourced facts for the Stonkz build

Research date: **2026-09-06**. Author: research pass for plan step 51 and `FULL_BUILDOUT_GUIDE.md` §11 open decisions.

Every material claim below carries a URL and a publication/verification date. Where sources conflict, both are shown and the
conflict is called out rather than resolved silently. Anything I could not source is marked **Unknown** — treat those as
config flags, not constants.

> **Headline:** Robinhood Chain is real, public, and permissionless, and it is an **Arbitrum Orbit (Nitro) L2 with ETH gas**.
> Uniswap v2/v3/v4 and UniswapX are all live on it, so the plan's `UNISWAP → CURVE` route is buildable. The two plan
> assumptions that do **not** survive contact with the facts are (a) "burn the LP and keep the fee-claim authority" — that is
> self-contradictory on v2 and requires a locker contract on v3/v4, and (b) the priority-fee / MEV-shield trade settings,
> which are no-ops on a first-come-first-served sequencer.

---

## 1. Verdict table

| # | Fact | Value | Confidence | Source (date) |
|---|---|---|---|---|
| 1 | Chain exists publicly | **Yes — public mainnet, permissionless deployment** | Confirmed | [docs.robinhood.com/chain](https://docs.robinhood.com/chain/) (live 2026-09-06); [robinhood.com newsroom](https://robinhood.com/us/en/newsroom/robinhood-accelerates-global-expansion-robinhood-chain-mainnet-stock-tokens-agentic-trading/) (2026-07-01) |
| 2 | Mainnet launch date | **2026-07-01** (testnet 2026-02-10) | Confirmed | [Decrypt](https://decrypt.co/resources/what-robinhood-chain-ethereum-layer-2-network-tokenized-stocks); [datawallet](https://www.datawallet.com/crypto/robinhood-chain-explained) |
| 3 | Mainnet chain id | **4663** (`0x1237`) | Confirmed | [docs.robinhood.com/chain/connecting](https://docs.robinhood.com/chain/connecting/); [RH support](https://robinhood.com/us/en/support/articles/robinhood-chain-mainnet/); `eth_chainId` read 2026-08-25 by [xroot.dev](https://xroot.dev/blog/robinhood-chain-read-directly) |
| 4 | Testnet chain id | **46630** (`0xB626`) | Confirmed | [docs.robinhood.com/chain/connecting](https://docs.robinhood.com/chain/connecting/) |
| 5 | Public RPC | `https://rpc.mainnet.chain.robinhood.com` (rate-limited, **not for production**) | Confirmed | [docs.robinhood.com/chain/connecting](https://docs.robinhood.com/chain/connecting/) |
| 6 | Production RPC / WS | Alchemy `https://robinhood-mainnet.g.alchemy.com/v2/{KEY}` / `wss://…` — Alchemy is the *recommended* provider; QuickNode, Blockdaemon, dRPC, Validation Cloud also serve the chain | Confirmed | [docs.robinhood.com/chain/connecting](https://docs.robinhood.com/chain/connecting/) |
| 7 | Sequencer feed (for the indexer) | `wss://feed.mainnet.chain.robinhood.com` | Confirmed | [docs.robinhood.com/chain/connecting](https://docs.robinhood.com/chain/connecting/) |
| 8 | Block explorer | `https://robinhoodchain.blockscout.com` (Blockscout) | Likely — host spelling varies across sources, see §2.3 | [RH support](https://robinhood.com/us/en/support/articles/robinhood-chain-mainnet/) |
| 9 | **Gas token** | **ETH, 18 decimals. The UI's ETH assumption is correct.** No native chain token, no announced airdrop | Confirmed | [docs.robinhood.com/chain](https://docs.robinhood.com/chain/); [trustswap network details](https://trustswap.com/robinhood/network-details) |
| 10 | Stack | Arbitrum Orbit / Nitro optimistic rollup ("Arbitrum Dedicated Blockchains"), settling to Ethereum, **EIP-4844 blobs for DA** | Confirmed | [docs.robinhood.com/chain](https://docs.robinhood.com/chain/); precompile probe (`0x6b` returns `0xfe`) 2026-08-25 [xroot.dev](https://xroot.dev/blog/robinhood-chain-read-directly) |
| 11 | EVM equivalence | Full. Solidity/Vyper deploy unmodified; Hardhat/Foundry/ethers/viem/wagmi work; PUSH0, CREATE2 deployer, Multicall3, Permit2, Safe v1.4.1 all present at canonical addresses | Confirmed | [docs.robinhood.com/chain](https://docs.robinhood.com/chain/); on-chain 2026-08-25 [xroot.dev](https://xroot.dev/blog/robinhood-chain-read-directly) |
| 12 | `block.number` semantics | **Returns an estimate of the L1 block number**, not the L2 height. Use `ArbSys(0x64).arbBlockNumber()` for L2 height | Confirmed (primary docs; one third-party source disagrees, see §5.1) | [docs.robinhood.com/chain/differences-from-ethereum](https://docs.robinhood.com/chain/differences-from-ethereum/) |
| 13 | `block.timestamp` semantics | L2 sequencer clock, ≈ wall clock, updated per L2 block. Safe over hours, loose over seconds | Likely | [docs.robinhood.com/chain/differences-from-ethereum](https://docs.robinhood.com/chain/differences-from-ethereum/); [investorscenter chain-facts](https://docs.investorscenter.finance/docs/reference/chain-facts) (re-verified 2026-08-30) |
| 14 | Gas model | Two components: L2 execution + L1 calldata fee. `gasleft()` and estimation differ from Ethereum. `ArbGasInfo` `0x6C`, `NodeInterface` `0xC8` | Confirmed | [docs.robinhood.com/chain/differences-from-ethereum](https://docs.robinhood.com/chain/differences-from-ethereum/) |
| 15 | Transaction ordering | **First-come-first-served by sequencer arrival time. No priority-fee ordering, no public mempool, no PGA.** Priority fees do not buy inclusion | Confirmed | [docs.robinhood.com/chain](https://docs.robinhood.com/chain/); [docs …/differences-from-ethereum](https://docs.robinhood.com/chain/differences-from-ethereum/) |
| 16 | Base fee | ≈0.02 gwei floor; ~0.023 gwei measured | Likely | measured 2026-08-25 [xroot.dev](https://xroot.dev/blog/robinhood-chain-read-directly); [ArbOS 61](https://docs.arbitrum.io/run-arbitrum-node/arbos-releases/arbos61) |
| 17 | Confirmation model | Sequencer soft confirmation ~100–250 ms; Ethereum finality ~13 min after batch; withdrawals to L1 have a 7-day challenge period | Likely | [getblock RH reference](https://docs.getblock.io/api-reference/robinhood); [backpack learn](https://learn.backpack.exchange/articles/what-is-robinhood-chain); [docs …/bridging](https://docs.robinhood.com/chain/bridging/) |
| 18 | Account abstraction | **ERC-4337 is first-class**, with Alchemy gas sponsorship / batching / session keys available | Confirmed | [docs.robinhood.com/chain](https://docs.robinhood.com/chain/) |
| 19 | Sequencer-level censorship | Real and **in active use**: `ArbFilteredTransactionsManager` at `0x74`, one authorised filterer `0xebDc18A1…24b7`, ~6,092 `addFilteredTransaction` calls, first 2026-06-30, ≈150/day. Can defeat L1 force-inclusion | Confirmed (mechanism) / Likely (usage volume, one investigator) | [Beosin code analysis](https://beosin.com/resources/robinhood-chain-stock-token-practice-code-analysis-on-token-contract-and-blockchain-protocol) (2026-07-20); nonce + txlist read 2026-08-25 [xroot.dev](https://xroot.dev/blog/robinhood-chain-read-directly) |
| 20 | **DEX availability** | **Uniswap v2, v3, v4 and UniswapX all live since day one. Uniswap is the chain's primary public AMM**, with Web App, Wallet and API support | Confirmed | [blog.uniswap.org](https://blog.uniswap.org/robinhood-chain-is-live) (2026-07-02); [docs.robinhood.com/chain](https://docs.robinhood.com/chain/) ecosystem table |
| 21 | Universal Router | `0x8876789976decbfcbbbe364623c63652db8c0904` | Confirmed | [developers.uniswap.org v3 RH deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments); [Uniswap/contracts deployments/4663.md](https://github.com/Uniswap/contracts/blob/main/deployments/4663.md) |
| 22 | Uniswap **v2** (fungible LP) | Factory `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f`, Router02 `0x89e5DB8B5aA49aA85AC63f691524311AEB649eba` | Confirmed | [developers.uniswap.org v2 deployments](https://developers.uniswap.org/docs/protocols/v2/deployments); [deployments/4663.md](https://github.com/Uniswap/contracts/blob/main/deployments/4663.md) |
| 23 | Uniswap **v3** | Factory `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`, SwapRouter02 `0xCaf681a66D020601342297493863E78C959E5cb2`, QuoterV2 `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7`, NFPM `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` | Confirmed | [developers.uniswap.org v3 RH deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments) |
| 24 | Uniswap **v4** | PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951`, PositionManager `0x58daEC3116AAe6d93017bAAea7749052E8a04fA7`, V4Quoter `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94`, StateView `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` | Confirmed | [developers.uniswap.org/deployments](https://developers.uniswap.org/deployments); [deployments/4663.md](https://github.com/Uniswap/contracts/blob/main/deployments/4663.md) |
| 25 | Permit2 / WETH9 | Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`; WETH9 = aeWETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | Confirmed | Universal Router constructor params in [deployments/4663.md](https://github.com/Uniswap/contracts/blob/main/deployments/4663.md); WETH re-read on-chain 2026-07-30 [chain-facts](https://docs.investorscenter.finance/docs/reference/chain-facts) |
| 26 | Uniswap **Trading API** supports 4663 | **Yes** — `tokenInChainId`/`tokenOutChainId` enum includes `4663`; official quickstart says "set the chain ID 4663" | Confirmed (one stale mirror disagrees, see §3.2) | [blog.uniswap.org](https://blog.uniswap.org/robinhood-chain-is-live) (2026-07-02); Trading API `/v1/quote` schema |
| 27 | **Atomic native→base→curve in one tx** | **Possible, but only via a Stonkz-owned periphery router contract.** Not possible by relaying Trading API calldata straight from the user's EOA | Confirmed (by construction; see §3.3) | Universal Router recipient semantics; ERC-4337 support |
| 28 | **LP form at graduation** | **Both exist**: v2 pools mint fungible ERC-20 LP tokens; v3/v4 positions are ERC-721 NFTs. Choice is ours | Confirmed | rows 22–24 |
| 29 | **"Burn LP but keep fee-claim authority"** | **Not achievable as written on v2** (burning LP tokens forfeits the fees — they are the same claim). Achievable on **v3/v4 via an immutable locker contract** that owns the NFT and exposes `collect` but never `decreaseLiquidity` | Confirmed (protocol semantics) | §4; precedent: [pools.trade](https://blog.uniswap.org/pools-trade-a-new-way-to-launch-on-robinhood-chain) protocol-held locked position (2026-08-05); [StonkBrokers v3/v4 lockers](https://www.stonkbrokers.cash/docs) |
| 30 | Launchpad precedent on-chain | **pools.trade**, by Uniswap Labs, live 2026-08-05: fixed 1B supply, v4 pool from block one, permanently locked protocol-held position, 0.25% LP fee autocompounds, optional 0.05% creator fee, off-chain **$50K FDV** graduation display | Confirmed | [blog.uniswap.org](https://blog.uniswap.org/pools-trade-a-new-way-to-launch-on-robinhood-chain); [bitquery pools.trade API](https://docs.bitquery.io/docs/blockchain/robinhood/pools-trade-api/) |
| 31 | Wallet — native support | Robinhood Wallet supports Robinhood Chain natively (send/receive + dapp connect). Backpack Wallet also native. MetaMask/OKX/any EVM wallet by manual network add | Confirmed | [RH support](https://robinhood.com/us/en/support/articles/robinhood-chain-mainnet/); [RH Wallet FAQ](https://robinhood.com/us/en/support/articles/robinhood-wallet-faqs/); [backpack learn](https://learn.backpack.exchange/articles/what-is-robinhood-chain) |
| 32 | Wallet — EIP-1193 injection | **Robinhood Wallet is mobile-only (iOS/Android); there is no browser extension**, so no `window.ethereum` on desktop. Injection only applies to its in-app web3 browser | Confirmed | [RH Wallet FAQ](https://robinhood.com/us/en/support/articles/robinhood-wallet-faqs/); [connect to dapps](https://robinhood.com/us/en/support/articles/connect-to-dapps/) |
| 33 | Wallet — WalletConnect | **Supported, and Robinhood Chain is in the listed WalletConnect network set** (desktop = QR scan). Same page still carries a stale sentence telling users to "set the network to Polygon or Ethereum" | Confirmed | [connect to dapps](https://robinhood.com/us/en/support/articles/connect-to-dapps/) (read 2026-09-06) |
| 34 | Wallet — EIP-4361 (SIWE) | **No Robinhood document states `personal_sign` support explicitly.** It follows from "any wallet or dapp that supports standard Ethereum tooling can connect", and WalletConnect's wallet SDK specifies `personal_sign`/`eth_sign`/`eth_signTypedData`. SIWE is chain-agnostic message signing, so no chain feature is required | **Likely** — verify against a real device before SIWE ships | [docs.robinhood.com/chain](https://docs.robinhood.com/chain/); [WalletConnect EVM methods](https://docs.walletconnect.network/wallet-sdk/chain-support/evm) |
| 35 | Tokenized stocks exist | **Yes.** "Stock Tokens" — standard ERC-20, 18 decimals, ERC-8056 scaled-UI, issued by Robinhood Assets (Jersey) Ltd. ~96 tokenized at launch; **203 canonical tokens** enumerated 2026-08-14 | Confirmed | [docs …/stock-tokens](https://docs.robinhood.com/chain/stock-tokens/); [Beosin](https://beosin.com/resources/robinhood-chain-stock-token-practice-code-analysis-on-token-contract-and-blockchain-protocol) (2026-07-20); [chain-facts](https://docs.investorscenter.finance/docs/reference/chain-facts) |
| 36 | Stock tokens tradeable on the AMM | **Yes** — Uniswap supports Stock Tokens on Web App, Wallet and API via the AMM and UniswapX from day one; "fully transferrable" | Confirmed (one source disagrees, see §6.2) | [blog.uniswap.org](https://blog.uniswap.org/robinhood-chain-is-live) (2026-07-02) |
| 37 | Stock token transfer control | **Per-address blocklist, not an allowlist** (`onlyNotBlocked` on both sides and the caller) — the USDC/USDT default-open model. **Plus a global kill switch**: one registry can pause every stock token at once | Confirmed (verified source/bytecode read) | [xroot.dev](https://xroot.dev/blog/robinhood-chain-read-directly) (read 2026-08-25); [Beosin](https://beosin.com/resources/robinhood-chain-stock-token-practice-code-analysis-on-token-contract-and-blockchain-protocol) |
| 38 | Stock tokens are **not** rebasing | ERC-8056 changes only a UI multiplier. `balanceOf`, `totalSupply` and `transfer` operate on raw amounts and do not move during a corporate action — safe for a curve vault | Confirmed | [EIP-8056](https://eips.ethereum.org/EIPS/eip-8056); [BEP-677](https://github.com/bnb-chain/BEPs/blob/master/BEPs/BEP-677.md) |
| 39 | Stock token jurisdiction | **Not available to US persons.** Also restricted in Canada, UK, Switzerland, UAE and sanctioned jurisdictions. Legal form = tokenised **debt securities**, not equity | Confirmed | [docs …/stock-tokens](https://docs.robinhood.com/chain/stock-tokens/); [robinhood.com/rhj/stocktokens](https://robinhood.com/rhj/stocktokens/) |
| 40 | Oracle | **Chainlink**, `AggregatorV3Interface`, USD feeds 8 decimals. ETH/USD proxy `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`, **heartbeat 86400 s**. 57 feeds in the canonical directory for chain 4663 | Confirmed | [docs …/oracles-and-price-feeds](https://docs.robinhood.com/chain/oracles-and-price-feeds/); Chainlink [reference-data-directory `feeds-robinhood-mainnet.json`](https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json) (fetched 2026-09-06) |
| 41 | Pyth on Robinhood Chain | Not listed in Robinhood's ecosystem table; no deployment found. **Chainlink is the only oracle to code against** | Likely (absence of evidence) | [docs.robinhood.com/chain](https://docs.robinhood.com/chain/) |
| 42 | Chainlink **L2 Sequencer Uptime Feed** | **Not found for chain 4663** — no entry in the reference directory, none located by third-party research. Chainlink's standard L2 staleness guard therefore cannot be applied as documented | **Unknown** | directory fetch 2026-09-06 (0 sequencer entries); [chain-facts](https://docs.investorscenter.finance/docs/reference/chain-facts) marks it ⚠️ not located |
| 43 | Stablecoin base | **USDG (Paxos Global Dollar) `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals** — the chain's headline stablecoin and recommended stable quote. USDC/USDT **Chainlink feeds exist**, but I could not verify canonical token addresses | Confirmed (USDG) / **Unknown** (USDC, USDT addresses) | [docs.robinhood.com/chain](https://docs.robinhood.com/chain/) ecosystem; on-chain decimals read 2026-07-30 [chain-facts](https://docs.investorscenter.finance/docs/reference/chain-facts) |
| 44 | Liquidity depth | TVL $426.9M; DEX volume $322.8M on 2026-08-04; Uniswap v3+v4 the two largest venues; Uniswap fees $1.67M/24h. Weekly volume **down 33%** week-over-week | Likely (single aggregator snapshot, one month stale) | [The Defiant](https://thedefiant.io/news/defi/uniswap-pools-trade-launchpad-live-frong-memecoin) citing DefiLlama (2026-08-05) |
| 45 | Hostile pool population | A 2026-08-14 sweep of all 203 stock tokens found ~19.5k v4 pools, ~12.7k with liquidity, of which **~1.9k are fee-trap pools at 88–100% LP fee engineered to fleece naive routers**, ~8.8k dynamic-fee hooked pools, and only a handful of genuine venues | Likely (single researcher, method documented) | [chain-facts](https://docs.investorscenter.finance/docs/reference/chain-facts) |
| 46 | Token impersonation | Rampant. Fifty results for one ticker; clones copy names character-for-character and append `• Robinhood Token`. Canonical provenance = `StockFactory` `Deployed` event / EIP-1967 beacon slot `0xe10b…1b00`, **never** symbol match | Confirmed | [xroot.dev](https://xroot.dev/blog/robinhood-chain-read-directly); [chain-facts](https://docs.investorscenter.finance/docs/reference/chain-facts) impersonator table |

---

## 2. Chain identity (plan step 51, plan step 45, plan step 5)

### 2.1 It is live and it is permissionless

Robinhood Chain is not announced-only and not a private rollup. Mainnet went live **2026-07-01** at a London event, after a
public testnet from **2026-02-10** that Robinhood's Q1 2026 results say processed over 100M transactions
([datawallet, dated](https://www.datawallet.com/crypto/robinhood-chain-explained)). The official docs describe it as
"permissionless and developer-friendly… Anyone can interact with the network, build applications, and deploy smart
contracts" ([docs.robinhood.com/chain](https://docs.robinhood.com/chain/)).

That claim has been checked independently rather than taken on trust: on 2026-08-25 an investigator estimated gas for a
contract creation from an address the chain had never seen and got a price quote rather than a rejection, which is what a
deployer allowlist would produce ([xroot.dev](https://xroot.dev/blog/robinhood-chain-read-directly)). The same read
confirmed the chain is genuinely a Nitro chain (the precompile at `0x…006b` returns the single byte `0xfe`, a property a
chain cannot fake without being one).

**For Stonkz:** `programs/evm` can be deployed by us, on mainnet, without asking anyone. No allowlist gate blocks Phase 2.A.

### 2.2 Config values to code against

```
# mainnet
RH_CHAIN_ID=4663
RH_RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}   # production
RH_RPC_URL_PUBLIC=https://rpc.mainnet.chain.robinhood.com              # dev/fallback only, rate-limited
RH_WS_URL=wss://robinhood-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}
RH_SEQUENCER_FEED=wss://feed.mainnet.chain.robinhood.com
RH_EXPLORER=https://robinhoodchain.blockscout.com

# testnet
RH_TESTNET_CHAIN_ID=46630
RH_TESTNET_RPC_URL=https://rpc.testnet.chain.robinhood.com
RH_TESTNET_EXPLORER=https://explorer.testnet.chain.robinhood.com
RH_TESTNET_FAUCET=https://faucet.testnet.chain.robinhood.com   # capped 0.01 ETH / 24h
```

Robinhood's own docs say the public RPC is "rate-limited and not recommended for production use" and name **Alchemy** as
the recommended provider, which also supplies the archive endpoint the indexer needs for historical reads
([docs …/connecting](https://docs.robinhood.com/chain/connecting/)). This maps onto the plan's Helius-for-Solana
arrangement: Alchemy is the RH equivalent, and plan step 5's `.env.example` should carry an `ALCHEMY_KEY`, not a bare
public URL.

### 2.3 One unresolved detail: the explorer hostname

Robinhood's own support page and docs give **`robinhoodchain.blockscout.com`**
([RH support](https://robinhood.com/us/en/support/articles/robinhood-chain-mainnet/)). Beosin's article links
`robinhood-chain.blockscout.com` (with a hyphen), and Uniswap's deployment log links a
`8crv4vmq6tiu1yqr.blockscout.com` host, which looks like a Blockscout preview instance rather than the canonical one.
Because a documented ecosystem of lookalike explorers and phishing RPCs has grown around this chain
([trustswap network details](https://trustswap.com/robinhood/network-details)), **put the explorer base URL in config and
take the value from Robinhood's own page**, and do not build share/verify links by string-guessing the host.

### 2.4 A risk to record, not to solve

The chain owner is an `UpgradeExecutor` proxy, and there is one authorised transaction filterer. ArbOS's filtering
mechanism lets an authorised address register a transaction hash such that the state transition function forcibly fails
it — **including a transaction force-included via L1**, which is normally the escape hatch that makes a rollup
censorship-resistant ([Beosin](https://beosin.com/resources/robinhood-chain-stock-token-practice-code-analysis-on-token-contract-and-blockchain-protocol),
2026-07-20). It is not dormant: the filterer EOA's nonce showed **6,092 calls** to `addFilteredTransaction`, first landing
2026-06-30 (the day before public mainnet) and running at roughly 150/day through 2026-08-09
([xroot.dev](https://xroot.dev/blog/robinhood-chain-read-directly), read 2026-08-25).

To be precise about what that establishes: it shows the mechanism is operational, not what was filtered or why, and
attributing the filterer EOA to Robinhood is inference. The relevant consequence for us is narrow — **treasury withdrawal
runbooks must not assume L1 force-inclusion as a guaranteed escape hatch** (plan step 142), and a launchpad with a revenue
stream on this chain carries a switch-flip risk that should be written into the ops runbook rather than engineered around.

---

## 3. DEX availability and atomic composition (plan phase 2.R)

### 3.1 Uniswap is fully deployed — the plan's route is buildable

**Uniswap v2, v3, v4 and UniswapX are all live on Robinhood Chain**, and Uniswap is the chain's *primary public AMM*, with
Web App, Wallet and API support from day one ([blog.uniswap.org, 2026-07-02](https://blog.uniswap.org/robinhood-chain-is-live)).
Robinhood's own ecosystem table lists Uniswap under "Public DEX" ([docs.robinhood.com/chain](https://docs.robinhood.com/chain/)).

Full address set for chain 4663, from Uniswap's own registries
([v2 deployments](https://developers.uniswap.org/docs/protocols/v2/deployments),
[v3 Robinhood Chain deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments),
[deployments index](https://developers.uniswap.org/deployments),
[Uniswap/contracts `deployments/4663.md`](https://github.com/Uniswap/contracts/blob/main/deployments/4663.md)):

| Contract | Address |
|---|---|
| UniversalRouter | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| WETH9 (aeWETH) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| UniswapV2Factory | `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f` |
| UniswapV2Router02 | `0x89e5DB8B5aA49aA85AC63f691524311AEB649eba` |
| UniswapV3Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| SwapRouter02 (v3) | `0xCaf681a66D020601342297493863E78C959E5cb2` |
| QuoterV2 (v3) | `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` |
| NonfungiblePositionManager (v3) | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |
| TickLens (v3) | `0x7dfd4f31be6814d2906bde155c3e1b146eac1468` |
| PoolManager (v4) | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| PositionManager (v4) | `0x58daEC3116AAe6d93017bAAea7749052E8a04fA7` |
| V4Quoter | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` |
| StateView (v4) | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |

Two cautions. First, `@uniswap/sdk-core` **does not carry chain 4663 in its address maps** (the chain postdates the
published SDK), so every address must come from config, not from an SDK lookup
([robinhood-toolkit dex/DEPLOYMENTS.md, verified on-chain 2026-07-21](https://github.com/nirholas/robinhood-toolkit/blob/main/dex/DEPLOYMENTS.md)).
Second, Uniswap's own deployments index tags some chains as "DAO-deployed… not deployed or maintained by Uniswap Labs";
the rows around Robinhood Chain in that table are dense and I would **re-read each address on Blockscout before mainnet
use** — Uniswap's own v3 page says exactly this ("Integrators should no longer assume that they are deployed to the same
addresses across chains and be extremely careful to confirm mappings").

### 3.2 Trading API supports 4663 — with one stale mirror to ignore

The Uniswap launch post instructs developers to "set the chain ID `4663` for Robinhood Chain" in the Trading API quickstart
([blog.uniswap.org, 2026-07-02](https://blog.uniswap.org/robinhood-chain-is-live)), and the current
`POST https://trade-api.gateway.uniswap.org/v1/quote` schema lists `4663` in the allowed `tokenInChainId` /
`tokenOutChainId` enum.

**Conflict, resolved:** a third-party OpenAPI mirror on apis.io publishes a `ChainId` enum that omits `4663`. That mirror
is a stale snapshot — it also omits several other chains present in the live schema. Do not use it as the compatibility
oracle; call `/v1/quote` against 4663 in a smoke test instead.

**A fee trap to close explicitly.** The Trading API docs state that a service fee can be **attached to the API key** by
Uniswap Labs and is "always taken from the output token", surfacing as `portionBips` / `portionAmount`; separately,
`integratorFees` accepts `bips` up to 500 and, when provided, "is applied to the swap **instead of** the default partner
fee service." The plan's locked decision is *zero* Stonkz fee on hop 1 and hop 3 (plan lines around "Stonkz charges 0 on
hop 1", plan step 84). So: **never populate `integratorFees`, and assert on every quote response that `portionBips` is
absent or 0**, failing the quote loudly if it is not. Otherwise Stonkz would silently take an aggregator-hop fee it has
promised not to take — exactly the item on the "must never ship" list.

### 3.3 Atomicity: yes, but it needs a Stonkz periphery router

The plan (step 83) says: "RH: Uniswap Universal Router (or Trading API calldata) + curve contract in one wallet tx." That
is achievable, but **not** by handing the user the Trading API's calldata. That calldata targets the Universal Router with
the user's EOA as `swapper`, and it ends with the base token in the user's wallet — a second, separate transaction would
then be needed for the curve hop, which is precisely the "user stuck holding the base mint" failure the plan forbids.

The workable construction, given the facts:

1. **Deploy a `StonkzRouter` periphery contract** on 4663. One entrypoint per side, e.g.
   `buyExactEthIn(bytes urCommands, bytes[] urInputs, address curve, uint256 minBaseOut, uint256 minTokenOut)`.
2. **Buy path.** User sends ETH with the call. `StonkzRouter` calls `UniversalRouter.execute{value: msg.value}(...)` with
   the swap's **recipient set to `StonkzRouter` itself** (the Universal Router's `ADDRESS_THIS` sentinel), asserts the base
   balance delta ≥ `minBaseOut`, approves the curve, calls `buy(amountBase, minTokenOut)`, and forwards the launched
   tokens to the user. Any revert on either leg reverts the whole transaction, which is the atomicity requirement.
3. **This is single-signature only because hop 1's input is native ETH.** No Permit2 approval is required to spend ETH, so
   the user signs exactly one transaction. That is a real advantage of the plan's "user always trades the native gas
   token" decision, and it should be stated in the router design doc.
4. **Sell path needs one extra piece.** Selling starts from the launched ERC-20, which `StonkzRouter` must be able to pull.
   Give the launched token **ERC-2612 `permit`** (we control the token contract) so the flow stays one signature plus one
   transaction, or route the pull through Permit2's `SignatureTransfer`. Then: pull token → curve `sell` → base →
   `UniversalRouter.execute` with recipient = the user → ETH out. Do not ship a sell path that needs a separate
   `approve` transaction and then a swap; that is two signatures and reintroduces the stuck-mid-flow state.
5. **Build the Universal Router calldata ourselves** with the universal-router encoding (v4/v3/v2 command mix), using the
   Trading API or `QuoterV2`/`V4Quoter` only for *pricing*. The Trading API's `/swap` response cannot express "recipient is
   a contract that then does something else," so it is a quoting dependency, not an execution dependency. This also keeps
   the 8-second quote refresh (plan step 82) independent of Uniswap's calldata service being up.
6. **Alternative considered and rejected as the default:** ERC-4337 is first-class on this chain and EIP-5792
   `wallet_sendCalls` could batch two calls atomically. But atomic batching is a *wallet capability*, and I found no
   statement that Robinhood Wallet exposes it. Keep it as a later optimisation behind a capability check, not as the Phase
   2.R mechanism.

**Route safety, which the plan does not currently mention.** A 2026-08-14 sweep of the chain's v4 pools found roughly
1,900 hookless pools with **88–100% LP fees, engineered specifically to fleece routers that probe arbitrary fee tiers**,
plus ~8,800 dynamic-fee hooked pools ([chain-facts](https://docs.investorscenter.finance/docs/reference/chain-facts)).
The router must therefore: pin the pool key (or the allowed protocol/fee-tier set) per base token in config, never widen
a tier probe to arbitrary tiers, and keep enforcing the strict `min_out` on hop 1 that the plan already requires. Uniswap's
Trading API exposes a `protocols` whitelist and `hooksOptions` for exactly this; use them.

### 3.4 Sequencer ordering changes the trade settings, not the route

Robinhood Chain orders transactions **strictly by arrival time at the sequencer**. Robinhood's docs are explicit: "Priority
gas auctions do not exist here; consequently, increasing your fee will not shift your transaction ahead of others already
in the queue" ([docs …/differences-from-ethereum](https://docs.robinhood.com/chain/differences-from-ethereum/)). There is
no public mempool ([getblock RH reference](https://docs.getblock.io/api-reference/robinhood)).

Consequences for plan step 85 (settings apply to the composed tx: "slippage, prio, MEV shield/relay/off, cap"):

- **Priority fee is a no-op for ordering on RH.** Keep the UI control (the plan wants pixel-identical chrome) but make it
  inert for `net=RH`, and never add it into the `SET.cap` pre-flight as if it bought speed.
- **MEV shield / private relay is also a no-op** — there is no public mempool to be sandwiched from and no PGA between
  sequencer receipt and inclusion. What remains is trust in a single centralized sequencer operated by Robinhood
  ([backpack learn](https://learn.backpack.exchange/articles/what-is-robinhood-chain)). Do not present "MEV SHIELD ON" to
  an RH user as though it were doing something.
- **This is a config flag, not an invariant.** ArbOS 61 shipped an opt-in mechanism for an Arbitrum chain to collect tips
  as priority fees, requiring the chain owner to enable tip collection *and* update the sequencer's sorting logic
  ([ArbOS 61 Elara](https://docs.arbitrum.io/run-arbitrum-node/arbos-releases/arbos61)). Robinhood has not enabled it. So
  gate the behaviour on `RH_PRIORITY_FEE_ORDERING=false` rather than deleting the code path.
- **Gas estimation must not be hardcoded.** Fees have an L2 execution component plus an L1 calldata component, and
  `gasleft()` and estimation behave differently than on Ethereum. Use `NodeInterface` (`0xC8`) `gasEstimateComponents`
  and `ArbGasInfo` (`0x6C`) with a buffer, because a composed two-hop transaction is calldata-heavy and the L1 component
  can spike independently of L2 congestion.

---

## 4. Graduation and the LP-burn mechanic (plan step 77, plan step 162–163)

This is the section where the plan's wording does not survive the facts. Read it before writing the graduation path.

### 4.1 Both LP forms are available, so this is our choice, not the chain's

Because Uniswap **v2, v3 and v4 are all deployed** on 4663 (§3.1), we can graduate into either shape:

- **v2**: the pool *is* an ERC-20 (`UniswapV2Pair`). LP is **fungible**, and "burn the LP" is literally possible — send the
  LP tokens to a dead address and the liquidity is permanently unwithdrawable, verifiable by anyone with the explorer.
- **v3 / v4**: a position is an **ERC-721 NFT** (v3 `NonfungiblePositionManager` `0x73991a…DE0D3`, v4 `PositionManager`
  `0x58daEC…04fA7`). Concentrated by design; a full-range position emulates v2.

### 4.2 The contradiction: "burn the LP **and** keep fee-claim authority" cannot be done on v2

The plan's locked decision for `$STONKZ` POL says "**Lock and burn LP tokens for life. Keep the fee-claim authority**"
(plan §Locked decisions, and step 162: "lock and burn LP NFT/tokens; retain fee-collect authority"). Those two clauses are
compatible on v3/v4 and **mutually exclusive on v2**:

- **v2 has no separate fee claim.** Swap fees stay inside the pool's reserves and accrue to LP-token holders pro rata.
  There is no `collect()`. The only way to realise v2 fees is to burn LP tokens and withdraw a proportional slice of
  reserves. So burning the LP tokens forfeits every past and future fee at the same moment it locks the principal — the
  fee claim *is* the principal claim.
- **v3/v4 separate the two.** Fees accrue to the position independently of principal and are claimed by the position's
  owner or an approved operator (`collect` on v3; a zero-liquidity-delta `modifyLiquidity` + take on v4). Principal is
  withdrawn by a different call (`decreaseLiquidity`).
- **But "burning the NFT" is also wrong on v3/v4.** Sending the position NFT to `0xdead` destroys the fee claim too, since
  only the owner or an approved operator can collect. (On v3 you cannot even call `NonfungiblePositionManager.burn` while
  the position still holds liquidity.) A burned NFT is a burned fee stream.

**The only construction that satisfies both halves of the plan is an immutable locker contract**, not a burn:

> `StonkzLpLock` owns the position NFT. It exposes exactly one external mutation — collect fees to a pre-wired,
> immutable destination — and contains **no** code path that calls `decreaseLiquidity`, transfers the NFT, or changes the
> destination. Principal is unwithdrawable because no function exists to withdraw it; the fee claim survives because the
> contract is still the owner. No admin, no upgrade proxy, no owner variable.

This is exactly what the chain's existing precedents do, which is a useful signal that it is the accepted pattern here:

- **pools.trade** (Uniswap Labs' own launchpad on this chain, live 2026-08-05) puts every launch's liquidity in a
  "protocol-held pool that cannot be removed by the creator", with the 0.25% LP fee **autocompounding back into the locked
  position** ([blog.uniswap.org](https://blog.uniswap.org/pools-trade-a-new-way-to-launch-on-robinhood-chain)).
- **StonkBrokers** on 4663 ships separate V3 and V4 liquidity lockers, each issuing a transferable ownership NFT whose
  holder "collects the position's swap fees" ([stonkbrokers docs](https://www.stonkbrokers.cash/docs)). Note their design
  caveat, worth verifying before copying: they state **v4 position NFTs cannot be escrowed as-is**, so their V4 locker
  *mints* a native-ETH v4 position directly into the canonical PoolManager rather than accepting a transferred one. If that
  holds, `StonkzLpLock` must mint the v4 position itself, not receive it.

### 4.3 Recommended split: burn for memecoin graduation, lock for `$STONKZ` POL

The two mechanics in the plan have different requirements, and should therefore use different pool types.

**Memecoin graduation at $69K (plan step 77) → Uniswap v2 pool, LP tokens burned.**
Nobody is promised those LP fees: the plan states that after graduation "curve fee stops; remaining venue fees are the
DEX's." Given that, v2 is strictly better here:

- It is the only variant where "liquidity is burned" is *verifiable by a user with a block explorer* and requires trusting
  no Stonkz contract at all. That is a real product asset for a launchpad.
- **Burned v2 LP autocompounds for free.** Fees accrue into reserves, and because the LP tokens no longer exist they can
  never be withdrawn — so the pool's floor thickens permanently with no locker, no searcher incentive, and no keeper. It
  achieves pools.trade's autocompounding property by construction rather than by mechanism design.
- No tick math, no position NFT custody, no upgrade surface in the graduation path — which matters because graduation is
  a one-way, irreversible migration of real user funds.

**`$STONKZ` protocol-owned liquidity (plan step 162–163) → Uniswap v3 or v4 position in `StonkzLpLock`.**
Fee retention is a hard requirement here (POL fees fund the `$STONKZ` staker pool), so v2 is not an option. Prefer **v4
with native ETH** (`currency0 = address(0)`) if the pair is ETH-denominated, since v4 pools can hold native ETH and skip
WETH wrapping entirely; otherwise v3, whose locker semantics are the simplest and best-documented. Put the choice behind
`STONKZ_POL_VERSION={v3|v4}` because plan Phase 7 is far enough out that Uniswap's v4 periphery may have moved.

Either way, **update the plan's copy**. "Lock and burn LP tokens for life. Keep the fee-claim authority" should read, for
the POL: "*Deposit the LP position into an immutable locker with no withdrawal path; retain only the fee-collect call.*"
And the graduation copy should not promise fee claims on graduated memecoin pools.

### 4.4 Graduation-time hazards specific to this chain

1. **Pin the pool key; never probe fee tiers.** ~1,900 hookless v4 pools on this chain carry 88–100% LP fees and exist
   solely to catch routers that try arbitrary tiers ([chain-facts, sweep 2026-08-14](https://docs.investorscenter.finance/docs/reference/chain-facts)).
   Graduation must create the pool at a single hard-coded fee tier with no hook (or a hook we deployed), and record the
   exact pool key/address in the `tokens` row so the indexer and router never rediscover it by search.
2. **A sniper can initialize the canonical pool before you.** A v3/v4 pool key is deterministic from
   `(currency0, currency1, fee, tickSpacing, hooks)`, so anyone can create and seed it at a manipulated price ahead of the
   graduation transaction. The graduation function must read the pool's current price and **revert unless the pool is
   uninitialized or already at the expected curve-exit price within a tight band**, rather than adding liquidity into
   whatever price it finds.
3. **The oracle heartbeat is 24 hours, not minutes.** The ETH/USD feed on 4663 (`0x78F3556b…d3A9`) has
   `heartbeat: 86400` and 8 decimals (Chainlink's canonical directory, fetched 2026-09-06). A conventional
   `require(block.timestamp - updatedAt < 3600)` staleness guard would make graduation permanently unreachable. Use a
   heartbeat-aware bound (86400 plus a grace window) and accept that the $69K threshold is therefore fuzzy at the margin —
   document that, rather than pretending it is exact.
4. **There is no L2 Sequencer Uptime Feed for this chain** (row 42). Chainlink's documented L2 best practice — gate
   `latestRoundData()` on the uptime feed — is *not available* here. Compensate with: the heartbeat-aware staleness bound,
   a sanity band on `answer`, `answeredInRound` checks, and an admin pause on graduation specifically (plan step 79
   already asks for "oracle staleness on graduation"; this is the concrete shape of it).
5. **Equity-based bases go stale by design at the weekend.** Chainlink's Robinhood equity/ETF feeds "update 24/5 following
   market hours", while crypto feeds are 24/7 ([docs …/oracles-and-price-feeds](https://docs.robinhood.com/chain/oracles-and-price-feeds/);
   [chain-facts](https://docs.investorscenter.finance/docs/reference/chain-facts)). A coin paired against `AAPL` therefore
   has no fresh USD price on a Saturday. So: **denominate the $69K check through ETH/USD**, and if a stock-token base must
   be valued, additionally require the token's own `oraclePaused() == false`.
6. **Graduation must never be able to block a trade.** Because of points 3–5, the graduation check will sometimes be
   unresolvable. If the oracle is stale, paused, or out of band, the buy/sell must still succeed and graduation simply does
   not trigger on that fill. A design where a stale oracle reverts trades turns a Chainlink hiccup into a chain-wide
   outage of the launchpad.
7. **Use `block.timestamp`, never `block.number`, for every deadline.** See §5.1 — this applies to the cashback window,
   stake locks, and quote expiry as much as to graduation.

---

## 5. EVM behaviour that changes the launchpad contract (plan step 72, 74, 79)

### 5.1 `block.number` is the **L1** block number — and sources disagree, so here is the evidence

Robinhood's own documentation is unambiguous: "`block.number` returns an estimate of the L1 (Ethereum) block number, not
the Robinhood Chain block number, and updates only periodically. Do not use it to measure L2 time precisely or as a
per-block counter" ([docs …/differences-from-ethereum](https://docs.robinhood.com/chain/differences-from-ethereum/)).

**Conflict, flagged:** a third-party protocol-security write-up asserts the opposite — that on Arbitrum `block.number`
returns the *L2* block number advancing every ~250 ms
([chainscorelabs](https://chainscorelabs.com/protocol/arbitrum/incidents-and-security-advisories/defi-exploits-with-protocol-level-root-causes)),
and it contradicts itself between two of its own pages. I weight the primary documentation plus an independent measurement
over it: a researcher compared an Orbit chain's `block.number` against its parent chain's `eth_blockNumber` seconds apart
and found the same clock, different chain
([agentatwork](https://agentatwork.xyz/notes/chainclock.html)). Treat `block.number == L1 height` as the working truth, and
note that **either way the safe action is identical**: do not use `block.number` for time.

Concretely for `programs/evm`:

- Cashback window (`CB_MS = 300000`, plan step 126: `fee = base + (5000 − base) × remaining/300` bps) must be computed from
  `block.timestamp`. On `block.number` the 5-minute window would be denominated in L1 blocks and last hours.
- Stake locks `{0,1,7,30,90,180,365}` days (plan step 131) — `block.timestamp`.
- Quote/tx deadlines — `block.timestamp`.
- If the indexer or any contract needs the chain's own height, read `ArbSys(0x0000000000000000000000000000000000000064).arbBlockNumber()`.
- **Do not ship an OpenZeppelin `Governor`/`ERC20Votes` with its default `block.number` clock** if governance ever lands;
  use ERC-6372 timestamp mode ([chain-facts](https://docs.investorscenter.finance/docs/reference/chain-facts) makes this
  point directly for Orbit).

A useful nuance: self-consistent uses of `block.number` (write `block.number + N`, later compare against `block.number`)
are not *broken*, just denominated in the wrong clock. It becomes a bug the moment a block height crosses a boundary — into
the API, the indexer, or a comparison against `eth_blockNumber`. The indexer's EVM replay cursor (plan step 45, "two replay
cursors: Solana slot + EVM block") must therefore be keyed on the **L2** height from `eth_blockNumber`/`arbBlockNumber`,
and must never be compared with a `block.number` value emitted from a contract.

### 5.2 Other EVM-level notes

- **Nothing about the launchpad needs rewriting for EVM-equivalence.** Solidity deploys unmodified, PUSH0 is supported, the
  24 KB contract size limit is the same as Ethereum, and CREATE2's deterministic deployer, Multicall3, Permit2 and Safe
  v1.4.1 are all present at canonical addresses ([xroot.dev](https://xroot.dev/blog/robinhood-chain-read-directly),
  on-chain 2026-08-25). The plan's "EVM mirror with the same interface" (step 72) is a normal Solidity port.
- **ERC-4337 is first-class**, with gas sponsorship, batching and session keys available through Alchemy
  ([docs.robinhood.com/chain](https://docs.robinhood.com/chain/)). This is an opportunity, not a requirement: a later
  gasless-first-trade flow is feasible. It also means smart-contract accounts will show up as users — see §6.3 for the SIWE
  consequence.
- **Legacy vs EIP-1559 transaction type**: one third-party guide recommends legacy (type 0) on Arbitrum-family chains,
  while the chain's RPC exposes `eth_maxPriorityFeePerGas` and `eth_feeHistory`. I could not confirm a Robinhood
  recommendation either way. Low-stakes, but leave the transaction type to viem's default and do not hand-roll it.
- **Two-component gas** (§3.4) means the composed router transaction's cost is dominated by calldata. Keep Universal
  Router command encoding tight; the plan's `SET.cap` pre-flight abort (step 85) should use a live
  `gasEstimateComponents` figure, not a constant.
