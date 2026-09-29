import { Hono } from 'hono';
import { authRoutes } from '../routes/auth.js';
import { healthRoutes } from '../routes/health.js';
import { marketRoutes } from '../routes/market.js';
import { meRoutes } from '../routes/me.js';
import { quoteRoutes } from '../routes/quote.js';
import { rewardsRoutes } from '../routes/rewards.js';
import { tokenRoutes } from '../routes/tokens.js';
import { tradeRoutes } from '../routes/trade.js';
import { launchRoutes } from '../routes/launch.js';
import { feesRoutes } from '../routes/fees.js';
import { graduateRoutes } from '../routes/graduate.js';
import { stakeRoutes } from '../routes/stake.js';
import { socialRoutes } from '../routes/social.js';
import { chatRoutes } from '../routes/chat.js';
import { xRoutes } from '../routes/x.js';
import { ogRoutes } from '../routes/og.js';
import { adminRoutes } from '../routes/admin.js';
import { platformRoutes } from '../routes/admin-public.js';
import { referralRoutes } from '../routes/referrals.js';
import type { AppDeps, AppEnv } from './context.js';
import { requestLogger, withDeps } from './middleware.js';
import { cors, securityHeaders } from './security.js';

/**
 * Builds the HTTP app from an explicit dependency container.
 *
 * Nothing is constructed in here, which is what lets the test suite hand over
 * PGlite, `MemoryRedis` and fake RPCs and then drive real requests through
 * `app.request()` with no server socket at all.
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', withDeps(deps));
  app.use('*', securityHeaders({ hsts: deps.env.nodeEnv === 'production' }));
  app.use('*', cors(deps.env.corsOrigins));
  app.use('*', requestLogger());

  app.route('/', healthRoutes());
  app.route('/', authRoutes());
  app.route('/', meRoutes());
  app.route('/', rewardsRoutes());
  app.route('/', tokenRoutes());
  app.route('/', quoteRoutes());
  app.route('/', marketRoutes());
  app.route('/', tradeRoutes());
  app.route('/', launchRoutes());
  app.route('/', feesRoutes());
  app.route('/', graduateRoutes());
  app.route('/', stakeRoutes());
  app.route('/', socialRoutes());
  app.route('/', referralRoutes());
  app.route('/', chatRoutes());
  app.route('/', xRoutes());
  app.route('/', ogRoutes());
  app.route('/', platformRoutes());
  app.route('/', adminRoutes());

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  app.onError((err, c) => {
    const deps_ = c.get('deps');
    deps_.logger.error('unhandled error', {
      requestId: c.get('requestId'),
      path: new URL(c.req.url).pathname,
      err: err.message,
      stack: err.stack,
    });
    // Never leak an internal message to a browser.
    return c.json({ error: 'internal_error', requestId: c.get('requestId') }, 500);
  });

  return app;
}
