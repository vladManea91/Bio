/**
 * Runs the real src/assets/app.js against the real built public/index.html in a
 * DOM, feeding it a revenue payload. Checks that the tape, the sparklines and
 * the product numbers actually paint.
 *
 *   node scripts/check-page.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { build } from 'esbuild';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const REVENUE = {
  generated_at: new Date().toISOString(),
  currency: 'usd',
  source: 'stripe',
  months: ['2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'],
  totals: { total: 66252.88, mrr: 3000, orders: 486, window_total: 56202.8, last30: 4576.84, prev30: 6093.16, change30: -24.9, months: {} },
  currencies: { usd: 60000, eur: 6252.88 },
  fx: { base: 'usd', rates: { usd: 1, eur: 1.17 }, date: '2026-07-22', source: 'frankfurter' },
  providers: ['stripe', 'paypal'],
  products: {
    'color-manual': { total: 12430.5, mrr: 0, orders: 254, months: { '2025-08': 540, '2025-09': 620, '2025-10': 450, '2025-11': 721, '2025-12': 360, '2026-01': 980, '2026-02': 450, '2026-03': 360, '2026-04': 360, '2026-05': 315, '2026-06': 360, '2026-07': 410 } },
    'high-freedom-os': { total: 55200, mrr: 3000, orders: 20, months: { '2026-01': 8280, '2026-03': 5520, '2026-06': 11040, '2026-07': 2760 } },
    gameplan: { total: 2078.4, mrr: 0, orders: 231, months: { '2026-05': 400, '2026-06': 620, '2026-07': 300 } },
    presets: { total: 2799.9, mrr: 0, orders: 72, months: { '2026-06': 300, '2026-07': 520 } }
  },
  other: { total: 0, mrr: 0, orders: 0, months: {} }
};

const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name} ${detail}`);
    failures.push(name);
  }
};

const html = await fs.readFile(path.join(ROOT, 'public', 'index.html'), 'utf8');
// app.js is an ES module that imports the shared renderer, so bundle it the
// way a browser would resolve it before running it in a fake DOM.
const bundled = await build({
  entryPoints: [path.join(ROOT, 'public', 'assets', 'app.js')],
  bundle: true,
  format: 'iife',
  write: false,
  logLevel: 'silent'
});
const appJs = bundled.outputFiles[0].text;
const { window, document } = parseHTML(html);

// Minimal browser surface the script touches.
window.matchMedia = () => ({ matches: false, addEventListener() {} });
window.requestAnimationFrame = (fn) => fn(performance.now() + 1000);
window.performance = performance;
window.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') };
Object.defineProperty(window, 'navigator', { value: { sendBeacon: () => true }, configurable: true });
Object.defineProperty(window, 'location', { value: new URL('https://links.example.com/?utm_source=ig'), configurable: true });
window.alert = () => {};
window.Intl = Intl;
window.SITE = JSON.parse(html.match(/window\.SITE = (\{.*?\});/s)[1]);

const fetched = [];
const LIVE_CONFIG = {
  revision: 'changed-in-admin',
  profile: { name: 'Vlad Manea', handle: '@vladmanea', location: 'Germany', tagline: 'Edited in the admin panel.' },
  sections: { products_title: 'My products', links_title: 'Find me here' },
  featured_video: { enabled: true, heading: 'Start here', title: 'How I grade a photo', youtube_id: 'dQw4w9WgXcQ' },
  socials: [{ label: 'Instagram', icon: 'instagram', url: 'https://instagram.com/x' }],
  links: [
    { id: 'a', title: 'Channel', url: 'https://youtube.com/@x', kind: 'youtube' },
    { id: 'b', title: 'Skool', url: 'https://skool.com/x', kind: 'skool' }
  ],
  newsletter: { enabled: true, heading: 'The color list', button: 'Join', success: 'Done.' },
  money: { base_currency: 'usd', window_months: 12, show_total_bar: true },
  products: JSON.parse(JSON.stringify(window.SITE.products))
};

window.fetch = async (url) => {
  fetched.push(String(url));
  if (String(url).includes('/api/revenue')) return { ok: true, status: 200, json: async () => REVENUE };
  if (String(url).includes('/api/config')) return { ok: true, status: 200, json: async () => LIVE_CONFIG };
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};

const ctx = vm.createContext(window);
ctx.window = window;
ctx.document = document;
ctx.globalThis = window;
vm.runInContext(appJs, ctx);

await new Promise((r) => setTimeout(r, 60));

console.log('\nstatic markup');
check('4 product cards rendered', document.querySelectorAll('.card').length === 4);
check('links re-rendered from the saved settings', document.querySelectorAll('.link').length === 2);
check('socials re-rendered from the saved settings', document.querySelectorAll('.socials a').length === 1);
check('section heading follows the saved settings', document.querySelector('#links-title').textContent === 'Find me here');
check('tagline re-rendered', /Edited in the admin panel/.test(document.querySelector('.head__tagline').textContent));
check('featured video rendered', Boolean(document.querySelector('[data-video]')));
check('video does not load youtube until clicked', !document.querySelector('#region-video iframe'));
check('signup form present', Boolean(document.querySelector('#subscribe')));
check('no unreplaced tokens', !html.includes('{{'));
check('honeypot field is hidden', document.querySelector('#company')?.className === 'hp');
check('every card has a clickable title', [...document.querySelectorAll('.card__name a')].length === 4);

console.log('\nlive numbers');
const tape = document.querySelector('#tape');
check('tape became visible', tape.hasAttribute('hidden') === false);
const rows = tape.querySelectorAll('.tape__row');
check('tape lists every earning product', rows.length === 4, `got ${rows.length}`);
const total = tape.querySelector('[data-tape-total]').textContent;
check('tape total is formatted money', /\d/.test(total) && /[$€£]|USD|EUR/.test(total), `got "${total}"`);
check('tape footer names both providers', /Stripe and PayPal/.test(tape.querySelector('[data-tape-foot]').textContent), tape.querySelector('[data-tape-foot]').textContent);
check('tape footer says when currencies were converted', /converted at 2026-07-22 rates/.test(tape.querySelector('[data-tape-foot]').textContent));
check('tape footer counts payments', /486/.test(tape.querySelector('[data-tape-foot]').textContent));

const manual = document.querySelector('[data-product="color-manual"]');
check('lifetime product shows a total', /\d/.test(manual.querySelector('[data-money]').textContent), manual.querySelector('[data-money]').textContent);
check('lifetime product shows payment count', /254/.test(manual.querySelector('[data-money]').textContent));
check('sparkline drew 12 bars', manual.querySelectorAll('.spark i').length === 12);
check('sparkline is visible', manual.querySelector('.spark').hasAttribute('hidden') === false);
check('sparkline labels show months and peak', /peak/i.test(manual.querySelector('[data-spark-labels]').textContent));
check('bar heights vary', new Set([...manual.querySelectorAll('.spark i')].map((b) => b.getAttribute('style'))).size > 3);
check('last bar is highlighted', manual.querySelector('.spark i:last-child')?.className === 'on');

const hfos = document.querySelector('[data-product="high-freedom-os"]');
check('subscription product shows its total', /\d/.test(hfos.querySelector('[data-money]').textContent));

const presets = document.querySelector('[data-product="presets"]');
check('monthly product says a month or this month', /month/i.test(presets.querySelector('[data-money]').textContent), presets.querySelector('[data-money]').textContent);

console.log('\nbehaviour');
check('config endpoint was called', fetched.some((u) => u.includes('/api/config')));
check('revenue endpoint was called', fetched.some((u) => u.includes('/api/revenue')));

// Now prove the page survives with no API at all.
{
  const { window: w2, document: d2 } = parseHTML(html);
  w2.matchMedia = () => ({ matches: true, addEventListener() {} });
  w2.requestAnimationFrame = (fn) => fn(0);
  w2.CSS = { escape: (s) => s };
  Object.defineProperty(w2, 'navigator', { value: {}, configurable: true });
  Object.defineProperty(w2, 'location', { value: new URL('https://links.example.com/'), configurable: true });
  w2.SITE = window.SITE;
  w2.fetch = async () => { throw new Error('offline'); };
  const c2 = vm.createContext(w2);
  c2.window = w2; c2.document = d2; c2.globalThis = w2;
  vm.runInContext(appJs, c2);
  await new Promise((r) => setTimeout(r, 40));
  console.log('\nno api available');
  check('page still shows the links built at deploy time', d2.querySelectorAll('.link').length === 3);
  check('tape stays hidden instead of showing zeros', d2.querySelector('#tape').hasAttribute('hidden'));
  check('no error text leaked into the page', !/undefined|NaN/.test(d2.querySelector('main').textContent));
}

console.log(`\n${failures.length ? `${failures.length} FAILED` : 'all page checks passed'}`);
process.exit(failures.length ? 1 : 0);
