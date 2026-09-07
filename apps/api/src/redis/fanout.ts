import type { RedisHandler } from './types.js';

export type HandlerErrorSink = (err: unknown, channel: string) => void;

/**
 * Deliver one message to a set of subscribers, isolating each one.
 *
 * Both `RedisLike` implementations need this and for the same reason: the WS
 * hub subscribes and writes straight to client sockets, and a socket that
 * closed between the readiness check and the write throws synchronously. In a
 * bare `for` loop that throw would skip every remaining subscriber, and on the
 * ioredis path it would escape into an event-emitter callback — an unhandled
 * exception that takes the process down. One wedged client must not be able to
 * silence the board for everyone else.
 *
 * Returns the number of handlers invoked, matching Redis's PUBLISH reply,
 * which counts receivers rather than successes.
 */
export function fanout(
  handlers: Iterable<RedisHandler>,
  message: string,
  channel: string,
  onError?: HandlerErrorSink,
): number {
  let delivered = 0;
  for (const handler of handlers) {
    delivered++;
    try {
      handler(message, channel);
    } catch (err) {
      onError?.(err, channel);
    }
  }
  return delivered;
}
