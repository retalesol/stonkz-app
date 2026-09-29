//! Hand-built Metaplex Token Metadata `CreateMetadataAccountV3` CPI.
//!
//! Built here with plain Borsh bytes rather than through `mpl-token-metadata`
//! (or anchor-spl's `metadata` feature, which pulls it in): the launchpad
//! needs exactly one instruction with every optional field empty, and the
//! wire format below is small enough to pin byte-for-byte in `tests.rs`.
//! Same rationale as the hand-built Meteora CPIs in `graduate.rs`.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};

use crate::constants::*;

/// The metadata PDA Metaplex expects for `mint`:
/// `["metadata", TOKEN_METADATA_PROGRAM_ID, mint]` under the Metaplex program.
pub fn metadata_pda(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            SEED_METADATA,
            TOKEN_METADATA_PROGRAM_ID.as_ref(),
            mint.as_ref(),
        ],
        &TOKEN_METADATA_PROGRAM_ID,
    )
}

fn put_str(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

/// Borsh body of `CreateMetadataAccountV3`:
///
/// ```text
/// u8   33                                  instruction tag
/// DataV2 {
///   String name, String symbol, String uri,
///   u16    seller_fee_basis_points = 0,
///   Option<Vec<Creator>> creators  = None,
///   Option<Collection>   collection = None,
///   Option<Uses>         uses       = None,
/// }
/// bool is_mutable = false
/// Option<CollectionDetails> collection_details = None
/// ```
///
/// `is_mutable = false` plus an update authority no wallet controls (the
/// curve PDA, which has no instruction that signs a metadata update) means
/// the name, symbol and URI are frozen the moment the coin launches.
pub fn create_metadata_v3_data(name: &str, symbol: &str, uri: &str) -> Vec<u8> {
    let mut d = Vec::with_capacity(1 + 12 + name.len() + symbol.len() + uri.len() + 2 + 5);
    d.push(METAPLEX_CREATE_METADATA_V3_IX);
    put_str(&mut d, name);
    put_str(&mut d, symbol);
    put_str(&mut d, uri);
    d.extend_from_slice(&0u16.to_le_bytes()); // seller_fee_basis_points
    d.push(0); // creators: None
    d.push(0); // collection: None
    d.push(0); // uses: None
    d.push(0); // is_mutable: false
    d.push(0); // collection_details: None
    d
}

/// The full instruction. Account order is Metaplex's:
/// metadata (w), mint, mint_authority (s), payer (w, s), update_authority (s),
/// system_program. The optional trailing rent sysvar is omitted — Metaplex
/// has not read it since the V3 instruction was introduced.
#[allow(clippy::too_many_arguments)]
pub fn create_metadata_v3_ix(
    metadata: Pubkey,
    mint: Pubkey,
    mint_authority: Pubkey,
    payer: Pubkey,
    update_authority: Pubkey,
    name: &str,
    symbol: &str,
    uri: &str,
) -> Instruction {
    Instruction {
        program_id: TOKEN_METADATA_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(metadata, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(mint_authority, true),
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(update_authority, true),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
        ],
        data: create_metadata_v3_data(name, symbol, uri),
    }
}
