import { describe, expect, it, vi } from 'vitest';
import type { Logger } from './logger.js';
import {
  Metrics,
  alertPayload,
  combineAlertHooks,
  webhookAlertHook,
  type Alert,
  type AlertHook,
} from './metrics.js';

const NOW = 1_790_000_000_000;

function fakeFetch(status = 200) {
  const calls: { url: string; body: unknown; method: string | undefined }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)), method: init?.method });
    return new Response(null, { status });
  });
  return { calls, fetchImpl };
}

function spyLogger(): Logger & { warns: { msg: string; fields?: Record<string, unknown> }[] } {
  const warns: { msg: string; fields?: Record<string, unknown> }[] = [];
  const l: Logger & { warns: typeof warns } = {
    warns,
    debug: () => {},
    info: () => {},
    warn: (msg, fields) => {
      warns.push(fields ? { msg, fields } : { msg });
    },
    error: () => {},
    child: () => l,
  };
  return l;
}

const lag: Alert = {
  key: 'chain-lag:RH',
  severity: 'critical',
  message: 'RH indexer lag exceeds 30s',
  fields: { net: 'RH', seconds: 45.2 },
};

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('webhookAlertHook', () => {
  it('POSTs a Slack/Discord-compatible JSON body with `text` and the structured alert', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const hook = webhookAlertHook({
      url: 'https://hooks.example/abc',
      fetchImpl,
      now: () => NOW,
      service: 'stonkz-api',
    });
    hook(lag);
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://hooks.example/abc');
    expect(calls[0]!.body).toEqual({
      text: '[CRITICAL] stonkz-api: RH indexer lag exceeds 30s (net=RH seconds=45.2)',
      service: 'stonkz-api',
      key: 'chain-lag:RH',
      severity: 'critical',
      message: 'RH indexer lag exceeds 30s',
      fields: { net: 'RH', seconds: 45.2 },
      at: new Date(NOW).toISOString(),
    });
  });

  it('posts one alert per key per 10 minutes, but lets the RESOLVED line through', async () => {
    const { calls, fetchImpl } = fakeFetch();
    let clock = NOW;
    const hook = webhookAlertHook({
      url: 'https://hooks.example/abc',
      fetchImpl,
      now: () => clock,
    });
    hook(lag);
    clock += 60_000;
    hook(lag);
    clock += 60_000;
    hook({ ...lag, severity: 'warn', message: `RESOLVED: ${lag.message}` });
    await flush();
    expect(calls.map((c) => (c.body as { text: string }).text)).toEqual([
      '[CRITICAL] stonkz-api: RH indexer lag exceeds 30s (net=RH seconds=45.2)',
      '[WARN] stonkz-api: RESOLVED: RH indexer lag exceeds 30s (net=RH seconds=45.2)',
    ]);
    clock += 10 * 60_000;
    hook(lag);
    await flush();
    expect(calls).toHaveLength(3);
  });

  it('drops alerts below ALERT_WEBHOOK_MIN_SEVERITY', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const hook = webhookAlertHook({
      url: 'https://hooks.example/abc',
      fetchImpl,
      now: () => NOW,
      minSeverity: 'critical',
    });
    hook({ ...lag, key: 'rpc-errors:SOL', severity: 'warn' });
    hook(lag);
    await flush();
    expect(calls).toHaveLength(1);
    expect((calls[0]!.body as { key: string }).key).toBe('chain-lag:RH');
  });

  it('logs, never throws, when the webhook is down or refuses', async () => {
    const logger = spyLogger();
    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    webhookAlertHook({ url: 'https://hooks.example/x', fetchImpl: down, logger, now: () => NOW })(
      lag,
    );
    const { fetchImpl: refusing } = fakeFetch(500);
    webhookAlertHook({
      url: 'https://hooks.example/y',
      fetchImpl: refusing,
      logger,
      now: () => NOW,
    })(lag);
    await flush();
    expect(logger.warns.map((w) => w.msg).sort()).toEqual([
      'alert webhook refused the alert',
      'alert webhook unreachable',
    ]);
    const refused = logger.warns.find((w) => w.msg === 'alert webhook refused the alert');
    expect(refused?.fields).toMatchObject({ alert: 'chain-lag:RH', status: 500 });
  });

  it('is what Metrics calls alongside the log hook', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const seen: Alert[] = [];
    const logHook: AlertHook = (a) => seen.push(a);
    const metrics = new Metrics(
      30,
      combineAlertHooks(
        () => {
          throw new Error('a broken hook');
        },
        logHook,
        webhookAlertHook({ url: 'https://hooks.example/abc', fetchImpl, now: () => NOW }),
      ),
      () => NOW,
    );
    metrics.observeChainLag('RH', 0, 100, 2000); // 200 s behind
    await flush();
    expect(seen).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});

describe('alertPayload', () => {
  it('renders non-string fields as JSON in the text line', () => {
    const p = alertPayload(
      { key: 'k', severity: 'warn', message: 'm', fields: { a: 'x', b: [1, 2], c: null } },
      'svc',
      NOW,
    );
    expect(p.text).toBe('[WARN] svc: m (a=x b=[1,2] c=null)');
  });
});
