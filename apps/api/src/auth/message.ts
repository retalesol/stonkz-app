import type { EvmNet, Net } from '@stonkz/shared';

/**
 * One message builder for both chains.
 *
 * SIWS (Solana Wallet Standard `signIn`) and SIWE (EIP-4361) share a layout;
 * only the first line and the `Chain ID` line differ. Building both here means
 * the server can regenerate byte-for-byte what it expects the wallet to have
 * signed, which is what makes the address+net binding checkable rather than
 * merely asserted by the client.
 */
export interface SignInMessageParams {
  net: Net;
  domain: string;
  address: string;
  statement: string;
  uri: string;
  nonce: string;
  issuedAt: string;
  chainId: string;
}

export const SIWS_STATEMENT =
  'Sign in to Stonkz. This request will not trigger a blockchain transaction or cost any gas.';

/**
 * CAIP-2 chain id written into the SIWS/SIWE message.
 * Solana uses `solanaSiwsChainId` (e.g. `solana:devnet` / `solana:mainnet`)
 * so a staging signature cannot replay into production.
 */
export function chainLabel(
  net: Net,
  evmChainIds: Record<EvmNet, number>,
  solanaSiwsChainId = 'solana:mainnet',
): string {
  if (net === 'SOL') return solanaSiwsChainId;
  return String(evmChainIds[net]);
}

export function buildSignInMessage(p: SignInMessageParams): string {
  const chain = p.net === 'SOL' ? 'Solana' : 'Ethereum';
  return [
    `${p.domain} wants you to sign in with your ${chain} account:`,
    p.address,
    '',
    p.statement,
    '',
    `URI: ${p.uri}`,
    'Version: 1',
    `Chain ID: ${p.chainId}`,
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt}`,
  ].join('\n');
}

export interface ParsedSignInMessage {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  chainId: string;
  nonce: string;
  issuedAt: string;
}

/**
 * Parses a message the client claims to have signed. The caller must still
 * rebuild it with `buildSignInMessage` and compare — parsing alone would let a
 * client smuggle extra lines past the checks.
 */
export function parseSignInMessage(message: string): ParsedSignInMessage | null {
  const lines = message.split('\n');
  const header = lines[0] ?? '';
  const match = /^(.+) wants you to sign in with your (?:Solana|Ethereum) account:$/.exec(header);
  if (!match) return null;

  const field = (name: string): string | null => {
    const prefix = `${name}: `;
    const line = lines.find((l) => l.startsWith(prefix));
    return line ? line.slice(prefix.length) : null;
  };

  const address = lines[1];
  const statement = lines[3];
  const uri = field('URI');
  const chainId = field('Chain ID');
  const nonce = field('Nonce');
  const issuedAt = field('Issued At');
  if (!match[1] || !address || statement === undefined || !uri || !chainId || !nonce || !issuedAt) {
    return null;
  }
  return { domain: match[1], address, statement, uri, chainId, nonce, issuedAt };
}
