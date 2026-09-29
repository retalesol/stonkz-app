import { num, type TokenFees } from '@stonkz/shared';
import { DOT } from '../lib/fmt.js';
import { type Html, html } from '../lib/html.js';

/**
 * The Fees tab's creator panel: what `claimCreatorFees` / `claim_creator_fees`
 * pays the coin's creator right now, and the button that builds that
 * transaction. Pure, so the decision of *who* sees it and *what* it says is
 * testable without a DOM.
 *
 * Shown to the creator only. Everyone else sees the CREATOR row of the ledger
 * table, which is lifetime earnings, not a claimable balance.
 */

export interface CreatorPanelInput {
  fees: TokenFees;
  /** The signed-in wallet's full address, or `''` when none. */
  viewer: string;
  /** Formats a base/native amount (the tab's own `nat`). */
  nat: (v: number) => string;
}

export interface CreatorPanel {
  /** The viewer is this coin's creator. */
  isCreator: boolean;
  claimableBase: number;
  claimableTokens: number;
  baseSym: string;
  canClaim: boolean;
  source: 'chain' | 'indexer';
  /** `0.000276 WETH + 12 MEMEMAN`, or `NOTHING TO CLAIM YET`. */
  amountLabel: string;
  sourceLabel: string;
}

export function isSameWallet(net: TokenFees['net'], a: string, b: string): boolean {
  if (!a || !b) return false;
  return net === 'SOL' ? a === b : a.toLowerCase() === b.toLowerCase();
}

export function creatorPanel(input: CreatorPanelInput): CreatorPanel | null {
  const { fees, viewer, nat } = input;
  const c = fees.creator;
  if (!c) return null;
  const isCreator = isSameWallet(fees.net, viewer, c.wallet);
  const parts: string[] = [];
  if (c.claimableBase > 0)
    parts.push(nat(c.claimableBase).replace(fees.unit, c.baseSym || fees.unit));
  if (c.claimableTokens > 0) parts.push(num(c.claimableTokens) + ' ' + fees.sym);
  const canClaim = parts.length > 0;
  return {
    isCreator,
    claimableBase: c.claimableBase,
    claimableTokens: c.claimableTokens,
    baseSym: c.baseSym || fees.unit,
    canClaim,
    source: c.source,
    amountLabel: canClaim ? parts.join(' + ') : 'NOTHING TO CLAIM YET',
    sourceLabel:
      c.source === 'chain'
        ? 'READ FROM THE PROGRAM ' + DOT + ' WHAT THE CLAIM PAYS, TO THE ATOM'
        : 'FROM THE INDEXER ' + DOT + ' TRAILS THE CHAIN BY A FEW BLOCKS',
  };
}

export function creatorPanelHTML(p: CreatorPanel | null, sym: string): Html {
  if (!p || !p.isCreator) return html``;
  return html`<div class="stk-claim" id="fees-creator" style="display:block">
    <div class="lbl" style="margin:0 0 4px">YOUR CREATOR FEES ${DOT} ${sym}</div>
    <div class="fee-row">
      <div style="flex:1;min-width:0">
        <div class="val${p.canClaim ? ' up' : ''}" id="fc-amount">${p.amountLabel}</div>
        <span class="hint" id="fc-src">${p.sourceLabel}</span>
      </div>
      <button type="button" class="claimbtn" id="fc-claim" ${p.canClaim ? '' : html`disabled`}>
        CLAIM
      </button>
    </div>
    <p class="hint" style="margin:6px 0 0">
      YOUR SHARE OF THE 69% BUCKET, LESS WHAT THIS COIN'S STAKERS TOOK ${DOT} ONE SIGNATURE, PAID BY
      THE LAUNCHPAD TO YOUR WALLET ${DOT} PLATFORM, BUYBACK AND RWA LEGS ARE NEVER CLAIMABLE HERE
    </p>
  </div>`;
}
