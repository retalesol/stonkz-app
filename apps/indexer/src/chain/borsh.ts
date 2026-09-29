/**
 * Moved to `@stonkz/api/chain/events/borsh` so the API's `/trade/confirm`
 * fast path decodes Solana events with the exact reader the indexer uses (the
 * API image does not ship `apps/indexer`). Re-exported so indexer imports keep
 * working unchanged.
 */
export * from '@stonkz/api/chain/events/borsh';
