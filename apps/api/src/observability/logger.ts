export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export type LogSink = (line: string) => void;

/**
 * One JSON object per line. No dependency, no transport, no colours — the
 * platform's log shipper does that. `sink` is injectable so tests can assert on
 * emitted fields instead of scraping stdout.
 */
export function createLogger(
  level: LogLevel = 'info',
  base: LogFields = {},
  sink: LogSink = (line) => process.stdout.write(line + '\n'),
  now: () => number = Date.now,
): Logger {
  const threshold = ORDER[level];

  const emit = (lvl: Exclude<LogLevel, 'silent'>, msg: string, fields?: LogFields): void => {
    if (ORDER[lvl] < threshold) return;
    sink(JSON.stringify({ t: new Date(now()).toISOString(), level: lvl, msg, ...base, ...fields }));
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger(level, { ...base, ...fields }, sink, now),
  };
}

/** Never log a bearer token, a refresh token or a raw signature. */
export function redact(value: string | null | undefined, keep = 4): string {
  if (!value) return '';
  return value.length <= keep * 2 ? '*'.repeat(value.length) : `${value.slice(0, keep)}…${value.slice(-keep)}`;
}
