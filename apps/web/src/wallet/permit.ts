import { createPublicClient, http, type PublicClient } from 'viem';
import { BASE_RPC_URL, RH_RPC_URL } from './chain.js';
import { WalletError, mapWalletError } from './errors.js';
import { baseChain, robinhoodChain } from './evm.js';
import type { ConnectedWallet } from './types.js';

/**
 * The `StonkzRouter` sell permit — EIP-2612, signed off-chain.
 *
 * `POST /trade/prepare` returns ready-to-sign typed data for a first-time
 * Robinhood sell (`docs/rh-trade-atomicity-gap.md` §5), but deliberately
 * leaves one field for the client: `message.nonce` comes back **null**, with
 * a note saying to read `nonces(owner)` off the token contract immediately
 * before signing rather than trust a value that could already be stale.
 *
 * That read is this module's job, and it is the reason a real permit could
 * not exist before this phase: there was no wallet to sign with and no chain
 * client to read the nonce from. `live.ts` used to substitute a zero-filled
 * placeholder (`fakeSellPermit()`), which the router would have rejected.
 *
 * Two further fixes applied to the server's payload before it reaches a
 * wallet, both required by `eth_signTypedData_v4` and neither the API's job:
 * the `EIP712Domain` type entry has to be present, and the API's own `note`
 * field has to be stripped (wallets reject typed data with members that are
 * not in `types`).
 */

/** `PermitData` in `StonkzRouter.sol`, as `POST /trade/prepare` accepts it. */
export interface SellPermit {
  value: string;
  deadline: number;
  v: number;
  r: string;
  s: string;
}

export interface ServerPermitTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: { owner: string; spender: string; value: string; nonce: unknown; deadline: number };
}

const EIP712_DOMAIN = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

const NONCES_ABI = [
  {
    type: 'function',
    name: 'nonces',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const clients: Partial<Record<'RH' | 'BASE', PublicClient>> = {};
function rpc(chainId: number): PublicClient {
  const net = chainId === 8453 || chainId === 84532 ? 'BASE' : 'RH';
  const existing = clients[net];
  if (existing) return existing;
  const client = createPublicClient({
    chain: net === 'BASE' ? baseChain : robinhoodChain,
    transport: http(net === 'BASE' ? BASE_RPC_URL : RH_RPC_URL),
  });
  clients[net] = client;
  return client;
}

export function assertPermitShape(raw: unknown): ServerPermitTypedData {
  const td = raw as Partial<ServerPermitTypedData> | null;
  const ok =
    td !== null &&
    typeof td === 'object' &&
    typeof td.primaryType === 'string' &&
    typeof td.domain?.verifyingContract === 'string' &&
    typeof td.message?.owner === 'string' &&
    typeof td.message?.value === 'string' &&
    typeof td.message?.deadline === 'number' &&
    !!td.types?.[td.primaryType];
  if (!ok) {
    throw new WalletError('unknown', 'The API returned permit data this build does not recognise.');
  }
  return td as ServerPermitTypedData;
}

/** `nonces(owner)` on the token, read now rather than trusted from the response. */
export async function readPermitNonce(token: string, owner: string, chainId = 0): Promise<bigint> {
  try {
    return await rpc(chainId).readContract({
      address: token as `0x${string}`,
      abi: NONCES_ABI,
      functionName: 'nonces',
      args: [owner as `0x${string}`],
    });
  } catch (err) {
    throw mapWalletError(err, 'Could not read the token\u2019s permit nonce from chain.');
  }
}

/**
 * The payload `eth_signTypedData_v4` actually accepts, from the API's
 * response plus the freshly-read nonce.
 *
 * Two corrections the API cannot make for us: `EIP712Domain` has to be
 * present in `types` (wallets reject typed data without it, even though the
 * domain fields are given), and the API's `note` sibling is dropped by only
 * copying the four members that belong in a typed-data payload — a wallet
 * rejects a payload carrying members that are not in `types`.
 */
export function buildPermitPayload(
  td: ServerPermitTypedData,
  nonce: bigint,
): {
  domain: unknown;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
} {
  return {
    domain: td.domain,
    types: { EIP712Domain: EIP712_DOMAIN, ...td.types },
    primaryType: td.primaryType,
    message: { ...td.message, nonce: nonce.toString() },
  };
}

export function splitSignature(signature: string): { v: number; r: string; s: string } {
  const hex = signature.replace(/^0x/, '');
  if (hex.length !== 130 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new WalletError('unknown', 'The wallet returned a permit signature of the wrong length.');
  }
  let v = Number.parseInt(hex.slice(128, 130), 16);
  // Some wallets return 0/1 where the contract's `ecrecover` wants 27/28.
  if (v === 0 || v === 1) v += 27;
  if (v !== 27 && v !== 28) {
    throw new WalletError(
      'unknown',
      `The wallet returned an unusable permit recovery id (v=${v}).`,
    );
  }
  return { v, r: '0x' + hex.slice(0, 64), s: '0x' + hex.slice(64, 128) };
}

/** How the nonce is obtained. Overridden only by tests. */
export type PermitNonceReader = (token: string, owner: string, chainId?: number) => Promise<bigint>;

/**
 * Fill in the nonce, get the wallet to sign, and split the result into the
 * `PermitData` struct `POST /trade/prepare` wants echoed back.
 */
export async function signSellPermit(
  wallet: ConnectedWallet,
  rawTypedData: unknown,
  readNonce: PermitNonceReader = readPermitNonce,
): Promise<SellPermit> {
  if (!wallet.signTypedData) {
    throw new WalletError(
      'unsupported_method',
      `${wallet.label} cannot sign EIP-712 typed data, which a first-time EVM sell needs. ` +
        'Approve the router on this token manually, or use another wallet.',
    );
  }
  const td = assertPermitShape(rawTypedData);
  const owner = td.message.owner;
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new WalletError(
      'unknown',
      'The permit names a different owner than the connected wallet. Reconnect and try again.',
    );
  }
  // Read from the token named in the permit domain (EIP-2612 domains are the
  // token itself), now, not from the response — see the header.
  const nonce = await readNonce(td.domain.verifyingContract, owner, td.domain.chainId);
  const signature = await wallet.signTypedData(buildPermitPayload(td, nonce));
  const { v, r, s } = splitSignature(signature);
  return { value: td.message.value, deadline: td.message.deadline, v, r, s };
}
