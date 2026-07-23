import { json, requireAdmin } from '../../lib/http.mjs';
import { readLedger } from '../../lib/sync.mjs';
import { loadLiveConfig } from '../../lib/config.mjs';
import { buildHints, matchProduct, convert } from '../../lib/aggregate.mjs';

/**
 * Admin only. Shows the payments that did not match any product, grouped by
 * the text they arrived with, biggest first. This is how you find the phrase
 * to paste into a product's match rules instead of guessing at it.
 */
export default async (req) => {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const site = await loadLiveConfig({ force: true });
  const { charges, invoices, sessions } = await readLedger();
  const hints = buildHints({ charges, invoices, sessions });
  const money = site.money || {};

  const groups = new Map();
  let matchedCount = 0;
  let ignoredCount = 0;
  let ignoredTotal = 0;

  const ignoreRules = site.ignore || {};
  const hasIgnoreRules = Object.values(ignoreRules).some((v) => (Array.isArray(v) ? v.length > 0 : Object.keys(v || {}).length > 0));
  const ignoreCheck = hasIgnoreRules ? [{ id: '__ignored__', match: ignoreRules }] : null;

  for (const charge of charges) {
    if (charge.status !== 'succeeded') continue;
    const hint = hints.get(charge.id);

    if (ignoreCheck && matchProduct(charge, hint, ignoreCheck)) {
      ignoredCount += 1;
      ignoredTotal += convert((charge.amount || 0) - (charge.amount_refunded || 0), charge.currency, money);
      continue;
    }

    if (matchProduct(charge, hint, site.products || [])) {
      matchedCount += 1;
      continue;
    }

    const hintText = hint ? [...hint.text][0] : null;
    const label =
      charge.description ||
      hintText ||
      charge.metadata?.items ||
      charge.calculated_statement_descriptor ||
      charge.statement_descriptor ||
      '(no description on this payment)';

    const key = label.toLowerCase().trim();
    const entry = groups.get(key) || {
      text: label,
      count: 0,
      total: 0,
      provider: charge.source || 'stripe',
      stripe_products: new Set(),
      stripe_prices: new Set(),
      sample: null
    };

    entry.count += 1;
    entry.total += convert((charge.amount || 0) - (charge.amount_refunded || 0), charge.currency, money);
    if (hint) {
      for (const p of hint.products) entry.stripe_products.add(p);
      for (const p of hint.prices) entry.stripe_prices.add(p);
    }
    if (!entry.sample) {
      entry.sample = {
        id: charge.id,
        created: charge.created,
        currency: charge.currency,
        metadata: charge.metadata || {}
      };
    }
    groups.set(key, entry);
  }

  const unmatched = [...groups.values()]
    .map((g) => ({
      ...g,
      total: Math.round(g.total * 100) / 100,
      stripe_products: [...g.stripe_products],
      stripe_prices: [...g.stripe_prices]
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 50);

  return json({
    currency: (money.base_currency || 'usd').toLowerCase(),
    charges_stored: charges.length,
    matched: matchedCount,
    ignored: ignoredCount,
    ignored_total: Math.round(ignoredTotal * 100) / 100,
    unmatched_payments: charges.length - matchedCount - ignoredCount,
    unmatched_total: Math.round(unmatched.reduce((a, g) => a + g.total, 0) * 100) / 100,
    groups: unmatched,
    products: (site.products || []).map((p) => ({ id: p.id, name: p.name }))
  });
};

export const config = { path: '/api/unmatched' };
