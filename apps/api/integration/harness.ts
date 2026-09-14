/**
 * Scenario runner for the funded-testnet integration harness.
 *
 * Deliberately not vitest: these scenarios spend real testnet funds, take
 * minutes, and must never be picked up by `pnpm test` or CI by accident. Same
 * posture as `loadtest/` — an operator tool, run on purpose.
 */
import { loadConfig, ENV_NAMES, type Config, type ConfigKey } from './config.js';

export interface Ctx {
  cfg: Config;
  /** Structured log that survives interleaving across async scenarios. */
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** Assert, with a message that names what was actually observed. */
  expect: (cond: boolean, what: string, detail?: unknown) => void;
}

export interface Scenario {
  name: string;
  /** What this proves, in the words the launch checklist uses. */
  proves: string;
  /** Config keys that must be non-null, or the scenario SKIPs. */
  requires: ConfigKey[];
  /** Extra gate, e.g. `cfg.runGraduation`. */
  enabled?: (cfg: Config) => boolean;
  run: (ctx: Ctx) => Promise<void>;
}

export class AssertionFailed extends Error {}
/** Soft skip from inside a scenario (e.g. no graduated token on the board). */
export class ScenarioSkip extends Error {}

type Status = 'pass' | 'fail' | 'skip';

interface Result {
  scenario: Scenario;
  status: Status;
  reason?: string;
  ms: number;
}

function missing(cfg: Config, keys: ConfigKey[]): ConfigKey[] {
  return keys.filter((k) => cfg[k] === null || cfg[k] === undefined);
}

export async function runScenarios(scenarios: Scenario[]): Promise<number> {
  const cfg = loadConfig();
  const results: Result[] = [];

  for (const scenario of scenarios) {
    const gaps = missing(cfg, scenario.requires);
    if (gaps.length > 0) {
      const names = gaps.map((k) => ENV_NAMES[k] ?? k).join(', ');
      results.push({ scenario, status: 'skip', reason: `unset: ${names}`, ms: 0 });
      continue;
    }
    if (scenario.enabled && !scenario.enabled(cfg)) {
      results.push({ scenario, status: 'skip', reason: 'disabled by config', ms: 0 });
      continue;
    }

    const started = Date.now();
    const prefix = `[${scenario.name}]`;
    const ctx: Ctx = {
      cfg,
      log: (msg, extra) => console.log(`${prefix} ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}`),
      expect: (cond, what, detail) => {
        if (!cond) {
          throw new AssertionFailed(`${what}${detail === undefined ? '' : ` — observed ${JSON.stringify(detail)}`}`);
        }
        console.log(`${prefix}   ok: ${what}`);
      },
    };

    console.log(`\n=== ${scenario.name} ===`);
    console.log(`    proves: ${scenario.proves}`);
    try {
      await scenario.run(ctx);
      results.push({ scenario, status: 'pass', ms: Date.now() - started });
    } catch (err) {
      if (err instanceof ScenarioSkip) {
        results.push({ scenario, status: 'skip', reason: err.message, ms: Date.now() - started });
        console.log(`${prefix} SKIP: ${err.message}`);
        continue;
      }
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`${prefix} FAILED: ${reason}`);
      results.push({ scenario, status: 'fail', reason, ms: Date.now() - started });
    }
  }

  return report(results);
}

function report(results: Result[]): number {
  const pass = results.filter((r) => r.status === 'pass');
  const fail = results.filter((r) => r.status === 'fail');
  const skip = results.filter((r) => r.status === 'skip');

  console.log('\n================ summary ================');
  for (const r of results) {
    const tag = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIP';
    const suffix = r.status === 'pass' ? `${r.ms}ms` : (r.reason ?? '');
    console.log(`${tag.padEnd(5)} ${r.scenario.name.padEnd(40)} ${suffix}`);
  }
  console.log(`\n${pass.length} passed, ${fail.length} failed, ${skip.length} skipped`);

  if (skip.length > 0) {
    // Loud, because a run that skipped everything looks identical to a
    // successful run if you only check the exit code.
    console.log(
      '\nSKIPPED scenarios prove nothing. This run is NOT evidence for the\n' +
        'launch checklist items they cover. See integration/README.md.',
    );
  }
  if (pass.length === 0 && fail.length === 0) {
    console.log('\nNothing ran. Configure the environment before citing this harness.');
    return 0;
  }
  return fail.length > 0 ? 1 : 0;
}

/** Small fetch wrapper that fails loudly rather than returning an error body. */
export async function api<T>(
  cfg: Config,
  path: string,
  init?: RequestInit & { token?: string },
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init?.token) headers['Authorization'] = `Bearer ${init.token}`;
  const res = await fetch(`${cfg.apiBaseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

/** Poll until `check` returns a value, or throw after `timeoutMs`. */
export async function waitFor<T>(
  what: string,
  timeoutMs: number,
  intervalMs: number,
  check: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const got = await check();
      if (got !== null && got !== undefined) return got;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${what}${lastErr ? ` (last error: ${String(lastErr)})` : ''}`,
  );
}
