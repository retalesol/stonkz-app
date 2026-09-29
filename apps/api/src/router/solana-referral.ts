import {
  Ed25519Program,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  AnchorEventCoder,
  eventDiscriminator,
  programDataPayloads,
} from '../chain/events/anchor.js';
import type { BorshReader } from '../chain/events/borsh.js';
import { anchorDiscriminator, encodeU64 } from './solana-idl.js';

/**
 * `programs/solana/programs/launchpad/src/instructions/referral.rs` — the
 * PDAs, the `claim_referral` instruction with its Ed25519 companion, and the
 * `ReferralClaimed` event `/referrals/claim/confirm` reads back.
 */

export function referralPdas(programId: PublicKey, baseMint: PublicKey, recipient: PublicKey) {
  const [config] = PublicKey.findProgramAddressSync([Buffer.from('referral_config')], programId);
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from('referral_vault'), baseMint.toBuffer()],
    programId,
  );
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from('referral_authority')],
    programId,
  );
  const [claimState] = PublicKey.findProgramAddressSync(
    [Buffer.from('referral_claim'), baseMint.toBuffer(), recipient.toBuffer()],
    programId,
  );
  return { config, vault, authority, claimState };
}

function encodeI64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(n);
  return b;
}

export interface ClaimReferralIxInput {
  programId: PublicKey;
  baseMint: PublicKey;
  recipient: PublicKey;
  cumulativeAmount: bigint;
  deadline: bigint;
  /** The API's voucher key and its signature over the voucher message. */
  signer: PublicKey;
  message: Buffer;
  signature: Buffer;
}

/**
 * `[Ed25519Program verify, claim_referral]`, in that order: the program looks
 * back through the instructions sysvar for a verification of exactly the
 * voucher message by exactly `signer`, and pays into the recipient's ATA,
 * creating it if missing (rent paid by the recipient — the one being paid).
 */
export function buildClaimReferralInstructions(i: ClaimReferralIxInput): TransactionInstruction[] {
  const pdas = referralPdas(i.programId, i.baseMint, i.recipient);
  const verify = Ed25519Program.createInstructionWithPublicKey({
    publicKey: i.signer.toBytes(),
    message: i.message,
    signature: i.signature,
  });
  const data = Buffer.concat([
    anchorDiscriminator('claim_referral'),
    encodeU64(i.cumulativeAmount),
    encodeI64(i.deadline),
  ]);
  const ata = getAssociatedTokenAddressSync(i.baseMint, i.recipient, false, TOKEN_PROGRAM_ID);
  const keys = [
    { pubkey: pdas.config, isSigner: false, isWritable: true },
    { pubkey: i.baseMint, isSigner: false, isWritable: false },
    { pubkey: pdas.vault, isSigner: false, isWritable: true },
    { pubkey: pdas.authority, isSigner: false, isWritable: false },
    { pubkey: pdas.claimState, isSigner: false, isWritable: true },
    { pubkey: i.recipient, isSigner: true, isWritable: true },
    { pubkey: ata, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return [verify, new TransactionInstruction({ programId: i.programId, keys, data })];
}

export interface ReferralClaimedEvent {
  baseMint: string;
  vault: string;
  recipient: string;
  amount: bigint;
  cumulativeAmount: bigint;
  ts: bigint;
}

const CODER = new AnchorEventCoder<ReferralClaimedEvent>([
  {
    name: 'ReferralClaimed',
    read(r: BorshReader): ReferralClaimedEvent {
      return {
        baseMint: r.pubkey(),
        vault: r.pubkey(),
        recipient: r.pubkey(),
        amount: r.u64(),
        cumulativeAmount: r.u64(),
        ts: r.i64(),
      };
    },
  },
]);

/** Every `ReferralClaimed` the launchpad program logged in this transaction. */
export function decodeReferralClaimedLogs(
  logMessages: readonly string[],
  programId: string,
): ReferralClaimedEvent[] {
  const out: ReferralClaimedEvent[] = [];
  for (const payload of programDataPayloads(logMessages, programId)) {
    try {
      const ev = CODER.decode(payload);
      if (ev) out.push(ev.data);
    } catch {
      // a payload that only shares the discriminator prefix; not ours
    }
  }
  return out;
}

/** For tests and fixtures: a `Program data:` line carrying one `ReferralClaimed`. */
export function encodeReferralClaimedEvent(ev: ReferralClaimedEvent): string {
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(ev.amount);
  const cum = Buffer.alloc(8);
  cum.writeBigUInt64LE(ev.cumulativeAmount);
  const body = Buffer.concat([
    eventDiscriminator('ReferralClaimed'),
    new PublicKey(ev.baseMint).toBuffer(),
    new PublicKey(ev.vault).toBuffer(),
    new PublicKey(ev.recipient).toBuffer(),
    amount,
    cum,
    encodeI64(ev.ts),
  ]);
  return body.toString('base64');
}
