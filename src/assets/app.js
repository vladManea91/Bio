/* Live numbers on top of the static page. If the API is unreachable the page
   still works, it just shows links without money. */

(() => {
  'use strict';

  const SITE = window.SITE || {};
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const CURRENCY = (SITE.money?.base_currency || 'eur').toUpperCase();

  function money(value, { compact = true } = {}) {
    const n = Number(value) || 0;
    const opts = { style: 'currency', currency: CURRENCY, maximumFractionDigits: 0 };
    if (compact && n >= 10000) {
      return new Intl.NumberFormat(undefined, { ...opts, notation: 'compact', maximumFractionDigits: 1 }).format(n);
    }
    return new Intl.NumberFormat(undefined, opts).format(n);
  }

  const shortMonth = (key) => {
    const [y, m] = key.split('-');
    return new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleString(undefined, { month: 'short', timeZone: 'UTC' });
  };

  /* ---------- traffic ---------- */

  const params = new URLSearchParams(location.search);
  const source = params.get('utm_source') || params.get('ref') || (document.referrer ? new URL(document.referrer).hostname : 'direct');

  function track(kind, target) {
    const body = JSON.stringify({ kind, target, source });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));
        return;
      }
    } catch { /* fall through to fetch */ }
    fetch('/api/track', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
  }

  track('view', 'page');

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-track]');
    if (el) track('click', el.dataset.track);
  });

  /* ---------- the receipt tape ---------- */

  function countUp(el, value) {
    if (reduced) {
      el.textContent = money(value);
      return;
    }
    const start = performance.now();
    const dur = 900;
    const step = (t) => {
      const p = Math.min((t - start) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = money(value * eased);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function paintTape(data) {
    const tape = $('#tape');
    if (!tape || SITE.tape?.show === false) return;

    const rows = [];
    for (const product of SITE.products || []) {
      if (product.revenue_display === 'hidden') continue;
      const stats = data.products?.[product.id];
      const amount = product.revenue_display === 'manual' ? Number(product.manual_revenue || 0) : stats?.total || 0;
      if (amount <= 0) continue;
      rows.push({ name: product.name, amount });
    }

    const total = rows.reduce((a, r) => a + r.amount, 0);
    if (total <= 0) return;

    tape.hidden = false;
    $('[data-tape-date]', tape).textContent = new Date().toLocaleDateString(undefined, {
      day: '2-digit', month: 'short', year: 'numeric'
    });

    const holder = $('[data-tape-rows]', tape);
    holder.innerHTML = rows
      .map(
        (r, i) =>
          `<div class="tape__row" data-print style="animation-delay:${80 + i * 70}ms"><span>${r.name}</span><i></i><b>${money(r.amount)}</b></div>`
      )
      .join('');

    countUp($('[data-tape-total]', tape), total);

    const foot = $('[data-tape-foot]', tape);
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
    foot.textContent = `Verified with ${providers.join(' and ')} · ${bits.join(' · ')}`;
  }

  /* ---------- product cards ---------- */

  function paintProducts(data) {
    const label = $('[data-window-label]');
    if (label && data.months?.length) {
      label.textContent = `${shortMonth(data.months[0])} ${data.months[0].slice(2, 4)} → now`;
    }

    for (const product of SITE.products || []) {
      const card = $(`[data-product="${CSS.escape(product.id)}"]`);
      if (!card) continue;
      const stats = data.products?.[product.id];
      const moneyEl = $('[data-money]', card);
      const sparkEl = $('[data-spark]', card);
      const labelsEl = $('[data-spark-labels]', card);
      if (product.revenue_display === 'hidden' || !stats) continue;

      if (product.revenue_display === 'manual') {
        moneyEl.innerHTML = `${money(Number(product.manual_revenue || 0))}<em>collected</em>`;
        continue;
      }

      const monthly = stats.mrr > 0 ? stats.mrr : stats.months?.[data.months[data.months.length - 1]] || 0;

      if (product.revenue_display === 'monthly' && monthly > 0) {
        moneyEl.innerHTML = `${money(monthly)}<em>${stats.mrr > 0 ? 'a month' : 'this month'}</em>`;
      } else if (stats.total > 0) {
        moneyEl.innerHTML = `${money(stats.total)}<em>${stats.orders ? `${stats.orders.toLocaleString()} payments` : 'collected'}</em>`;
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
  }

  /* ---------- newsletter ---------- */

  const subscribeBtn = $('#subscribe');
  if (subscribeBtn) {
    const emailEl = $('#email');
    const note = $('#signup-note');

    const send = async () => {
      const email = emailEl.value.trim();
      if (!email) {
        note.dataset.state = 'error';
        note.textContent = 'Type your email first.';
        emailEl.focus();
        return;
      }
      subscribeBtn.disabled = true;
      note.dataset.state = '';
      note.textContent = 'Adding you…';
      try {
        const res = await fetch('/api/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, company: $('#company')?.value || '', source, ref: location.href })
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'That did not go through.');
        note.dataset.state = 'ok';
        note.textContent = SITE.newsletter?.success || 'You are on the list.';
        emailEl.value = '';
        track('click', 'subscribe');
      } catch (err) {
        note.dataset.state = 'error';
        note.textContent = err.message;
      } finally {
        subscribeBtn.disabled = false;
      }
    };

    subscribeBtn.addEventListener('click', send);
    emailEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send();
    });
  }

  /* ---------- stripe checkout buttons ---------- */

  $$('[data-checkout]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.checkout;
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'One moment…';
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

  /* ---------- go ---------- */

  fetch('/api/revenue')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`revenue ${r.status}`))))
    .then((data) => {
      if (!data || data.source === 'empty') return;
      paintTape(data);
      paintProducts(data);
    })
    .catch(() => {
      /* No API on this host, or nothing synced yet. The page stays as it is. */
    });
})();
