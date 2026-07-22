import test from 'node:test';
import assert from 'node:assert/strict';
import { runSync, rebuild } from '../lib/sync.mjs';
import { openStore } from '../lib/store.mjs';
import { createStripe } from '../lib/stripe-client.mjs';
import { readFileSync } from 'node:fs';

const SITE = JSON.parse(readFileSync(new URL('../site.config.json', import.meta.url), 'utf8'));
const BASE = (SITE.money.base_currency || 'usd').toLowerCase();
const RATE = (c) => SITE.money.rates[c] ?? 1;

const NOW = Date.now();
const daysAgo = (n) => Math.floor((NOW - n * 86400000) / 1000);

/** 250 charges so paging is exercised, plus one invoice and one session. */
function fakeStripe() {
  const charges = [];
  for (let i = 0; i < 250; i++) {
    charges.push({
      id: `ch_${String(i).padStart(4, '0')}`,
      object: 'charge',
      status: 'succeeded',
      amount: 4900,
      amount_refunded: i % 50 === 0 ? 4900 : 0,
      currency: 'usd',
      created: daysAgo(i % 300),
      description: i % 2 === 0 ? 'ThriveCart - The Color Grading Manual' : 'Payment',
      payment_intent: `pi_${i}`,
      metadata: {}
    });
  }
  charges.push({
    id: 'ch_ancient',
    object: 'charge',
    status: 'succeeded',
    amount: 9900,
    amount_refunded: 0,
    currency: 'usd',
    created: daysAgo(500),
    description: 'ThriveCart - The Color Grading Manual',
    payment_intent: 'pi_ancient',
    metadata: {}
  });
  charges.push({
    id: 'ch_sub',
    object: 'charge',
    status: 'succeeded',
    amount: 300000,
    amount_refunded: 0,
    currency: 'eur',
    created: daysAgo(10),
    description: 'Invoice payment',
    payment_intent: 'pi_sub',
    metadata: {}
  });

  const invoices = [{ id: 'in_1', charge: 'ch_sub', lines: { data: [{ description: 'HFOS', price: { id: 'price_hfos', product: 'prod_hfos' } }] } }];
  const sessions = [{
    id: 'cs_1',
    payment_intent: 'pi_1',
    line_items: { data: [{ description: 'Digital Product Gameplan', price: { id: 'price_gp', product: 'prod_gameplan' } }] }
  }];
  const subs = [{
    id: 'sub_1',
    status: 'active',
    items: { data: [{ quantity: 1, price: { id: 'price_hfos', product: 'prod_hfos', currency: 'eur', unit_amount: 300000, recurring: { interval: 'year', interval_count: 1 } } }] }
  }];

  const calls = [];
  let expandRejections = 0;

  const page = (all, url) => {
    const limit = Number(url.searchParams.get('limit') || 10);
    const after = url.searchParams.get('starting_after');
    const start = after ? all.findIndex((x) => x.id === after) + 1 : 0;
    const slice = all.slice(start, start + limit);
    return { object: 'list', data: slice, has_more: start + limit < all.length };
  };

  const fetchImpl = async (rawUrl, opts) => {
    const url = new URL(rawUrl);
    calls.push(url.pathname + url.search);
    assert.ok(opts.headers.Authorization.startsWith('Bearer '), 'auth header is sent');

    const reply = (body, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => body
    });

    if (url.pathname === '/v1/charges') return reply(page(charges, url));
    if (url.pathname === '/v1/invoices') return reply(page(invoices, url));
    if (url.pathname === '/v1/subscriptions') return reply(page(subs, url));
    if (url.pathname === '/v1/checkout/sessions') {
      // Mimic Stripe refusing a big page when line_items are expanded.
      if (url.searchParams.getAll('expand[]').includes('data.line_items') && Number(url.searchParams.get('limit')) > 20) {
        expandRejections++;
        return reply({ error: { message: 'You cannot expand line_items on a list of that size.' } }, 400);
      }
      return reply(page(sessions, url));
    }
    return reply({ error: { message: `unexpected path ${url.pathname}` } }, 404);
  };

  return { fetchImpl, calls, charges, get expandRejections() { return expandRejections; } };
}

test('stripe client pages through a list until it is done', async () => {
  const { fetchImpl } = fakeStripe();
  const stripe = createStripe('rk_test_123', { fetchImpl });
  const res = await stripe.list('/charges', {});
  assert.equal(res.data.length, 252);
  assert.equal(res.complete, true);
});

test('stripe client stops at the deadline and hands back a cursor', async () => {
  const { fetchImpl } = fakeStripe();
  const stripe = createStripe('rk_test_123', { fetchImpl });
  const res = await stripe.list('/charges', {}, { deadline: Date.now() - 1 });
  assert.equal(res.complete, false);
  assert.equal(res.data.length, 0);
});

test('full sync builds a snapshot with matched products and mrr', async () => {
  const fake = fakeStripe();
  const storeName = `test_${Date.now()}`;
  const result = await runSync({
    env: { STRIPE_SECRET_KEY: 'rk_test_123' },
    fetchImpl: fake.fetchImpl,
    storeName,
    now: NOW,
    full: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.ok(fake.expandRejections > 0, 'the session expand fallback was exercised');

  const snap = result.snapshot;
  assert.equal(snap.currency, BASE, 'the snapshot is in the currency site.config.json asks for');
  assert.ok(snap.products['color-manual'].total > 0, 'the manual matched by description');
  assert.ok(snap.products['gameplan'].total > 0, 'the gameplan matched through a checkout session');
  assert.ok(snap.totals.total > snap.totals.window_total, 'older charges count in the lifetime total only');
  // A 3000 EUR a year plan, expressed monthly in the configured base currency.
  assert.equal(Math.round(snap.totals.mrr), Math.round((3000 * RATE('eur')) / 12), 'a yearly plan reads as a monthly figure');

  // Refunded charges must not be counted.
  const grossManual = 125 * 49 * RATE('usd');
  assert.ok(snap.products['color-manual'].total < grossManual, 'refunds came off the total');

  // A second run should be incremental, not another full pull.
  const again = await runSync({
    env: { STRIPE_SECRET_KEY: 'rk_test_123' },
    fetchImpl: fake.fetchImpl,
    storeName,
    now: NOW
  });
  assert.equal(again.ok, true);
  assert.equal(again.accounts[0].full, false, 'the second run went incremental');
  assert.equal(again.snapshot.products['color-manual'].total, snap.products['color-manual'].total, 'no double counting');
});

test('rebuild re-runs matching on stored data without calling stripe', async () => {
  const fake = fakeStripe();
  const storeName = `test_rebuild_${Date.now()}`;
  await runSync({ env: { STRIPE_SECRET_KEY: 'rk_test_123' }, fetchImpl: fake.fetchImpl, storeName, now: NOW, full: true });

  const before = fake.calls.length;
  const store = await openStore(storeName);
  const snap = await rebuild({ store, now: NOW });
  assert.equal(fake.calls.length, before, 'rebuild made zero network calls');
  assert.ok(snap.products['color-manual'].total > 0);
});

test('a resumable sync finishes across two short runs', async () => {
  const fake = fakeStripe();
  const storeName = `test_resume_${Date.now()}`;
  const first = await runSync({
    env: { STRIPE_SECRET_KEY: 'rk_test_123' },
    fetchImpl: fake.fetchImpl,
    storeName,
    now: NOW,
    full: true,
    budgetMs: 0
  });
  assert.equal(first.complete, false, 'a zero budget run cannot finish');

  let guard = 0;
  let last = first;
  while (!last.complete && guard++ < 10) {
    last = await runSync({ env: { STRIPE_SECRET_KEY: 'rk_test_123' }, fetchImpl: fake.fetchImpl, storeName, now: NOW });
  }
  assert.equal(last.complete, true, 'it caught up on later runs');
  assert.ok(last.snapshot.products['color-manual'].total > 0);
});

test('no stripe key gives a clear message instead of a crash', async () => {
  const result = await runSync({ env: {}, storeName: `test_nokey_${Date.now()}` });
  assert.equal(result.ok, false);
  assert.match(result.error, /STRIPE_SECRET_KEY/);
});

test('two accounts add up into one page', async () => {
  const fake = fakeStripe();
  const storeName = `test_multi_${Date.now()}`;
  const one = await runSync({ env: { STRIPE_SECRET_KEY: 'rk_a' }, fetchImpl: fake.fetchImpl, storeName: `${storeName}_a`, now: NOW, full: true });
  const two = await runSync({
    env: { STRIPE_SECRET_KEY: 'rk_a', STRIPE_SECRET_KEY_2: 'rk_b' },
    fetchImpl: fake.fetchImpl,
    storeName: `${storeName}_b`,
    now: NOW,
    full: true
  });
  assert.equal(two.accounts.length, 2);
  assert.ok(two.snapshot.totals.total > one.snapshot.totals.total * 1.9, 'the second account doubled the numbers');
});
