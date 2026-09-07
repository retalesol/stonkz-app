import { describe, expect, it } from 'vitest';
import { resolveClientIp } from './client-ip.js';

describe('resolveClientIp', () => {
  it('takes the single hop a correctly single-hop-proxied request has (no client-supplied header)', () => {
    // Railway's edge appends the real connecting IP as the only entry when
    // the client sent no X-Forwarded-For of its own.
    expect(resolveClientIp('203.0.113.9', 1)).toBe('203.0.113.9');
  });

  it('walks a genuine multi-hop chain from the right by the configured depth', () => {
    // client -> proxy1 -> proxy2 -> us, with trustedProxyDepth = 2 (proxy1
    // and proxy2 both append their own observed IP honestly).
    expect(resolveClientIp('1.2.3.4, 10.0.0.1, 10.0.0.2', 2)).toBe('10.0.0.1');
  });

  it('ignores a spoofed prefix a client prepends before the trusted hop(s)', () => {
    // A client sends "9.9.9.9, 8.8.8.8" as its own X-Forwarded-For, trying to
    // look like it already traversed two hops. The one trusted proxy in
    // front (depth 1) still appends the real IP at the end — that's the only
    // entry that should ever be trusted.
    expect(resolveClientIp('9.9.9.9, 8.8.8.8, 203.0.113.9', 1)).toBe('203.0.113.9');
  });

  it('produces the same identity across different spoofed prefixes, as long as the real trusted hop is the same', () => {
    const real = '198.51.100.42';
    const a = resolveClientIp(`1.1.1.1, ${real}`, 1);
    const b = resolveClientIp(`2.2.2.2, 3.3.3.3, 4.4.4.4, ${real}`, 1);
    const c = resolveClientIp(`${real}`, 1);
    expect(a).toBe(real);
    expect(b).toBe(real);
    expect(c).toBe(real);
  });

  it('does not conflate two different real clients that send different spoofed prefixes', () => {
    const client1 = resolveClientIp('9.9.9.9, 203.0.113.9', 1);
    const client2 = resolveClientIp('9.9.9.9, 203.0.113.10', 1);
    expect(client1).not.toBe(client2);
  });

  it('returns null when fewer hops are present than the configured trusted depth, rather than trusting a client-supplied entry', () => {
    // trustedProxyDepth = 2 but only one hop appears in the header — this
    // does not look like the deployment's expected topology, so fail closed
    // instead of picking the (attacker-controlled) leftmost entry.
    expect(resolveClientIp('9.9.9.9', 2)).toBeNull();
  });

  it('returns null when the header is absent', () => {
    expect(resolveClientIp(undefined, 1)).toBeNull();
    expect(resolveClientIp(null, 1)).toBeNull();
    expect(resolveClientIp('', 1)).toBeNull();
  });

  it('trusts nothing when trustedProxyDepth is 0 (no proxy in front)', () => {
    expect(resolveClientIp('1.2.3.4, 5.6.7.8', 0)).toBeNull();
  });

  it('trusts nothing when trustedProxyDepth is negative', () => {
    expect(resolveClientIp('1.2.3.4', -1)).toBeNull();
  });

  it('tolerates extra whitespace around each hop', () => {
    expect(resolveClientIp('  1.2.3.4 ,  5.6.7.8  ', 1)).toBe('5.6.7.8');
  });

  it('ignores empty entries produced by stray commas', () => {
    expect(resolveClientIp('1.2.3.4,,5.6.7.8', 1)).toBe('5.6.7.8');
  });
});
