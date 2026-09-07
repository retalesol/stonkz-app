import { usd } from '@stonkz/shared';
import { bySym } from '../state/coins.js';

/**
 * URL routing.
 *
 * The oracle had one URL for the whole terminal, so a token page could not be
 * linked, bookmarked, shared or reached with the back button. Four routes fix
 * that without a framework: the view state and the address bar are the same
 * thing now.
 *
 * @see plan step 31
 */

export type Route =
  | { view: 'board' }
  | { view: 'token'; sym: string }
  | { view: 'rewards' }
  | { view: 'profile'; addr?: string | undefined }
  /** The launch stepper over the board, so a deploy link can be shared. */
  | { view: 'launch' };

export const BOARD: Route = { view: 'board' };

export function toPath(r: Route): string {
  switch (r.view) {
    case 'token':
      return '/t/' + encodeURIComponent(r.sym);
    case 'rewards':
      return '/rewards';
    case 'launch':
      return '/launch';
    case 'profile':
      return r.addr ? '/u/' + encodeURIComponent(r.addr) : '/me';
    default:
      return '/';
  }
}

export function parse(path: string): Route {
  const p = path.replace(/\/+$/, '') || '/';
  if (p === '/rewards') return { view: 'rewards' };
  if (p === '/launch') return { view: 'launch' };
  if (p === '/me') return { view: 'profile' };
  const t = /^\/t\/([^/]+)$/.exec(p);
  if (t) return { view: 'token', sym: decodeURIComponent(t[1] as string).toUpperCase() };
  const u = /^\/u\/([^/]+)$/.exec(p);
  if (u) return { view: 'profile', addr: decodeURIComponent(u[1] as string) };
  return BOARD;
}

/**
 * The document title for a route. `index.html` only ever had one, so every tab
 * read "Stonkz Launchpad" and a pinned token page was unfindable. The market
 * cap rides along on token routes because a tab strip is a tape too.
 *
 * @see plan step 32
 */
export function titleOf(r: Route): string {
  const DOT = ' \u00B7 ';
  if (r.view === 'token') {
    const c = bySym(r.sym);
    return 'STONKZ' + DOT + '$' + r.sym + (c ? DOT + usd(c.mc) : '');
  }
  if (r.view === 'rewards') return 'STONKZ' + DOT + 'REWARDS';
  if (r.view === 'launch') return 'STONKZ' + DOT + 'LAUNCH A COIN';
  if (r.view === 'profile') return 'STONKZ' + DOT + (r.addr ? r.addr : 'YOUR PROFILE');
  return 'Stonkz Launchpad';
}

/** Keep the title fresh while a token's cap moves under a live route. */
export function retitle(): void {
  document.title = titleOf(current());
}

let handler: (r: Route, popped: boolean) => void = () => undefined;
let now: Route = BOARD;
/** Entries this session has pushed, so `back()` knows whether it can pop. */
let depth = 0;

export function current(): Route {
  return now;
}

export function onRoute(fn: (r: Route, popped: boolean) => void): void {
  handler = fn;
}

/** Go somewhere. `replace` is for redirects that should not add history. */
export function navigate(r: Route, opts: { replace?: boolean } = {}): void {
  const path = toPath(r);
  const same = toPath(now) === path;
  now = r;
  if (!same || opts.replace) {
    const fn = opts.replace ? 'replaceState' : 'pushState';
    history[fn](r, '', path);
    if (!opts.replace) depth++;
  }
  document.title = titleOf(r);
  handler(r, false);
}

/**
 * The BACK buttons and the escape stack.
 *
 * A real pop when this session put something on the stack, so leaving rewards
 * returns to the token page you opened it from rather than always the board.
 * A cold load straight onto `/rewards` has nothing to pop, so it goes home.
 */
export function back(): void {
  if (depth > 0) {
    history.back();
    return;
  }
  navigate(BOARD, { replace: true });
}

/** Wire popstate and dispatch whatever the address bar already says. */
export function startRouting(): void {
  window.addEventListener('popstate', (e) => {
    const r = (e.state as Route | null) ?? parse(location.pathname);
    now = r;
    if (depth > 0) depth--;
    document.title = titleOf(r);
    handler(r, true);
  });
  const initial = parse(location.pathname);
  now = initial;
  history.replaceState(initial, '', toPath(initial));
  document.title = titleOf(initial);
  handler(initial, true);
}
