import type { Net } from '@stonkz/shared';
import type { RedisLike } from '../redis/types.js';

/**
 * Operator → indexer hand-off over Redis.
 *
 * The API never touches the indexer's cursor or tables directly for a
 * reindex; it publishes a command on `indexer:control` and mirrors it under
 * `indexer:cmd:<id>` (24 h TTL) so a worker that was down when the message
 * fired can still pick it up from `KEYS indexer:cmd:*`. Consumption lives in
 * `apps/indexer` (see `docs/admin-panel.md` § Indexer commands); until a
 * worker subscribes, the command is durable but pending, and the panel says so.
 */
export const INDEXER_CONTROL_CHANNEL = 'indexer:control';
export const INDEXER_COMMAND_TTL_SECONDS = 86_400;

export type IndexerCommand =
  | { type: 'reindex_token'; net: Net; mint: string }
  | { type: 'reindex_range'; net: Net; from: number; to: number }
  | { type: 'retry_dead_letter'; net: Net; id: number; from: number; to: number }
  | { type: 'set_cursor'; net: Net; position: number };

export interface EnqueuedCommand {
  id: string;
  command: IndexerCommand;
  issuedBy: string;
  issuedAt: number;
  /** Subscribers that received the publish — 0 means no indexer was listening. */
  receivers: number;
}

export async function enqueueIndexerCommand(
  redis: RedisLike,
  command: IndexerCommand,
  issuedBy: string,
  nowMs: number,
  id: string,
): Promise<EnqueuedCommand> {
  const entry: EnqueuedCommand = { id, command, issuedBy, issuedAt: nowMs, receivers: 0 };
  const body = JSON.stringify(entry);
  await redis.set(`indexer:cmd:${id}`, body, { ttlSeconds: INDEXER_COMMAND_TTL_SECONDS });
  entry.receivers = await redis.publish(INDEXER_CONTROL_CHANNEL, body);
  return entry;
}

export async function pendingIndexerCommands(redis: RedisLike): Promise<EnqueuedCommand[]> {
  const keys = await redis.keys('indexer:cmd:*');
  const out: EnqueuedCommand[] = [];
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw) as EnqueuedCommand);
    } catch {
      // A malformed entry is dropped from the view, never thrown.
    }
  }
  return out.sort((a, b) => b.issuedAt - a.issuedAt);
}
