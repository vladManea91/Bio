/**
 * Pure functions. No network, no environment. Everything here is unit tested
 * in tests/aggregate.test.mjs so the money math can be trusted.
 */

/** Zero decimal currencies never get divided by 100. */
const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'
]);

/** Stripe minor units -> major units of that same currency. */
export function toMajor(amountMinor, currency) {
  const c = String(currency || 'eur').toLowerCase();
  return ZERO_DECIMAL.has(c) ? amountMinor : amountMinor / 100;
}

/** Convert into the base currency using the fixed rate table from site.config.json. */
export function convert(amountMinor, currency, money) {
  const c = String(currency || 'eur').toLowerCase();
  const base = String(money?.base_currency || 'eur').toLowerCase();
  const rates = money?.rates || {};
  const major = toMajor(amountMinor, c);
  if (c === base) return major;
  const rate = rates[c];
  if (typeof rate !== 'number') return major; // unknown currency: count it 1:1 rather than dropping revenue
  const baseRate = typeof rates[base] === 'number' ? rates[base] : 1;
  return (major * rate) / baseRate;
}

/** "2026-07" for a unix seconds timestamp, in UTC. */
export function monthKey(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The last n month keys ending with the month that contains `now`. */
export function monthWindow(n, now = Date.now()) {
  const out = [];
  const d = new Date(now);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(d);
    m.setUTCMonth(m.getUTCMonth() - i);
    out.push(`${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/**
 * Build charge id -> product/price hints out of invoices and checkout sessions.
 * Both are optional. Missing data just means we fall back to text matching.
 */
export function buildHints({ invoices = [], sessions = [], charges = [] } = {}) {
  const hints = new Map(); // chargeId -> { products:Set, prices:Set, links:Set, text:Set }
  const ensure = (id) => {
    if (!hints.has(id)) {
      hints.set(id, { products: new Set(), prices: new Set(), links: new Set(), text: new Set() });
    }
    return hints.get(id);
  };

  for (const inv of invoices) {
    const chargeId = typeof inv.charge === 'string' ? inv.charge : inv.charge?.id;
    if (!chargeId) continue;
    const h = ensure(chargeId);
    for (const line of inv.lines?.data || []) {
      const price = line.price || line.pricing?.price_details || {};
      const productId = typeof price.product === 'string' ? price.product : price.product?.id;
      if (productId) h.products.add(productId);
      const priceId = typeof price.id === 'string' ? price.id : undefined;
      if (priceId) h.prices.add(priceId);
      if (line.description) h.text.add(String(line.description).toLowerCase());
    }
  }

  // payment_intent -> charge, so a checkout session can reach its charge
  const piToCharge = new Map();
  for (const ch of charges) {
    const pi = typeof ch.payment_intent === 'string' ? ch.payment_intent : ch.payment_intent?.id;
    if (pi) piToCharge.set(pi, ch.id);
  }

  for (const s of sessions) {
    const pi = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id;
    const chargeId = piToCharge.get(pi);
    if (!chargeId) continue;
    const h = ensure(chargeId);
    if (s.payment_link) h.links.add(typeof s.payment_link === 'string' ? s.payment_link : s.payment_link.id);
    for (const item of s.line_items?.data || []) {
      const price = item.price || {};
      const productId = typeof price.product === 'string' ? price.product : price.product?.id;
      if (productId) h.products.add(productId);
      if (price.id) h.prices.add(price.id);
      if (item.description) h.text.add(String(item.description).toLowerCase());
    }
  }

  return hints;
}

/** Everything we can read as text for one charge, lowercased. */
function textFor(charge, hint) {
  const bits = [
    charge.description,
    charge.statement_descriptor,
    charge.calculated_statement_descriptor,
    charge.invoice?.number,
    ...Object.values(charge.metadata || {})
  ];
  if (hint) bits.push(...hint.text);
  return bits.filter(Boolean).map((s) => String(s).toLowerCase());
}

/**
 * Decide which configured product a charge belongs to.
 * Rules are checked strongest first: stripe ids, then payment link, then
 * metadata, then free text. First product that matches wins, so order the
 * products array from most specific to least.
 */
export function matchProduct(charge, hint, products) {
  const hintProducts = hint ? [...hint.products] : [];
  const hintPrices = hint ? [...hint.prices] : [];
  const hintLinks = hint ? [...hint.links] : [];
  const texts = textFor(charge, hint);

  const checks = [
    (m) => (m.stripe_product || []).some((id) => hintProducts.includes(id)),
    (m) => (m.stripe_price || []).some((id) => hintPrices.includes(id)),
    (m) => (m.payment_link || []).some((id) => hintLinks.includes(id)),
    (m) => Object.entries(m.metadata || {}).some(
      ([k, v]) => String(charge.metadata?.[k] ?? '').toLowerCase() === String(v).toLowerCase()
    ),
    (m) => (m.description_contains || []).some(
      (needle) => texts.some((t) => t.includes(String(needle).toLowerCase()))
    )
  ];

  for (const check of checks) {
    for (const product of products) {
      if (check(product.match || {})) return product.id;
    }
  }
  return null;
}

/** Net amount of a charge in base currency, refunds and disputes removed. */
export function netOf(charge, money) {
  if (charge.status !== 'succeeded') return 0;
  if (charge.disputed && charge.dispute?.status === 'lost') return 0;
  const gross = charge.amount || 0;
  const refunded = charge.amount_refunded || 0;
  return convert(gross - refunded, charge.currency, money);
}

/** Monthly recurring revenue of one subscription item, normalised to a month. */
export function itemMrr(item, money) {
  const price = item.price || {};
  const recurring = price.recurring || {};
  const unit = price.unit_amount ?? price.unit_amount_decimal ?? 0;
  const qty = item.quantity ?? 1;
  const amount = convert(Number(unit) * qty, price.currency, money);
  const count = recurring.interval_count || 1;
  switch (recurring.interval) {
    case 'day': return (amount / count) * 30.44;
    case 'week': return (amount / count) * 4.348;
    case 'month': return amount / count;
    case 'year': return amount / (12 * count);
    default: return 0;
  }
}

/**
 * The whole thing. Returns the snapshot the front end renders.
 */
const round2 = (n) => Math.round(n * 100) / 100;

export function aggregate({
  charges = [],
  invoices = [],
  sessions = [],
  subscriptions = [],
  config,
  now = Date.now()
}) {
  const money = config.money || {};
  const products = config.products || [];
  const windowSize = money.window_months || 12;
  const months = monthWindow(windowSize, now);
  const monthSet = new Set(months);

  const blank = () => ({ months: Object.fromEntries(months.map((m) => [m, 0])), total: 0, mrr: 0, orders: 0 });
  const byProduct = Object.fromEntries(products.map((p) => [p.id, blank()]));
  const other = blank();
  const ignored = blank();
  const totals = { ...blank(), window_total: 0, last30: 0, prev30: 0 };
  const currencies = {};

  const hints = buildHints({ invoices, sessions, charges });
  const cutoff30 = now / 1000 - 30 * 86400;
  const cutoff60 = now / 1000 - 60 * 86400;

  const ignoreRules = config.ignore || {};
  const hasIgnoreRules = Object.values(ignoreRules).some((v) => (Array.isArray(v) ? v.length > 0 : Object.keys(v || {}).length > 0));
  const ignoreCheck = hasIgnoreRules ? [{ id: '__ignored__', match: ignoreRules }] : null;

  for (const charge of charges) {
    const net = netOf(charge, money);
    if (!net) continue;

    const hint = hints.get(charge.id);

    // Ignore rules win over everything, including a product match, so a
    // payment can be pulled out of a product's total the same way it was
    // matched into one: by writing a rule, not by deleting data.
    if (ignoreCheck && matchProduct(charge, hint, ignoreCheck)) {
      ignored.total += net;
      if (net > 0) ignored.orders += 1;
      const key = monthKey(charge.created);
      if (monthSet.has(key)) ignored.months[key] += net;
      continue;
    }

    const productId = matchProduct(charge, hint, products);
    const bucket = productId ? byProduct[productId] : other;
    if (!bucket) continue;

    bucket.total += net;
    totals.total += net;
    // A refund arrives as its own negative record, so it must not count as a sale.
    if (net > 0) {
      bucket.orders += 1;
      totals.orders += 1;
    }
    const code = String(charge.currency || '').toLowerCase();
    currencies[code] = round2((currencies[code] || 0) + net);

    const key = monthKey(charge.created);
    if (monthSet.has(key)) {
      bucket.months[key] += net;
      totals.months[key] += net;
      totals.window_total += net;
    }
    if (charge.created >= cutoff30) totals.last30 += net;
    else if (charge.created >= cutoff60) totals.prev30 += net;
  }

  for (const sub of subscriptions) {
    if (!['active', 'trialing', 'past_due'].includes(sub.status)) continue;
    for (const item of sub.items?.data || []) {
      const mrr = itemMrr(item, money);
      if (!mrr) continue;
      const priceId = item.price?.id;
      const productId = typeof item.price?.product === 'string' ? item.price.product : item.price?.product?.id;
      const hit = products.find((p) => {
        const m = p.match || {};
        return (m.stripe_price || []).includes(priceId) || (m.stripe_product || []).includes(productId);
      });
      const bucket = hit ? byProduct[hit.id] : other;
      bucket.mrr += mrr;
      totals.mrr += mrr;
    }
  }

  const round = round2;
  const finish = (b) => ({
    total: round(b.total),
    mrr: round(b.mrr),
    orders: b.orders,
    months: Object.fromEntries(Object.entries(b.months).map(([k, v]) => [k, round(v)]))
  });

  return {
    generated_at: new Date(now).toISOString(),
    currency: (money.base_currency || 'eur').toLowerCase(),
    months,
    totals: {
      ...finish(totals),
      window_total: round(totals.window_total),
      last30: round(totals.last30),
      prev30: round(totals.prev30),
      change30: totals.prev30 > 0 ? round(((totals.last30 - totals.prev30) / totals.prev30) * 100) : null
    },
    products: Object.fromEntries(Object.entries(byProduct).map(([id, b]) => [id, finish(b)])),
    other: finish(other),
    ignored: finish(ignored),
    currencies
  };
}
