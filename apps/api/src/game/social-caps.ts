import { and, eq, sql } from 'drizzle-orm';
import { SOCIAL_DAILY_CAP, XP_COMMENT, XP_DAILY_CHECKIN, XP_LIKE, type Net } from '@stonkz/shared';
import type { Db } from '../db/client.js';
import { socialDaily } from '../db/schema.js';
import type { Ledger } from './ledger.js';
import { REASONS } from './rules.js';
import { utcDayKey } from './day.js';

export interface SocialCapsOptions {
  db: Db;
  ledger: Ledger;
  now?: () => number;
}

/**
 * Daily social XP caps + check-in.
 *
 * Comments and likes: 1 XP each, first 5 of each per UTC day (10 XP/day max).
 * Check-in: 10 SP once per UTC day (visiting /me or /rewards).
 *
 * Counter increments only after a successful award so a failed/capped award
 * does not burn a daily slot.
 */
export class SocialCapsService {
  private readonly now: () => number;

  constructor(private readonly opts: SocialCapsOptions) {
    this.now = opts.now ?? Date.now;
  }

  private get db(): Db {
    return this.opts.db;
  }

  private async row(net: Net, wallet: string, dayUtc: string) {
    await this.db.insert(socialDaily).values({ net, wallet, dayUtc }).onConflictDoNothing();
    const [r] = await this.db
      .select()
      .from(socialDaily)
      .where(
        and(
          eq(socialDaily.net, net),
          eq(socialDaily.wallet, wallet),
          eq(socialDaily.dayUtc, dayUtc),
        ),
      )
      .limit(1);
    return r!;
  }

  /** Award comment XP if under the daily cap. Returns awarded XP (0 or 1). */
  async tryComment(
    net: Net,
    wallet: string,
    tipSig: string,
  ): Promise<{ xp: number; remaining: number }> {
    const dayUtc = utcDayKey(this.now());
    const before = await this.row(net, wallet, dayUtc);
    if (before.comments >= SOCIAL_DAILY_CAP) {
      return { xp: 0, remaining: 0 };
    }

    const reserved = await this.db
      .update(socialDaily)
      .set({ comments: sql`${socialDaily.comments} + 1` })
      .where(
        and(
          eq(socialDaily.net, net),
          eq(socialDaily.wallet, wallet),
          eq(socialDaily.dayUtc, dayUtc),
          sql`${socialDaily.comments} < ${SOCIAL_DAILY_CAP}`,
        ),
      )
      .returning({ comments: socialDaily.comments });
    if (reserved.length === 0) {
      return { xp: 0, remaining: 0 };
    }

    const award = await this.opts.ledger.award({
      net,
      wallet,
      reason: REASONS.wallPost,
      baseXp: XP_COMMENT,
      txSig: tipSig,
    });
    if (!award.awarded || award.xp <= 0) {
      await this.db
        .update(socialDaily)
        .set({ comments: sql`greatest(0, ${socialDaily.comments} - 1)` })
        .where(
          and(
            eq(socialDaily.net, net),
            eq(socialDaily.wallet, wallet),
            eq(socialDaily.dayUtc, dayUtc),
          ),
        );
      return { xp: 0, remaining: Math.max(0, SOCIAL_DAILY_CAP - before.comments) };
    }

    const comments = reserved[0]!.comments;
    return { xp: award.xp, remaining: Math.max(0, SOCIAL_DAILY_CAP - comments) };
  }

  /** Award like XP if under the daily cap. */
  async tryLike(
    net: Net,
    wallet: string,
    postId: number,
  ): Promise<{ xp: number; remaining: number }> {
    const dayUtc = utcDayKey(this.now());
    const before = await this.row(net, wallet, dayUtc);
    if (before.likes >= SOCIAL_DAILY_CAP) {
      return { xp: 0, remaining: 0 };
    }

    const reserved = await this.db
      .update(socialDaily)
      .set({ likes: sql`${socialDaily.likes} + 1` })
      .where(
        and(
          eq(socialDaily.net, net),
          eq(socialDaily.wallet, wallet),
          eq(socialDaily.dayUtc, dayUtc),
          sql`${socialDaily.likes} < ${SOCIAL_DAILY_CAP}`,
        ),
      )
      .returning({ likes: socialDaily.likes });
    if (reserved.length === 0) {
      return { xp: 0, remaining: 0 };
    }

    const award = await this.opts.ledger.award({
      net,
      wallet,
      reason: REASONS.like,
      baseXp: XP_LIKE,
      txSig: `like:${postId}:${dayUtc}`,
    });
    if (!award.awarded || award.xp <= 0) {
      await this.db
        .update(socialDaily)
        .set({ likes: sql`greatest(0, ${socialDaily.likes} - 1)` })
        .where(
          and(
            eq(socialDaily.net, net),
            eq(socialDaily.wallet, wallet),
            eq(socialDaily.dayUtc, dayUtc),
          ),
        );
      return { xp: 0, remaining: Math.max(0, SOCIAL_DAILY_CAP - before.likes) };
    }

    const likes = reserved[0]!.likes;
    return { xp: award.xp, remaining: Math.max(0, SOCIAL_DAILY_CAP - likes) };
  }

  /** 10 SP once per UTC day. Idempotent. */
  async tryCheckin(net: Net, wallet: string): Promise<{ claimed: boolean; sp: number }> {
    const dayUtc = utcDayKey(this.now());
    await this.row(net, wallet, dayUtc);

    const claimed = await this.db
      .update(socialDaily)
      .set({ checkinClaimed: true })
      .where(
        and(
          eq(socialDaily.net, net),
          eq(socialDaily.wallet, wallet),
          eq(socialDaily.dayUtc, dayUtc),
          eq(socialDaily.checkinClaimed, false),
        ),
      )
      .returning({ checkinClaimed: socialDaily.checkinClaimed });

    if (claimed.length === 0) return { claimed: false, sp: 0 };

    const award = await this.opts.ledger.award({
      net,
      wallet,
      reason: REASONS.dailyCheckin,
      baseXp: XP_DAILY_CHECKIN,
      txSig: `checkin:${dayUtc}`,
    });
    if (!award.awarded) {
      // Roll the flag back so a failed award can retry the same day.
      await this.db
        .update(socialDaily)
        .set({ checkinClaimed: false })
        .where(
          and(
            eq(socialDaily.net, net),
            eq(socialDaily.wallet, wallet),
            eq(socialDaily.dayUtc, dayUtc),
          ),
        );
      return { claimed: false, sp: 0 };
    }
    return { claimed: true, sp: award.sp };
  }
}
