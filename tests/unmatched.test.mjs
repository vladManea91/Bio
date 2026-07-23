import test from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../lib/sync.mjs';
import { openStore } from '../lib/store.mjs';
import { saveConfig, loadLiveConfig } from '../lib/config.mjs';

process.env.ADMIN_TOKEN = 'test-admin-token';

const NOW = Date.now();
const created = Math.floor((NOW - 3 * 86400000) / 1000);

/** Charges whose descriptions match none of the configured phrases. */
const fetchImpl = async (rawUrl) => {
  const url = String(rawUrl);
  const reply = (body) => ({ ok: true, status: 200, json: async () => body });
  if (url.includes('/v1/charges')) {
    return reply({
      has_more: false,
      data: [
        { id: 'ch_1', status: 'succeeded', amount: 4900, amount_refunded: 0, currency: 'usd', created, description: 'VLADMANEA.DE ORDER 1041', metadata: {} },
        { id: 'ch_2', status: 'succeeded', amount: 4900, amount_refunded: 0, currency: 'usd', created, description: 'VLADMANEA.DE ORDER 1041', metadata: {} },
        { id: 'ch_3', status: 'succeeded', amount: 900, amount_refunded: 0, currency: 'usd', created, description: 'Some other thing', metadata: {} }
      ]
    });
  }
  return reply({ data: [], has_more: false });
};

async function seed() {
  await runSync({ env: { STRIPE_SECRET_KEY: 'rk_x' }, fetchImpl, now: NOW, full: true });
}

const request = (path, method = 'GET', body) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { 'x-admin-token': 'test-admin-token', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });

test('unmatched payments are grouped by their text, biggest first', async () => {
  await seed();
  const handler = (await import('../netlify/functions/unmatched.mjs')).default;
  const res = await handler(request('/api/unmatched'));
  const body = await res.json();

  assert.equal(body.charges_stored, 3);
  assert.equal(body.unmatched_payments, 3, 'none of them match the shipped phrases');
  assert.equal(body.groups.length, 2, 'the two identical descriptions collapsed into one row');
  assert.equal(body.groups[0].text, 'VLADMANEA.DE ORDER 1041');
  assert.equal(body.groups[0].count, 2);
  assert.equal(body.groups[0].total, 98);
  assert.ok(body.products.length, 'the products are offered to assign to');
});

test('assigning a phrase moves the money onto the product', async () => {
  await seed();
  const store = await openStore('receipts');
  const config = await loadLiveConfig({ store, force: true });

  const product = config.products.find((p) => p.id === 'color-manual');
  product.match.description_contains = ['vladmanea.de order'];
  await saveConfig(config, { store });

  const { rebuild } = await import('../lib/sync.mjs');
  const snapshot = await rebuild({ store, now: NOW });

  assert.equal(snapshot.products['color-manual'].total, 98, 'the two payments landed on the product');
  assert.equal(snapshot.products['color-manual'].orders, 2);
  assert.equal(snapshot.other.total, 9, 'only the genuinely unrelated one is left over');

  const handler = (await import('../netlify/functions/unmatched.mjs')).default;
  const after = await (await handler(request('/api/unmatched'))).json();
  assert.equal(after.matched, 2);
  assert.equal(after.unmatched_payments, 1);

  await store.delete('config');
});

test('the unmatched view refuses without the admin token', async () => {
  const handler = (await import('../netlify/functions/unmatched.mjs')).default;
  const res = await handler(new Request('http://localhost/api/unmatched'));
  assert.equal(res.status, 401);
});

test('the public config endpoint needs no token and hides matching rules', async () => {
  const handler = (await import('../netlify/functions/config.mjs')).default;
  const res = await handler(new Request('http://localhost/api/config'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.profile.name);
  assert.ok(!JSON.stringify(body).includes('description_contains'));
});

test('saving a broken config is refused with a reason', async () => {
  const handler = (await import('../netlify/functions/config.mjs')).default;
  const res = await handler(request('/api/config', 'POST', { profile: {}, products: [{ id: 'Bad Id', name: '' }] }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.problems.length >= 2);
});

test('ignored payments are excluded from the unmatched groups and counted separately', async () => {
  await seed();
  const store = await openStore('receipts');
  const config = await loadLiveConfig({ store, force: true });
  config.ignore = { description_contains: ['some other thing'] };
  await saveConfig(config, { store });

  const handler = (await import('../netlify/functions/unmatched.mjs')).default;
  const body = await (await handler(request('/api/unmatched'))).json();

  assert.equal(body.ignored, 1, 'the one charge matching the ignore rule is counted as ignored');
  assert.equal(body.ignored_total, 9);
  assert.equal(body.unmatched_payments, 2, 'the remaining two are still unmatched, not ignored');
  assert.ok(!body.groups.some((g) => g.text.toLowerCase().includes('some other thing')), 'the ignored group never appears in the list to assign');

  await store.delete('config');
});

test('an ignored payment never counts toward the lifetime total', async () => {
  await seed();
  const store = await openStore('receipts');
  const config = await loadLiveConfig({ store, force: true });
  config.ignore = { description_contains: ['vladmanea.de order'] };
  await saveConfig(config, { store });

  const { rebuild } = await import('../lib/sync.mjs');
  const snapshot = await rebuild({ store, now: NOW });

  assert.equal(snapshot.totals.total, 9, 'only the untouched charge remains in the total');
  assert.equal(snapshot.ignored.total, 98, 'the two matching charges landed in ignored instead');
  assert.equal(snapshot.other.total, 9);

  await store.delete('config');
});
