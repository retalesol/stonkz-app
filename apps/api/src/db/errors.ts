/** Postgres `unique_violation`. */
export const UNIQUE_VIOLATION = '23505';
/** Postgres `check_violation`. */
export const CHECK_VIOLATION = '23514';

/**
 * Drizzle wraps driver errors in a `Failed query:` Error and keeps the real one
 * on `cause`, so SQLSTATE has to be dug out. The ledger relies on this: a
 * duplicate `(wallet, tx_sig, reason)` is a normal replay, not a failure.
 */
export function sqlStateOf(err: unknown): string | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur !== null && typeof cur === 'object'; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

export function isUniqueViolation(err: unknown): boolean {
  return sqlStateOf(err) === UNIQUE_VIOLATION;
}

export function isCheckViolation(err: unknown): boolean {
  return sqlStateOf(err) === CHECK_VIOLATION;
}
