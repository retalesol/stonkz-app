import { must } from '../lib/dom.js';

/** The four top-level wraps. Exactly one is visible. `index.html:2433` */
export type ViewName = 'board' | 'token' | 'rewards' | 'profile';

const IDS: Record<ViewName, string> = {
  board: '#boardView',
  token: '#tokenView',
  rewards: '#rewardsView',
  profile: '#profileView',
};

let showing: ViewName = 'board';

export function currentView(): ViewName {
  return showing;
}

export function showView(v: ViewName): void {
  showing = v;
  for (const name of Object.keys(IDS) as ViewName[]) {
    must(IDS[name]).hidden = name !== v;
  }
  window.scrollTo(0, 0);
}
