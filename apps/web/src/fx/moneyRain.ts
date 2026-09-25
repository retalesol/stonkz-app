import { $ } from '../lib/dom.js';
import { reducedMotion } from '../lib/motion.js';

/**
 * `+$10,000` confetti over the wizard's finish card. Fires once per device —
 * `wizFinish()` owns that rule. `index.html:2767`
 */
export function moneyRain(n: number): void {
  if (reducedMotion()) return;
  const box = $('#wizScrim .wiz');
  if (!box) return;
  const r = box.getBoundingClientRect();
  const layer = document.createElement('div');
  layer.className = 'money-layer';
  document.body.appendChild(layer);
  for (let i = 0; i < n; i++) {
    const e = document.createElement('span');
    e.className = 'money';
    e.textContent = '+$10,000';
    e.style.left = (r.left + 14 + Math.random() * (r.width - 28)).toFixed(0) + 'px';
    e.style.top = (r.top + 8).toFixed(0) + 'px';
    e.style.fontSize = (14 + Math.random() * 9).toFixed(0) + 'px';
    e.style.setProperty(
      '--dx',
      ((Math.random() * 2 - 1) * (90 + Math.random() * 270)).toFixed(0) + 'px',
    );
    e.style.setProperty('--up', (70 + Math.random() * 140).toFixed(0) + 'px');
    e.style.setProperty(
      '--fall',
      (240 + Math.random() * (window.innerHeight - r.top)).toFixed(0) + 'px',
    );
    e.style.setProperty('--rot', ((Math.random() * 2 - 1) * 30).toFixed(0) + 'deg');
    e.style.setProperty('--dur', (1.7 + Math.random() * 1.3).toFixed(2) + 's');
    e.style.setProperty(
      '--delay',
      (i < 14 ? i * 0.028 : 0.24 + Math.random() * 0.5).toFixed(2) + 's',
    );
    layer.appendChild(e);
  }
  setTimeout(() => {
    if (layer.parentNode) layer.parentNode.removeChild(layer);
  }, 4600);
}
