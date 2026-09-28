import { describe, expect, it } from 'vitest';
import { buildSolanaTokenMetadata } from './solana-metadata.js';

describe('buildSolanaTokenMetadata', () => {
  it('emits only the Metaplex fields it has, in a stable order', () => {
    const bare = buildSolanaTokenMetadata({
      name: 'Moon',
      ticker: 'MOON',
      descr: '',
      image: null,
      website: null,
      xHandle: null,
      telegram: null,
    });
    expect(bare).toEqual({ name: 'Moon', symbol: 'MOON', description: '' });
    expect(JSON.stringify(bare)).toBe('{"name":"Moon","symbol":"MOON","description":""}');
  });

  it('omits a file type it cannot infer from the URL', () => {
    const m = buildSolanaTokenMetadata({
      name: 'Moon',
      ticker: 'MOON',
      descr: 'x',
      image: 'https://gw.example/ipfs/bafy',
      website: null,
      xHandle: null,
      telegram: null,
    });
    expect(m['properties']).toEqual({
      category: 'image',
      files: [{ uri: 'https://gw.example/ipfs/bafy' }],
    });
  });
});
