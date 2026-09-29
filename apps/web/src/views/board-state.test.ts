import { describe, expect, it } from 'vitest';
import {
  boardParamsToSearch,
  compareCoins,
  matchesQuery,
  parseBoardParams,
  rankMatches,
  visibleNets,
} from './board-state.js';

describe('board URL state', () => {
  it('round-trips sort, net and query', () => {
    const p = parseBoardParams('?sort=mc&net=SOL&q=pepe');
    expect(p).toEqual({ sort: 'mc', net: 'SOL', q: 'pepe' });
    expect(boardParamsToSearch(p)).toBe('?sort=mc&net=SOL&q=pepe');
  });

  it('omits defaults so the home URL stays bare', () => {
    expect(boardParamsToSearch({ sort: 'new', net: 'ALL', q: '' })).toBe('');
    expect(boardParamsToSearch({ sort: 'new', net: 'ALL', q: '  ' })).toBe('');
    expect(parseBoardParams('')).toEqual({ sort: 'new', net: 'ALL', q: '' });
  });

  it('falls back to defaults for unknown values and accepts lowercase nets', () => {
    expect(parseBoardParams('?sort=vibes&net=moon')).toEqual({ sort: 'new', net: 'ALL', q: '' });
    expect(parseBoardParams('?net=base').net).toBe('BASE');
    expect(parseBoardParams('?net=all').net).toBe('ALL');
  });

  it('trims and caps the query', () => {
    expect(parseBoardParams('?q=' + encodeURIComponent('  x'.padEnd(200, 'y'))).q.length).toBe(80);
  });

  it('escapes the query', () => {
    expect(boardParamsToSearch({ sort: 'new', net: 'ALL', q: 'a&b=<c>' })).toBe(
      '?q=a%26b%3D%3Cc%3E',
    );
    expect(parseBoardParams('?q=a%26b%3D%3Cc%3E').q).toBe('a&b=<c>');
  });
});

describe('visibleNets', () => {
  it('drops chains the environment has not deployed', () => {
    expect(visibleNets(['SOL', 'BASE', 'ARC', 'RH'], (n) => n !== 'ARC')).toEqual([
      'SOL',
      'BASE',
      'RH',
    ]);
  });
});

describe('compareCoins', () => {
  const coins = [
    { id: 1, mc: 100, chg: 5, reps: 1, age: 30, launchedAt: 3000 },
    { id: 2, mc: 300, chg: -1, reps: 9, age: 10, launchedAt: 5000 },
    { id: 3, mc: 300, chg: 20, reps: 9, age: 20, launchedAt: 4000 },
  ];
  const order = (k: 'new' | 'mc' | 'chg' | 'rep') =>
    coins
      .slice()
      .sort(compareCoins(k))
      .map((c) => c.id);

  it('matches the server: newest, cap, change, replies — ties by recency', () => {
    expect(order('new')).toEqual([2, 3, 1]);
    expect(order('mc')).toEqual([2, 3, 1]);
    expect(order('chg')).toEqual([3, 1, 2]);
    expect(order('rep')).toEqual([2, 3, 1]);
  });

  it('uses age when no launch timestamp is known (sim coins)', () => {
    const sim = [
      { id: 1, mc: 1, chg: 0, reps: 0, age: 30 },
      { id: 2, mc: 1, chg: 0, reps: 0, age: 5 },
    ];
    expect(sim.sort(compareCoins('new')).map((c) => c.id)).toEqual([2, 1]);
  });
});

describe('matchesQuery', () => {
  const c = { sym: 'PEPE2', name: 'Pepe Two Point Oh', dev: 'DevOne', mint: '0xAbCdEf0123' };
  it('matches ticker, name and creator case-insensitively', () => {
    expect(matchesQuery(c, 'PEPE')).toBe(true);
    expect(matchesQuery(c, 'POINT')).toBe(true);
    expect(matchesQuery(c, 'DEVONE')).toBe(true);
    expect(matchesQuery(c, 'DOGE')).toBe(false);
  });
  it('matches an address exactly or by a prefix of six or more', () => {
    expect(matchesQuery(c, '0XABCDEF0123')).toBe(true);
    expect(matchesQuery(c, '0XABCD')).toBe(true);
    expect(matchesQuery(c, '0XAB')).toBe(false);
  });
  it('matches everything on an empty query', () => {
    expect(matchesQuery(c, '')).toBe(true);
  });
});

describe('rankMatches', () => {
  const rows = [
    { sym: 'PEPEX', name: 'Pepe Extra', dev: '', mc: 900, mint: 'm1' },
    { sym: 'PEPE', name: 'Pepe', dev: '', mc: 100, mint: 'm2' },
    { sym: 'PEPE', name: 'Pepe on Base', dev: '', mc: 500, mint: 'm3' },
    { sym: 'FROG', name: 'The Pepe Frog', dev: '', mc: 9000, mint: 'm4' },
  ];
  it('prefers the exact ticker, biggest cap first, then prefixes, then names', () => {
    expect(rankMatches(rows, 'pepe').map((r) => r.mint)).toEqual(['m3', 'm2', 'm1', 'm4']);
  });
  it('puts an exact address second only to an exact ticker', () => {
    expect(rankMatches(rows, 'm4')[0]?.mint).toBe('m4');
  });
});
