/* Live content and live numbers on top of the static page.
   If the API is unreachable the page still works, it just shows what was
   baked in at build time. Add ?debug=1 to any page to see what happened. */

import { renderHeader, renderSocials, renderVideo, renderProducts, renderLinks, renderSignup, titles } from './render.mjs';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let SITE = window.SITE || {};
const params = new URLSearchParams(location.search);
const DEBUG = params.get('debug') === '1';
const notes = [];
const note = (label, value, state = '') => notes.push({ label, value, state });

const currency = () => (SITE.money?.base_currency || 'usd').toUpperCase();

function money(value, { compact = true } = {}) {
  const n = Number(value) || 0;
  const opts = { style: 'currency', currency: currency(), maximumFractionDigits: 0 };
  if (compact && n >= 10000) {
    return new Intl.NumberFormat(undefined, { ...opts, notation: 'compact', maximumFractionDigits: 1 }).format(n);
  }
  return new Intl.NumberFormat(undefined, opts).format(n);
}

const shortMonth = (key) => {
  const [y, m] = String(key).split('-');
  return new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleString(undefined, { month: 'short', timeZone: 'UTC' });
};

/* ---------- traffic ---------- */

const source = params.get('utm_source') || params.get('ref') || (document.referrer ? new URL(document.referrer).hostname : 'direct');

function track(kind, target) {
  const body = JSON.stringify({ kind, target, source });
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));
      return;
    }
  } catch { /* fall through */ }
  fetch('/api/track', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

track('view', 'page');

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-track]');
  if (el) track('click', el.dataset.track);
});

/* ---------- content, re-rendered when you change it in the admin ---------- */

function paintContent(config) {
  SITE = { ...SITE, ...config };
  const t = titles(config);

  const set = (sel, html) => {
    const el = $(sel);
    if (el && typeof html === 'string') el.innerHTML = html;
  };

  set('#region-head', renderHeader(config.profile || {}));
  set('#region-socials', renderSocials(config.socials));
  set('#region-video', renderVideo(config.featured_video));
  set('#region-products', renderProducts(config.products));
  set('#region-links', renderLinks(config.links));
  set('#region-signup', renderSignup(config.newsletter));

  const pt = $('#products-title');
  if (pt) pt.textContent = t.products;
  const lt = $('#links-title');
  if (lt) lt.textContent = t.links;
  const fn = $('#region-footnote');
  if (fn && config.profile?.footer_note) fn.textContent = config.profile.footer_note;

  wireSignup();
  wireCheckout();
  wireVideo();
}

/* ---------- the receipt tape ---------- */

function countUp(el, value) {
  if (reduced) {
    el.textContent = money(value);
    return;
  }
  const start = performance.now();
  const step = (t) => {
    const p = Math.min((t - start) / 900, 1);
    el.textContent = money(value * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function paintTape(data) {
  const tape = $('#tape');
  if (!tape) return;
  if (SITE.money?.show_total_bar === false) {
    note('receipt strip', 'turned off in your settings');
    return;
  }

  const rows = [];
  for (const product of SITE.products || []) {
    if (product.revenue_display === 'hidden' || product.hidden) continue;
    const stats = data.products?.[product.id];
    const amount = product.revenue_display === 'manual' ? Number(product.manual_revenue || 0) : stats?.total || 0;
    if (amount <= 0) continue;
    rows.push({ name: product.name, amount });
  }

  const total = rows.reduce((a, r) => a + r.amount, 0);
  if (total <= 0) {
    note('receipt strip', 'hidden, because no product has revenue against it yet', 'bad');
    return;
  }

  tape.hidden = false;
  $('[data-tape-date]', tape).textContent = new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  $('[data-tape-rows]', tape).innerHTML = rows
    .map((r, i) => `<div class="tape__row" data-print style="animation-delay:${80 + i * 70}ms"><span>${r.name}</span><i></i><b>${money(r.amount)}</b></div>`)
    .join('');

  countUp($('[data-tape-total]', tape), total);

  const stamp = data.generated_at ? new Date(data.generated_at) : null;
  const bits = [];
  if (data.totals?.orders) bits.push(`${data.totals.orders.toLocaleString()} payments`);
  if (data.totals?.mrr > 0) bits.push(`${money(data.totals.mrr)} a month recurring`);
  bits.push(`checked ${stamp ? stamp.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : 'just now'}`);

  const codes = Object.keys(data.currencies || {}).filter((c) => (data.currencies[c] || 0) !== 0);
  if (codes.length > 1 && data.fx?.date) {
    const others = codes.filter((c) => c !== data.fx.base).map((c) => c.toUpperCase());
    if (others.length) bits.push(`${others.join(' and ')} converted at ${data.fx.date} rates`);
  }

  const providers = (data.providers || ['stripe']).map((p) => (p === 'paypal' ? 'PayPal' : 'Stripe'));
  $('[data-tape-foot]', tape).textContent = `Verified with ${providers.join(' and ')} · ${bits.join(' · ')}`;
  note('receipt strip', `showing ${rows.length} products`, 'good');
}

/* ---------- product cards ---------- */

function paintProducts(data) {
  const label = $('[data-window-label]');
  if (label && data.months?.length) {
    label.textContent = `${shortMonth(data.months[0])} ${String(data.months[0]).slice(2, 4)} to now`;
  }

  let painted = 0;
  for (const product of SITE.products || []) {
    const card = $(`[data-product="${CSS.escape(product.id)}"]`);
    if (!card) continue;
    const stats = data.products?.[product.id];
    const moneyEl = $('[data-money]', card);
    const sparkEl = $('[data-spark]', card);
    const labelsEl = $('[data-spark-labels]', card);
    if (product.revenue_display === 'hidden' || !stats || !moneyEl) continue;

    if (product.revenue_display === 'manual') {
      moneyEl.innerHTML = `${money(Number(product.manual_revenue || 0))}<em>collected</em>`;
      painted += 1;
      continue;
    }

    const lastMonth = data.months?.[data.months.length - 1];
    const monthly = stats.mrr > 0 ? stats.mrr : stats.months?.[lastMonth] || 0;

    if (product.revenue_display === 'monthly' && monthly > 0) {
      moneyEl.innerHTML = `${money(monthly)}<em>${stats.mrr > 0 ? 'a month' : 'this month'}</em>`;
      painted += 1;
    } else if (stats.total > 0) {
      moneyEl.innerHTML = `${money(stats.total)}<em>${stats.orders ? `${stats.orders.toLocaleString()} payments` : 'collected'}</em>`;
      painted += 1;
    }

    const values = (data.months || []).map((m) => stats.months?.[m] || 0);
    const peak = Math.max(...values, 0);
    if (peak <= 0) continue;

    sparkEl.hidden = false;
    sparkEl.innerHTML = values
      .map((v, i) => {
        const h = Math.max(2, Math.round((v / peak) * 30));
        const on = i === values.length - 1 && v > 0 ? ' class="on"' : '';
        return `<i${on} style="height:${h}px" title="${shortMonth(data.months[i])}: ${money(v, { compact: false })}"></i>`;
      })
      .join('');

    labelsEl.hidden = false;
    labelsEl.innerHTML = `<span>${shortMonth(data.months[0])}</span><span>peak ${money(peak)}</span><span>${shortMonth(data.months[values.length - 1])}</span>`;
  }

  const configured = (SITE.products || []).length;
  note('product numbers', `${painted} of ${configured} cards have money on them`, painted ? 'good' : 'bad');
  if (!painted && data.other?.total > 0) {
    note('why', `${money(data.other.total)} is sitting in Everything else. Open /admin.html and use Find my products.`, 'bad');
  }
}

/* ---------- interactions ---------- */

function wireSignup() {
  const btn = $('#subscribe');
  if (!btn) return;
  const emailEl = $('#email');
  const noteEl = $('#signup-note');

  const send = async () => {
    const email = emailEl.value.trim();
    if (!email) {
      noteEl.dataset.state = 'error';
      noteEl.textContent = 'Type your email first.';
      emailEl.focus();
      return;
    }
    btn.disabled = true;
    noteEl.dataset.state = '';
    noteEl.textContent = 'Adding you...';
    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, company: $('#company')?.value || '', source, ref: location.href })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'That did not go through.');
      noteEl.dataset.state = 'ok';
      noteEl.textContent = SITE.newsletter?.success || 'You are on the list.';
      emailEl.value = '';
      track('click', 'subscribe');
    } catch (err) {
      noteEl.dataset.state = 'error';
      noteEl.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  };

  btn.addEventListener('click', send);
  emailEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
}

function wireCheckout() {
  $$('[data-checkout]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.checkout;
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'One moment...';
      track('click', `checkout:${id}`);
      try {
        const res = await fetch('/api/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ product: id })
        });
        const body = await res.json();
        if (!body.url) throw new Error(body.error || 'Checkout is not set up for this one.');
        location.href = body.url;
      } catch (err) {
        btn.disabled = false;
        btn.textContent = original;
        alert(err.message);
      }
    });
  });
}

/** The video only loads YouTube after a click, so arriving costs nothing. */
function wireVideo() {
  const box = $('[data-video]');
  if (!box) return;
  const play = () => {
    const id = box.dataset.video;
    box.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0" title="Video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
  };
  box.addEventListener('click', play);
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(); } });
}

/* ---------- after a purchase ---------- */

const paid = params.get('paid');
if (paid) {
  const banner = $('#paid-banner');
  const product = (SITE.products || []).find((p) => p.id === paid);
  if (banner) {
    banner.hidden = false;
    banner.textContent = `Payment received${product ? ` for ${product.name}` : ''}. Check your inbox, the receipt and access are on their way.`;
  }
  track('click', `paid:${paid}`);
}

/* ---------- debug panel ---------- */

function paintDebug() {
  if (!DEBUG) return;
  const box = $('#debug');
  if (!box) return;
  box.hidden = false;
  box.innerHTML =
    '<h3>Debug, only visible with ?debug=1</h3>' +
    notes.map((n) => `<div><b>${n.label}:</b> <span class="${n.state}">${n.value}</span></div>`).join('');
}

/* ---------- go ---------- */

wireSignup();
wireCheckout();
wireVideo();

const configReq = fetch('/api/config')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`config ${r.status}`))))
  .then((config) => {
    if (config.revision && config.revision !== SITE.revision) {
      paintContent(config);
      note('content', `re-rendered from your saved settings, revision ${config.revision}`, 'good');
    } else {
      SITE = { ...SITE, ...config };
      note('content', 'the built page already matches your settings');
    }
  })
  .catch((err) => {
    note('content', `using the version built at deploy time (${err.message})`);
  });

const revenueReq = fetch('/api/revenue')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .catch((err) => {
    note('payments api', `not reachable: ${err.message}. Are you opening the file directly instead of running the site?`, 'bad');
    return null;
  });

Promise.all([configReq, revenueReq]).then(([, data]) => {
  if (!data) return paintDebug();

  note('payments api', 'reachable', 'good');
  if (data.source === 'empty') {
    note('stored payments', 'none yet. Open /admin.html, paste your admin token, press Full resync.', 'bad');
    return paintDebug();
  }

  note('stored payments', `${data.totals?.orders || 0} payments, ${money(data.totals?.total || 0)} total`, 'good');
  if (data.other?.total > 0) {
    note('unmatched', `${money(data.other.total)} not assigned to any product`, 'bad');
  }

  paintTape(data);
  paintProducts(data);
  paintDebug();
});
