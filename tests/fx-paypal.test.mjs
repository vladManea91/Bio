import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRates, mergeRates } from '../lib/fx.mjs';
import { normalise, toMinor, dateChunks, createPayPal, paypalAccounts } from '../lib/paypal-client.mjs';
import { aggregate } from '../lib/aggregate.mjs';

/* ---------------- exchange rates ---------------- */

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

test('rates come back inverted into the direction this project uses', async () => {
  // Frankfurter says 1 USD buys 0.85 EUR. We want: one euro is worth 1.176 dollars.
  const fx = await fetchRates('usd', ['eur', 'gbp'], {
    fetchImpl: async () => okJson({ base: 'USD', date: '2026-07-22', rates: { EUR: 0.85, GBP: 0.75 } })
  });
  assert.equal(fx.base, 'usd');
  assert.equal(fx.rates.usd, 1);
  assert.equal(fx.rates.eur, 1.176471);
  assert.equal(fx.rates.gbp, 1.333333);
  assert.equal(fx.date, '2026-07-22');
  assert.equal(fx.source, 'frankfurter');
});

test('a dead first source falls through to the second', async () => {
  let calls = 0;
  const fx = await fetchRates('usd', ['eur'], {
    fetchImpl: async (url) => {
      calls++;
      if (String(url).includes('frankfurter')) return { ok: false, status: 503, json: async () => ({}) };
      return okJson({ result: 'success', base_code: 'USD', time_last_update_utc: 'Wed, 22 Jul 2026 00:02:31 +0000', rates: { EUR: 0.8 } });
    }
  });
  assert.equal(calls, 2);
  assert.equal(fx.source, 'exchangerate-api');
  assert.equal(fx.rates.eur, 1.25);
});

test('both sources down throws rather than inventing a number', async () => {
  await assert.rejects(
    () => fetchRates('usd', ['eur'], { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) }),
    /No rate source answered/
  );
});

test('asking only for the base currency needs no network call', async () => {
  const fx = await fetchRates('usd', ['usd'], {
    fetchImpl: async () => { throw new Error('should not be called'); }
  });
  assert.equal(fx.rates.usd, 1);
});

test('live rates override the config, and missing ones keep the config value', () => {
  const money = { base_currency: 'usd', rates: { usd: 1, eur: 1.17, gbp: 1.34 } };
  const merged = mergeRates(money, { base: 'usd', rates: { eur: 1.2 } });
  assert.equal(merged.eur, 1.2, 'live rate wins');
  assert.equal(merged.gbp, 1.34, 'untouched currency keeps its configured rate');
  assert.equal(merged.usd, 1);
});

test('stored rates for a different base are ignored', () => {
  const money = { base_currency: 'usd', rates: { usd: 1, eur: 1.17 } };
  const merged = mergeRates(money, { base: 'eur', rates: { usd: 0.85 } });
  assert.equal(merged.eur, 1.17);
  assert.equal(merged.usd, 1);
});

test('a rate change moves the totals', () => {
  const charges = [{ id: 'c1', status: 'succeeded', amount: 10000, amount_refunded: 0, currency: 'eur', created: Math.floor(Date.now() / 1000), description: 'manual', metadata: {} }];
  const products = [{ id: 'manual', match: { description_contains: ['manual'] } }];
  const before = aggregate({ charges, config: { money: { base_currency: 'usd', rates: { usd: 1, eur: 1.1 } }, products } });
  const after = aggregate({ charges, config: { money: { base_currency: 'usd', rates: { usd: 1, eur: 1.2 } }, products } });
  assert.equal(before.products.manual.total, 110);
  assert.equal(after.products.manual.total, 120);
});

/* ---------------- paypal ---------------- */

test('decimal strings become minor units, zero decimal currencies excepted', () => {
  assert.equal(toMinor('49.00', 'usd'), 4900);
  assert.equal(toMinor('9.99', 'usd'), 999);
  assert.equal(toMinor('-49.00', 'usd'), -4900);
  assert.equal(toMinor('5000', 'jpy'), 5000);
});

test('a long range is split into chunks PayPal accepts', () => {
  const now = Math.floor(Date.now() / 1000);
  const chunks = dateChunks(now - 365 * 86400, now);
  assert.ok(chunks.length >= 12);
  for (const c of chunks) assert.ok((c.end - c.start) <= 31 * 86400, 'no chunk exceeds 31 days');
  assert.equal(chunks[0].start, now - 365 * 86400);
  assert.equal(chunks[chunks.length - 1].end, now);
});

test('a paypal sale reads like a stripe charge', () => {
  const record = normalise({
    transaction_info: {
      transaction_id: '9AB12345CD',
      transaction_event_code: 'T0006',
      transaction_initiation_date: '2026-07-01T10:00:00+0000',
      transaction_amount: { currency_code: 'USD', value: '49.00' },
      transaction_status: 'S',
      transaction_subject: 'The Color Grading Manual',
      invoice_id: 'TC-1042'
    },
    cart_info: { item_details: [{ item_name: 'Color Grading Manual', item_amount: { value: '49.00' } }] }
  });
  assert.equal(record.id, 'pp_9AB12345CD');
  assert.equal(record.amount, 4900);
  assert.equal(record.currency, 'usd');
  assert.equal(record.status, 'succeeded');
  assert.equal(record.source, 'paypal');
  assert.equal(record.description, 'The Color Grading Manual');
  assert.equal(record.metadata.invoice_id, 'TC-1042');
});

test('the same match rules work across stripe and paypal', () => {
  const products = [{ id: 'color-manual', match: { description_contains: ['color grading manual'] } }];
  const paypal = normalise({
    transaction_info: {
      transaction_id: 'PP1',
      transaction_initiation_date: new Date().toISOString(),
      transaction_amount: { currency_code: 'USD', value: '49.00' },
      transaction_status: 'S'
    },
    cart_info: { item_details: [{ item_name: 'The Color Grading Manual' }] }
  });
  const stripe = {
    id: 'ch_1', status: 'succeeded', amount: 4900, amount_refunded: 0, currency: 'usd',
    created: Math.floor(Date.now() / 1000), description: 'ThriveCart - The Color Grading Manual', metadata: {}
  };
  const out = aggregate({ charges: [paypal, stripe], config: { money: { base_currency: 'usd', rates: { usd: 1 } }, products } });
  assert.equal(out.products['color-manual'].total, 98, 'both providers landed on the same product');
  assert.equal(out.products['color-manual'].orders, 2);
  assert.deepEqual(out.currencies, { usd: 98 });
});

test('a paypal refund subtracts and does not count as a sale', () => {
  const products = [{ id: 'manual', match: { description_contains: ['manual'] } }];
  const sale = normalise({
    transaction_info: { transaction_id: 'S1', transaction_initiation_date: new Date().toISOString(), transaction_amount: { currency_code: 'USD', value: '49.00' }, transaction_status: 'S', transaction_subject: 'Manual' }
  });
  const refund = normalise({
    transaction_info: { transaction_id: 'R1', transaction_event_code: 'T1107', transaction_initiation_date: new Date().toISOString(), transaction_amount: { currency_code: 'USD', value: '-49.00' }, transaction_status: 'S', transaction_subject: 'Manual' }
  });
  const out = aggregate({ charges: [sale, refund], config: { money: { base_currency: 'usd', rates: { usd: 1 } }, products } });
  assert.equal(out.products.manual.total, 0, 'the refund cancelled the sale');
  assert.equal(out.products.manual.orders, 1, 'one sale, not two');
});

test('pending and denied transactions never reach the ledger', async () => {
  const entries = [
    { transaction_info: { transaction_id: 'A', transaction_status: 'S', transaction_initiation_date: '2026-07-01T00:00:00Z', transaction_amount: { currency_code: 'USD', value: '10.00' }, transaction_subject: 'ok' } },
    { transaction_info: { transaction_id: 'B', transaction_status: 'P', transaction_initiation_date: '2026-07-01T00:00:00Z', transaction_amount: { currency_code: 'USD', value: '10.00' }, transaction_subject: 'pending' } },
    { transaction_info: { transaction_id: 'C', transaction_status: 'D', transaction_initiation_date: '2026-07-01T00:00:00Z', transaction_amount: { currency_code: 'USD', value: '10.00' }, transaction_subject: 'denied' } }
  ];
  const paypal = createPayPal('id', 'secret', {
    fetchImpl: async (url) => {
      if (String(url).includes('oauth2/token')) return okJson({ access_token: 'tok', expires_in: 3600 });
      return okJson({ transaction_details: entries, total_pages: 1 });
    }
  });
  const now = Math.floor(Date.now() / 1000);
  const res = await paypal.transactions({ since: now - 10 * 86400, until: now });
  assert.equal(res.data.length, 1);
  assert.equal(res.data[0].id, 'pp_A');
});

test('the access token is fetched once and reused', async () => {
  let tokenCalls = 0;
  const paypal = createPayPal('id', 'secret', {
    fetchImpl: async (url) => {
      if (String(url).includes('oauth2/token')) {
        tokenCalls++;
        return okJson({ access_token: 'tok', expires_in: 3600 });
      }
      return okJson({ transaction_details: [], total_pages: 1 });
    }
  });
  const now = Math.floor(Date.now() / 1000);
  await paypal.transactions({ since: now - 90 * 86400, until: now });
  assert.equal(tokenCalls, 1);
});

test('a missing Transaction Search permission explains itself', async () => {
  const paypal = createPayPal('id', 'secret', {
    fetchImpl: async (url) => {
      if (String(url).includes('oauth2/token')) return okJson({ access_token: 'tok', expires_in: 3600 });
      return { ok: false, status: 403, json: async () => ({ message: 'Permission denied' }) };
    }
  });
  const now = Math.floor(Date.now() / 1000);
  await assert.rejects(() => paypal.transactions({ since: now - 86400, until: now }), /Transaction Search/);
});

test('bad credentials say so instead of throwing something cryptic', async () => {
  const paypal = createPayPal('id', 'wrong', {
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error_description: 'Client Authentication failed' }) })
  });
  await assert.rejects(() => paypal.accessToken(), /Client Authentication failed/);
});

test('paypal stays off unless both halves of the credential are set', () => {
  assert.equal(paypalAccounts({}).length, 0);
  assert.equal(paypalAccounts({ PAYPAL_CLIENT_ID: 'x' }).length, 0);
  assert.equal(paypalAccounts({ PAYPAL_CLIENT_ID: 'x', PAYPAL_CLIENT_SECRET: 'y' }).length, 1);
  assert.equal(paypalAccounts({ PAYPAL_CLIENT_ID: 'x', PAYPAL_CLIENT_SECRET: 'y', PAYPAL_CLIENT_ID_2: 'a', PAYPAL_CLIENT_SECRET_2: 'b' }).length, 2);
});

test('a full sync merges stripe and paypal into one snapshot', async () => {
  const { runSync } = await import('../lib/sync.mjs');
  const now = Date.now();
  const created = Math.floor((now - 5 * 86400000) / 1000);

  const fetchImpl = async (rawUrl) => {
    const url = String(rawUrl);
    const reply = (body) => ({ ok: true, status: 200, json: async () => body });

    if (url.includes('oauth2/token')) return reply({ access_token: 'tok', expires_in: 3600 });
    if (url.includes('/v1/reporting/transactions')) {
      return reply({
        total_pages: 1,
        transaction_details: [{
          transaction_info: {
            transaction_id: 'PPX1',
            transaction_status: 'S',
            transaction_initiation_date: new Date(created * 1000).toISOString(),
            transaction_amount: { currency_code: 'USD', value: '49.00' },
            transaction_subject: 'The Color Grading Manual'
          }
        }]
      });
    }
    if (url.includes('/v1/charges')) {
      return reply({
        has_more: false,
        data: [{
          id: 'ch_x1', status: 'succeeded', amount: 4900, amount_refunded: 0, currency: 'usd',
          created, description: 'ThriveCart - The Color Grading Manual', metadata: {}
        }]
      });
    }
    return reply({ data: [], has_more: false });
  };

  const result = await runSync({
    env: { STRIPE_SECRET_KEY: 'rk_x', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'sec' },
    fetchImpl,
    storeName: `test_both_${Date.now()}`,
    now,
    full: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.accounts.length, 2, 'one stripe account and one paypal account');
  assert.deepEqual([...result.snapshot.providers].sort(), ['paypal', 'stripe']);
  assert.equal(result.snapshot.products['color-manual'].total, 98, 'both sales counted once each');
  assert.equal(result.snapshot.products['color-manual'].orders, 2);
});

test('paypal failing does not stop stripe from syncing', async () => {
  const { runSync } = await import('../lib/sync.mjs');
  const now = Date.now();
  const fetchImpl = async (rawUrl) => {
    const url = String(rawUrl);
    if (url.includes('paypal')) return { ok: false, status: 403, json: async () => ({ message: 'Permission denied' }) };
    if (url.includes('/v1/charges')) {
      return { ok: true, status: 200, json: async () => ({ has_more: false, data: [{ id: 'ch_ok', status: 'succeeded', amount: 4900, amount_refunded: 0, currency: 'usd', created: Math.floor(now / 1000) - 100, description: 'color grading manual', metadata: {} }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: [], has_more: false }) };
  };

  const result = await runSync({
    env: { STRIPE_SECRET_KEY: 'rk_x', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'sec' },
    fetchImpl,
    storeName: `test_ppfail_${Date.now()}`,
    now,
    full: true
  });

  assert.equal(result.ok, true);
  assert.ok(result.accounts.find((a) => a.account.startsWith('paypal')).error, 'the paypal problem is reported');
  assert.equal(result.snapshot.products['color-manual'].total, 49, 'stripe revenue still landed');
});
