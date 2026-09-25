/**
 * The wallet layer's public surface.
 *
 * `app/`, `api/` and `modals/` import from here, never from the transport
 * modules directly, so swapping a transport (or adding one — an EIP-4337
 * smart-account path is the obvious next one, given
 * `docs/robinhood-chain.md` §6.3) does not reach into call sites.
 */

export {
  RH_CHAIN_ID,
  RH_EXPLORER_URL,
  RH_RPC_URL,
  SOLANA_CLUSTER,
  SOLANA_RPC_URL,
  chainLabel,
} from './chain.js';
export {
  WalletError,
  describeWalletError,
  isRejection,
  mapWalletError,
  walletErrorHeadline,
  walletErrorKind,
  type WalletErrorKind,
} from './errors.js';
export {
  activeWallet,
  availableWallets,
  connectWalletFor,
  disconnectActive,
  initWalletDiscovery,
  isPracticeSession,
  onActiveWalletChange,
  onAvailableWalletsChange,
  preferRealWallet,
  requireWallet,
  sortChoices,
  waitForWalletChoice,
  resolveWalletChoice,
  type ConnectOptions,
} from './manager.js';
export { clearLastWallet, loadLastWallet, rememberLastWallet } from './persist.js';
export { PRACTICE_WALLET_ID, practiceWalletChoice, practiceWalletEnabled } from './practice.js';
export { WALLETCONNECT_PROJECT_ID, walletConnectUnavailableReason } from './walletconnect.js';
export type {
  BroadcastResult,
  ConnectedWallet,
  SignPayload,
  WalletChoice,
  WalletKind,
} from './types.js';
