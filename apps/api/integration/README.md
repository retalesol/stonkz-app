# Funded-testnet integration harness

Scenarios that spend real (testnet) funds against deployed programs, to prove
the things a mock cannot. Phase F of the post-build forward plan.

**Not part of `pnpm test` and not run in CI.** Same posture as `loadtest/`: an
operator tool, run deliberately. It signs with real keypairs read from the
environment, takes minutes, and costs testnet funds.

## Why this exists separately from `e2e/live.spec.ts`

The Playwright live suite **mocks the write routes** (`/trade/prepare`,
`/launch/*`, `/fees/*`) because the app's practice wallets hold no balance. So
it proves the UI handles each response shape correctly, and proves nothing
about settlement. This harness covers the other half: prepare → sign →
broadcast → confirm → the indexer reflects it.

The two together are the Phase F bar. Neither alone is.

## Run

```bash
pnpm --filter @stonkz/api integration
pnpm --filter @stonkz/api integration -- --only robinhood
```

With no environment set, **every scenario skips** and the run exits 0 while
stating loudly that it proved nothing. That is deliberate: the harness can be
wired into a pipeline before a testnet exists without ever producing a false
green. A skipped scenario is not evidence for the launch-checklist item it
covers.

## Environment

| Variable                               | Needed for                                                  |
| -------------------------------------- | ----------------------------------------------------------- |
| `INTEGRATION_API_URL`                  | everything except the pure on-chain reads                   |
| `INTEGRATION_SOL_RPC_URL`              | all Solana scenarios                                        |
| `INTEGRATION_SOL_SECRET_KEY`           | base58 secret key of a **funded** devnet keypair            |
| `INTEGRATION_SOL_SECRET_KEY_B`         | a second funded keypair, for tip verification               |
| `INTEGRATION_SOL_LAUNCHPAD_PROGRAM_ID` | Solana graduation check                                     |
| `INTEGRATION_RH_RPC_URL`               | all Robinhood scenarios                                     |
| `INTEGRATION_RH_PRIVATE_KEY`           | `0x`-prefixed key of a **funded** RH testnet account        |
| `INTEGRATION_RH_LAUNCHPAD_ADDRESS`     | oracle staleness check                                      |
| `INTEGRATION_RH_ROUTER_ADDRESS`        | RH atomic trade check                                       |
| `INTEGRATION_RH_SMART_ACCOUNT`         | ERC-1271 login (owner must be `INTEGRATION_RH_PRIVATE_KEY`) |
| `INTEGRATION_BASE_RPC_URL`             | Base Sepolia scenarios                                      |
| `INTEGRATION_BASE_PRIVATE_KEY`         | funded Base Sepolia key (falls back to RH key)              |
| `INTEGRATION_BASE_LAUNCHPAD_ADDRESS`   | Base launchpad after `DeployBaseSepolia`                    |
| `INTEGRATION_BASE_ROUTER_ADDRESS`      | Base `StonkzRouter`                                         |

Tuning: `INTEGRATION_TRADE_AMOUNT` (default `0.01` native),
`INTEGRATION_INDEXER_TIMEOUT_MS` (default `90000`),
`INTEGRATION_RUN_GRADUATION=1` to enable scenarios that force a graduation.

**Use throwaway keys.** These are hot keys in a shell environment. Never point
this at a key that holds mainnet value, and never at a withdraw authority.

## What each scenario proves

| Scenario                                                   | Launch-checklist item                                                                                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `solana: buy then sell settles on chain`                   | Real broadcast, Solana; plus the indexer materialising a real event                                                                |
| `robinhood: atomic buy and sell in one signature each`     | `RH_ROUTER_ADDRESS` configured, and the atomicity claim — asserted by **nonce delta of exactly 1**, not by trusting `atomic: true` |
| `solana: graduated DLMM position is permanently locked`    | "Liquidity is burned forever", Solana (Meteora DLMM lock)                                                                          |
| `robinhood: graduated LP sits at the dead address`         | Same claim, RH                                                                                                                     |
| `robinhood: oracle staleness bound is heartbeat-scale`     | The 24h-heartbeat bug, asserted against the live deployment                                                                        |
| `robinhood: ERC-1271 smart account can sign in`            | Smart-account support on an ERC-4337-heavy chain                                                                                   |
| `solana: a wall tip is verified against the real transfer` | The server never trusts a client-claimed tip, including replay refusal                                                             |

Two design notes worth knowing before reading the code:

- The RH atomic check asserts the **transaction count moved by exactly one**.
  Trusting the API's own `atomic: true` flag would be circular; the nonce is
  the chain's own answer to "was that one transaction or three?"
- If a RH trade comes back on the non-atomic fallback, the scenario **fails**
  rather than proceeding. The fallback is a documented degraded mode and must
  not take real funds.

## What this harness still cannot do

- It cannot verify mainnet. It is a testnet tool by construction.
- The graduation checks are **read-only** against tokens the indexer already
  records as graduated. Graduating a token costs roughly $13.8k of base asset,
  so forcing one belongs in a dedicated, deliberately-funded run.
- It does not drive the browser. Wallet-extension and WalletConnect flows are
  Playwright's job, with injected mock providers.
