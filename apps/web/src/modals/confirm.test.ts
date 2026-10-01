import { describe, expect, it } from 'vitest';
import { confirmHTML } from './confirm.js';

describe('confirmHTML', () => {
  it('renders the headline, rows, note and a buy-toned commit button', () => {
    const out = confirmHTML({
      title: 'Confirm Buy',
      headline: 'BUY 0.02 ETH OF $MEMEMAN',
      rows: [
        ['SLIP', '1%'],
        ['GAS', 'FAST'],
      ],
      note: 'YOUR WALLET WILL ASK YOU TO SIGN NEXT.',
      ok: 'CONFIRM BUY',
      tone: 'buy',
    }).toString();
    expect(out).toContain('cfm-head buy');
    expect(out).toContain('BUY 0.02 ETH OF $MEMEMAN');
    expect(out).toContain('<span>SLIP</span><b>1%</b>');
    expect(out).toContain('<span>GAS</span><b>FAST</b>');
    expect(out).toContain('YOUR WALLET WILL ASK YOU TO SIGN NEXT.');
    expect(out).toContain('class="cfm-ok buy" id="cfm-ok">CONFIRM BUY<');
    expect(out).toContain('id="cfm-cancel">CANCEL<');
  });

  it('escapes user-controlled text and omits empty sections', () => {
    const out = confirmHTML({
      title: 'x',
      headline: 'SELL 5 <img src=x onerror=alert(1)> OF $EVIL',
      tone: 'sell',
    }).toString();
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
    expect(out).not.toContain('cfm-rows');
    expect(out).not.toContain('cfm-note');
    expect(out).toContain('cfm-ok sell');
  });
});
