/**
 * Moved to `@stonkz/api/chain/events/anchor` so the API's `/trade/confirm`
 * fast path attributes `Program data:` lines to the launchpad with the exact
 * invoke-stack walk the indexer uses (the API image does not ship
 * `apps/indexer`). Re-exported so indexer imports keep working unchanged.
 */
export * from '@stonkz/api/chain/events/anchor';
