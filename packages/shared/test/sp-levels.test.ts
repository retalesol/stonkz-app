import { describe, expect, it } from 'vitest';
import { SP_LEVELS, nextSpLevelGrants, spLevelOf, spLevelsReached } from '../src/sp-levels.js';

describe('SP_LEVELS', () => {
  it('is strictly increasing in sp and level', () => {
    for (let i = 1; i < SP_LEVELS.length; i++) {
      expect(SP_LEVELS[i]!.sp).toBeGreaterThan(SP_LEVELS[i - 1]!.sp);
      expect(SP_LEVELS[i]!.level).toBe(SP_LEVELS[i - 1]!.level + 1);
    }
  });

  it('starts at level 1 with free bronze crates', () => {
    expect(SP_LEVELS[0]).toMatchObject({ level: 1, sp: 0, grants: { BRONZE: 2 } });
  });

  it('puts Rhodium at 250k SP', () => {
    expect(SP_LEVELS[19]).toMatchObject({ level: 20, sp: 250_000, grants: { RHODIUM: 1, GOLD: 2 } });
  });

  it('resolves spLevelOf at thresholds', () => {
    expect(spLevelOf(0).level).toBe(1);
    expect(spLevelOf(249).level).toBe(1);
    expect(spLevelOf(250).level).toBe(2);
    expect(spLevelOf(250_000).level).toBe(20);
    expect(spLevelOf(999_999).next).toBeNull();
  });

  it('lists every reached level for catch-up grants', () => {
    expect(spLevelsReached(0).map((l) => l.level)).toEqual([1]);
    expect(spLevelsReached(3_500).map((l) => l.level)).toEqual([1, 2, 3, 4, 5]);
  });

  it('previews the next grant table', () => {
    const next = nextSpLevelGrants(0);
    expect(next?.level).toBe(2);
    expect(next?.grants.BRONZE).toBe(2);
    expect(nextSpLevelGrants(250_000)).toBeNull();
  });
});
