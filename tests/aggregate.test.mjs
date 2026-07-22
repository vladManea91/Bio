import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregate, buildHints, matchProduct, convert, monthKey, monthWindow, netOf, itemMrr, toMajor
} from '../lib/aggregate.mjs';

const config = {
  money: { base_currency: 'eur', rates: { eur: 1, usd: 0.92, jpy: 0.0061 }, window_months: 12 },
  products: [
    { id: 'manual', match: { description_contains: ['color grading manual'] } },
    { id: 'gameplan', match: { stripe_product: ['prod_gameplan'], description_contains: ['gameplan'] } },
    { id: 'community', match: { stripe_price: ['price_hfos'] } }
  ]
};

const NOW = Date.UTC(2026, 6, 22); // 22 July 2026
const daysAgo = (n) => Math.floor((NOW - n * 86400000) / 1000);

const charge = (over = {}) => ({
  id: `ch_${Math.random().toString(36).slice(2)}`,
  status: 'succeeded',
  amount: 1000,
  amount_refunded: 0,
  currency: 'eur',
  created: daysAgo(5),
  description: null,
  metadata: {},
  ...over
});

test('minor units convert per currency', () => {
  assert.equal(toMajor(1000, 'eur'), 10);
  assert.equal(toMajor(1000, 'jpy'), 1000);
  assert.ok(Math.abs(convert(1000, 'usd', config.money) - 9.2) < 1e-9);
  assert.equal(convert(1000, 'eur', config.money), 10);
  assert.equal(convert(500, 'xyz', config.money), 5); // unknown currency counts 1:1, never dropped
});

test('month keys and windows are UTC and inclusive of this month', () => {
  assert.equal(monthKey(Math.floor(Date.UTC(2026, 0, 31) / 1000)), '2026-01');
  const w = monthWindow(12, NOW);
  assert.equal(w.length, 12);
  assert.equal(w[11], '2026-07');
  assert.equal(w[0], '2025-08');
});

test('net removes refunds, failed charges and lost disputes', () => {
  assert.equal(netOf(charge({ amount: 5000, amount_refunded: 1000 }), config.money), 40);
  assert.equal(netOf(charge({ status: 'failed' }), config.money), 0);
  assert.equal(netOf(charge({ disputed: true, dispute: { status: 'lost' } }), config.money), 0);
  assert.equal(netOf(charge({ disputed: true, dispute: { status: 'won' } }), config.money), 10);
});

test('matches a ThriveCart style charge by its description', () => {
  const c = charge({ description: 'ThriveCart - The Color Grading Manual' });
  assert.equal(matchProduct(c, undefined, config.products), 'manual');
});

test('matches by metadata when the description is useless', () => {
  const products = [{ id: 'x', match: { metadata: { sku: 'CGM-01' } } }];
  const c = charge({ description: 'Payment', metadata: { sku: 'cgm-01' } });
  assert.equal(matchProduct(c, undefined, products), 'x');
});

test('stripe product id from an invoice beats a text match', () => {
  const c = charge({ id: 'ch_1', description: 'color grading manual bundle' });
  const invoices = [{ id: 'in_1', charge: 'ch_1', lines: { data: [{ price: { id: 'p1', product: 'prod_gameplan' } }] } }];
  const hints = buildHints({ invoices, charges: [c] });
  assert.equal(matchProduct(c, hints.get('ch_1'), config.products), 'gameplan');
});

test('checkout session line items reach the charge through the payment intent', () => {
  const c = charge({ id: 'ch_2', payment_intent: 'pi_2', description: 'Stripe' });
  const sessions = [{
    id: 'cs_2',
    payment_intent: 'pi_2',
    line_items: { data: [{ price: { id: 'price_hfos', product: 'prod_hfos' } }] }
  }];
  const hints = buildHints({ sessions, charges: [c] });
  assert.equal(matchProduct(c, hints.get('ch_2'), config.products), 'community');
});

test('unmatched revenue lands in other, never in a product', () => {
  const c = charge({ description: 'Consulting call' });
  const out = aggregate({ charges: [c], config, now: NOW });
  assert.equal(out.other.total, 10);
  assert.equal(out.products.manual.total, 0);
  assert.equal(out.totals.total, 10);
});

test('monthly buckets, last 30 days and the change against the month before', () => {
  const charges = [
    charge({ description: 'color grading manual', amount: 4900, created: daysAgo(2) }),
    charge({ description: 'color grading manual', amount: 4900, created: daysAgo(20) }),
    charge({ description: 'color grading manual', amount: 2000, created: daysAgo(45) })
  ];
  const out = aggregate({ charges, config, now: NOW });
  assert.equal(out.products.manual.total, 118);
  assert.equal(out.products.manual.orders, 3);
  assert.equal(out.totals.last30, 98);
  assert.equal(out.totals.prev30, 20);
  assert.equal(out.totals.change30, 390);
  assert.equal(out.months.length, 12);
});

test('charges older than the window count in total but not in the chart', () => {
  const old = charge({ description: 'color grading manual', amount: 10000, created: Math.floor(Date.UTC(2023, 0, 1) / 1000) });
  const out = aggregate({ charges: [old], config, now: NOW });
  assert.equal(out.products.manual.total, 100);
  assert.equal(out.totals.window_total, 0);
});

test('mrr normalises every billing interval to one month', () => {
  const money = config.money;
  assert.equal(Math.round(itemMrr({ quantity: 1, price: { unit_amount: 300000, currency: 'eur', recurring: { interval: 'year', interval_count: 1 } } }, money)), 250);
  assert.equal(itemMrr({ quantity: 2, price: { unit_amount: 900, currency: 'eur', recurring: { interval: 'month', interval_count: 1 } } }, money), 18);
  assert.equal(itemMrr({ quantity: 1, price: { unit_amount: 1200, currency: 'eur', recurring: { interval: 'month', interval_count: 3 } } }, money), 4);
});

test('subscriptions add mrr to the right product and skip cancelled ones', () => {
  const subs = [
    { id: 'sub_1', status: 'active', items: { data: [{ quantity: 1, price: { id: 'price_hfos', product: 'prod_hfos', currency: 'eur', unit_amount: 300000, recurring: { interval: 'year', interval_count: 1 } } }] } },
    { id: 'sub_2', status: 'canceled', items: { data: [{ quantity: 1, price: { id: 'price_hfos', currency: 'eur', unit_amount: 300000, recurring: { interval: 'year', interval_count: 1 } } }] } }
  ];
  const out = aggregate({ subscriptions: subs, config, now: NOW });
  assert.equal(Math.round(out.products.community.mrr), 250);
  assert.equal(Math.round(out.totals.mrr), 250);
});

test('a mixed currency month adds up in the base currency', () => {
  const charges = [
    charge({ description: 'color grading manual', amount: 4900, currency: 'usd', created: daysAgo(3) }),
    charge({ description: 'color grading manual', amount: 4900, currency: 'eur', created: daysAgo(3) })
  ];
  const out = aggregate({ charges, config, now: NOW });
  assert.equal(out.products.manual.total, 94.08);
});
