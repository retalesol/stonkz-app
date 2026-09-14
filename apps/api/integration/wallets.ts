/**
 * Real signers for the integration harness.
 *
 * These are genuine keypairs holding genuine (testnet) funds, loaded from the
 * environment. That is appropriate for a harness and **never** appropriate for
 * the app: `apps/web` must sign through a user's wallet, not a key it holds.
 * See `docs/real-vs-simulated.md` §1.
 *
 * Nothing here logs a secret key, and nothing writes one to disk.
 */
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Config } from './config.js';

/* ------------------------------------------------------------------ Solana */

export interface SolSigner {
  address: string;
  connection: Connection;
  /** SIWS: ed25519 over the raw UTF-8 message, signature base58-encoded. */
  signMessage: (message: string) => string;
  /** Sign whatever `/trade/prepare` returned, broadcast it, wait for confirmation. */
  signAndSend: (base64Tx: string) => Promise<string>;
  /** SOL balance, so a scenario can fail with "fund this wallet" rather than a revert. */
  balanceNative: () => Promise<number>;
  /** Native transfer, for the tip-verification scenario. */
  transferTo: (recipient: string, amountNative: number) => Promise<string>;
}

export function solSigner(cfg: Config, which: 'primary' | 'secondary' = 'primary'): SolSigner {
  const secret = which === 'primary' ? cfg.solSecretKey : cfg.solSecretKeyB;
  if (!secret) throw new Error(`no Solana secret key configured for ${which}`);
  if (!cfg.solRpcUrl) throw new Error('no Solana RPC configured');

  const keypair = Keypair.fromSecretKey(bs58.decode(secret));
  const connection = new Connection(cfg.solRpcUrl, 'confirmed');

  return {
    address: keypair.publicKey.toBase58(),
    connection,
    signMessage: (message) =>
      bs58.encode(ed25519.sign(new TextEncoder().encode(message), keypair.secretKey.slice(0, 32))),
    signAndSend: async (base64Tx) => {
      const raw = Buffer.from(base64Tx, 'base64');

      // The API composes either shape depending on the route, so accept both
      // rather than guessing and failing with an opaque deserialize error.
      let signature: string;
      try {
        const vtx = VersionedTransaction.deserialize(raw);
        vtx.sign([keypair]);
        signature = await connection.sendRawTransaction(vtx.serialize());
      } catch {
        const tx = Transaction.from(raw);
        tx.partialSign(keypair);
        signature = await connection.sendRawTransaction(tx.serialize());
      }

      // `confirmed` rather than `processed`: a processed-only trade can still
      // be dropped, and the whole point here is to prove settlement.
      const latest = await connection.getLatestBlockhash();
      const confirmation = await connection.confirmTransaction(
        { signature, ...latest },
        'confirmed',
      );
      if (confirmation.value.err) {
        throw new Error(`transaction ${signature} failed on chain: ${JSON.stringify(confirmation.value.err)}`);
      }
      return signature;
    },
    balanceNative: async () => (await connection.getBalance(keypair.publicKey)) / LAMPORTS_PER_SOL,
    transferTo: async (recipient, amountNative) => {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: new PublicKey(recipient),
          lamports: Math.round(amountNative * LAMPORTS_PER_SOL),
        }),
      );
      const signature = await connection.sendTransaction(tx, [keypair]);
      const latest = await connection.getLatestBlockhash();
      const confirmation = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
      if (confirmation.value.err) {
        throw new Error(`transfer ${signature} failed: ${JSON.stringify(confirmation.value.err)}`);
      }
      return signature;
    },
  };
}

/* --------------------------------------------------------------- Robinhood */

/**
 * Chain 4663. Defined locally rather than imported: viem's chain registry does
 * not carry Robinhood Chain, and `docs/robinhood-chain.md` is the source of
 * truth for these values.
 */
export function rhChain(rpcUrl: string, chainId = 4663) {
  return defineChain({
    id: chainId,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export interface RhSigner {
  address: `0x${string}`;
  publicClient: PublicClient;
  walletClient: WalletClient;
  /** SIWE: EIP-191 personal_sign. */
  signMessage: (message: string) => Promise<Hex>;
  /** EIP-712, for the ERC-2612 permit on a first-time sell. */
  signTypedData: (typedData: unknown) => Promise<Hex>;
  /** Send a prepared call and wait for the receipt; throws on a reverted tx. */
  sendAndWait: (call: { to: `0x${string}`; data: Hex; value?: string | bigint | undefined }) => Promise<Hex>;
}

export async function rhSigner(cfg: Config): Promise<RhSigner> {
  if (!cfg.rhPrivateKey) throw new Error('no RH private key configured');
  if (!cfg.rhRpcUrl) throw new Error('no RH RPC configured');

  const account = privateKeyToAccount(cfg.rhPrivateKey as Hex);
  const publicClient = createPublicClient({ transport: http(cfg.rhRpcUrl) });

  // Read the chain id rather than assuming 4663: pointing the harness at a
  // testnet RPC and silently signing for mainnet is a mistake worth catching.
  const chainId = await publicClient.getChainId();
  const chain = rhChain(cfg.rhRpcUrl, chainId);
  const walletClient = createWalletClient({ account, chain, transport: http(cfg.rhRpcUrl) });

  return {
    address: account.address,
    publicClient,
    walletClient,
    signMessage: (message) => account.signMessage({ message }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signTypedData: (typedData) => account.signTypedData(typedData as any),
    sendAndWait: async (call) => {
      const hash = await walletClient.sendTransaction({
        account,
        chain,
        to: call.to,
        data: call.data,
        value: call.value === undefined ? undefined : BigInt(call.value),
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        throw new Error(`transaction ${hash} reverted on chain`);
      }
      return hash;
    },
  };
}

/** Base Sepolia / Base mainnet — same EIP-1559 wallet shape as RH. */
export async function baseSigner(cfg: Config): Promise<RhSigner> {
  if (!cfg.basePrivateKey) throw new Error('no Base private key configured');
  if (!cfg.baseRpcUrl) throw new Error('no Base RPC configured');

  const account = privateKeyToAccount(cfg.basePrivateKey as Hex);
  const publicClient = createPublicClient({ transport: http(cfg.baseRpcUrl) });
  const chainId = await publicClient.getChainId();
  const chain = defineChain({
    id: chainId,
    name: chainId === 8453 ? 'Base' : 'Base Sepolia',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [cfg.baseRpcUrl] } },
  });
  const walletClient = createWalletClient({ account, chain, transport: http(cfg.baseRpcUrl) });

  return {
    address: account.address,
    publicClient,
    walletClient,
    signMessage: (message) => account.signMessage({ message }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signTypedData: (typedData) => account.signTypedData(typedData as any),
    sendAndWait: async (call) => {
      const hash = await walletClient.sendTransaction({
        account,
        chain,
        to: call.to,
        data: call.data,
        value: call.value === undefined ? undefined : BigInt(call.value),
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        throw new Error(`transaction ${hash} reverted on chain`);
      }
      return hash;
    },
  };
}

/* -------------------------------------------------------------------- auth */

export interface Session {
  wallet: string;
  accessToken: string;
}

/**
 * Full SIWS/SIWE handshake against the real API. The message is always the one
 * the server composed — the client never builds it, which is what makes the
 * nonce single-use binding meaningful.
 */
export async function login(
  cfg: Config,
  net: 'SOL' | 'RH' | 'BASE',
  address: string,
  sign: (message: string) => string | Promise<string>,
): Promise<Session> {
  const nonceRes = await fetch(`${cfg.apiBaseUrl}/auth/nonce?net=${net}&address=${encodeURIComponent(address)}`);
  if (!nonceRes.ok) throw new Error(`GET /auth/nonce -> ${nonceRes.status}`);
  const challenge = (await nonceRes.json()) as { message: string };

  const signature = await sign(challenge.message);
  const route = net === 'SOL' ? '/auth/siws' : '/auth/siwe';
  const loginRes = await fetch(`${cfg.apiBaseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, message: challenge.message, signature }),
  });
  if (!loginRes.ok) {
    throw new Error(`POST ${route} -> ${loginRes.status}: ${(await loginRes.text()).slice(0, 300)}`);
  }
  const session = (await loginRes.json()) as { wallet: string; accessToken: string };
  return { wallet: session.wallet, accessToken: session.accessToken };
}
