import { stripeAccounts } from './stripe-client.mjs';
import { paypalAccounts } from './paypal-client.mjs';
import { fetchRates, mergeRates } from './fx.mjs';
import { openStore } from './store.mjs';
import { loadConfig, normalise } from './config.mjs';
import { aggregate, monthWindow } from './aggregate.mjs';

const LEDGER = 'ledger';
const FX = 'fx';
const STATE = 'state';
const SNAPSHOT = 'snapshot';

/** Only keep the fields the aggregator reads. A full charge object is 20x this. */
function slimCharge(c) {
  return {
    id: c.id,
    created: c.created,
    amount: c.amount,
    amount_refunded: c.amount_refunded,
    currency: c.currency,
    status: c.status,
    disputed: c.disputed || false,
    description: c.description || null,
    statement_descriptor: c.statement_descriptor || null,
    calculated_statement_descriptor: c.calculated_statement_descriptor || null,
    invoice: typeof c.invoice === 'string' ? c.invoice : c.invoice?.id || null,
    payment_intent: typeof c.payment_intent === 'string' ? c.payment_intent : c.payment_intent?.id || null,
    metadata: c.metadata || {}
  };
}

function slimSubscription(s) {
  return {
    id: s.id,
    status: s.status,
    items: {
      data: (s.items?.data || []).map((i) => ({
        quantity: i.quantity,
        price: {
          id: i.price?.id,
          product: typeof i.price?.product === 'string' ? i.price.product : i.price?.product?.id,
          currency: i.price?.currency,
          unit_amount: i.price?.unit_amount,
          recurring: i.price?.recurring ? { interval: i.price.recurring.interval, interval_count: i.price.recurring.interval_count } : null
        }
      }))
    }
  };
}

function emptyLedger() {
  return { charges: {}, invoices: [], sessions: [], subscriptions: [], watermark: 0, last_full: 0 };
}

/**
 * Checkout sessions with line items expanded. Stripe caps the page size when
 * line_items are expanded, and older keys may not allow the expand at all, so
 * this steps down instead of failing the whole sync.
 */
async function listSessions(stripe, params, opts) {
  const attempts = [
    { limit: 100, expand: ['data.line_items'] },
    { limit: 20, expand: ['data.line_items'] },
    { limit: 100 }
  ];
  let lastError;
  for (const extra of attempts) {
    try {
      return await stripe.list('/checkout/sessions', { ...params, ...extra }, opts);
    } catch (err) {
      lastError = err;
      if (err.status !== 400) throw err;
    }
  }
  throw lastError;
}

/**
 * Pull from every configured account. Stops when the budget runs out and saves
 * where it stopped, so the next call picks up from there. Returns a report.
 */
export async function runSync({
  env = process.env,
  budgetMs = 20000,
  full = false,
  now = Date.now(),
  fetchImpl,
  storeName = 'receipts'
} = {}) {
  const deadline = Date.now() + budgetMs;
  const config = normalise(await loadConfig({ force: true }));
  const store = await openStore(storeName);
  const accounts = stripeAccounts(env, { fetchImpl });

  if (accounts.length === 0 && paypalAccounts(env, { fetchImpl }).length === 0) {
    return {
      ok: false,
      error: 'No payment account configured. Add STRIPE_SECRET_KEY, or PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, in the Netlify environment variables.'
    };
  }

  // The chart shows window_months. The ledger keeps history_months so the
  // lifetime total on the page goes back further than the chart does.
  const historyMonths = Math.max(config.money?.history_months || 48, config.money?.window_months || 12);
  const history = monthWindow(historyMonths, now);
  const windowStart = Math.floor(new Date(`${history[0]}-01T00:00:00Z`).getTime() / 1000);

  const state = (await store.get(STATE)) || { accounts: {} };
  const report = { accounts: [], complete: true, started_at: new Date(now).toISOString() };

  for (const stripe of accounts) {
    const key = stripe.label;
    const ledger = (await store.get(`${LEDGER}_${key}`)) || emptyLedger();
    const accountState = state.accounts[key] || {};
    const doFull = full || !ledger.watermark || (now - (ledger.last_full || 0)) > 7 * 86400 * 1000;

    // Incremental runs still re-read the last 45 days so refunds land.
    const since = doFull ? windowStart : Math.max(windowStart, Math.floor(ledger.watermark / 1000) - 45 * 86400);
    const accountReport = { account: key, since, full: doFull, fetched: {}, complete: true };

    // ---- charges -------------------------------------------------------
    if (!accountState.charges_complete || doFull) {
      const res = await stripe.list(
        '/charges',
        { created: { gte: since } },
        { deadline, startingAfter: accountState.charges_cursor }
      );
      for (const c of res.data) ledger.charges[c.id] = slimCharge(c);
      accountState.charges_cursor = res.complete ? undefined : res.cursor;
      accountState.charges_complete = res.complete;
      accountReport.fetched.charges = res.data.length;
      accountReport.complete = accountReport.complete && res.complete;
    }

    // ---- invoices (gives product ids for subscription and invoiced sales)
    if (accountReport.complete && (!accountState.invoices_complete || doFull)) {
      try {
        const res = await stripe.list(
          '/invoices',
          { created: { gte: since }, status: 'paid' },
          { deadline, startingAfter: accountState.invoices_cursor }
        );
        const seen = new Set(ledger.invoices.map((i) => i.id));
        for (const inv of res.data) {
          if (seen.has(inv.id)) continue;
          ledger.invoices.push({
            id: inv.id,
            charge: typeof inv.charge === 'string' ? inv.charge : inv.charge?.id || null,
            lines: {
              data: (inv.lines?.data || []).map((l) => ({
                description: l.description || null,
                price: l.price ? { id: l.price.id, product: typeof l.price.product === 'string' ? l.price.product : l.price.product?.id } : null
              }))
            }
          });
        }
        accountState.invoices_cursor = res.complete ? undefined : res.cursor;
        accountState.invoices_complete = res.complete;
        accountReport.fetched.invoices = res.data.length;
        accountReport.complete = accountReport.complete && res.complete;
      } catch (err) {
        accountReport.invoices_error = err.message;
        accountState.invoices_complete = true; // read access missing: carry on without it
      }
    }

    // ---- checkout sessions (product ids for one off Checkout payments) --
    if (accountReport.complete && (!accountState.sessions_complete || doFull)) {
      try {
        const res = await listSessions(
          stripe,
          { created: { gte: since }, status: 'complete' },
          { deadline, startingAfter: accountState.sessions_cursor }
        );
        const seen = new Set(ledger.sessions.map((s) => s.id));
        for (const s of res.data) {
          if (seen.has(s.id)) continue;
          ledger.sessions.push({
            id: s.id,
            payment_intent: typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id || null,
            payment_link: typeof s.payment_link === 'string' ? s.payment_link : s.payment_link?.id || null,
            line_items: {
              data: (s.line_items?.data || []).map((i) => ({
                description: i.description || null,
                price: i.price ? { id: i.price.id, product: typeof i.price.product === 'string' ? i.price.product : i.price.product?.id } : null
              }))
            }
          });
        }
        accountState.sessions_cursor = res.complete ? undefined : res.cursor;
        accountState.sessions_complete = res.complete;
        accountReport.fetched.sessions = res.data.length;
        accountReport.complete = accountReport.complete && res.complete;
      } catch (err) {
        accountReport.sessions_error = err.message;
        accountState.sessions_complete = true;
      }
    }

    // ---- active subscriptions for MRR ----------------------------------
    if (accountReport.complete) {
      try {
        const res = await stripe.list('/subscriptions', { status: 'active' }, { deadline });
        if (res.complete) ledger.subscriptions = res.data.map(slimSubscription);
        accountReport.fetched.subscriptions = res.data.length;
      } catch (err) {
        accountReport.subscriptions_error = err.message;
      }
    }

    if (accountReport.complete) {
      ledger.watermark = now;
      if (doFull) ledger.last_full = now;
      accountState.charges_complete = false; // next run starts a fresh incremental pass
      accountState.invoices_complete = false;
      accountState.sessions_complete = false;
      accountState.charges_cursor = undefined;
      accountState.invoices_cursor = undefined;
      accountState.sessions_cursor = undefined;
    }

    // Drop anything older than the window so the ledger cannot grow forever.
    for (const [id, c] of Object.entries(ledger.charges)) {
      if (c.created < windowStart - 86400) delete ledger.charges[id];
    }

    await store.set(`${LEDGER}_${key}`, ledger);
    state.accounts[key] = accountState;
    report.accounts.push(accountReport);
    report.complete = report.complete && accountReport.complete;
  }

  // ---- PayPal, normalised into the same charge shape as Stripe ---------
  for (const paypal of paypalAccounts(env, { fetchImpl })) {
    const key = paypal.label;
    const ledger = (await store.get(`${LEDGER}_${key}`)) || emptyLedger();
    const accountState = state.accounts[key] || {};
    const doFull = full || !ledger.watermark;
    const since = doFull ? windowStart : Math.max(windowStart, Math.floor(ledger.watermark / 1000) - 45 * 86400);
    const accountReport = { account: key, since, full: doFull, fetched: {}, complete: true };

    try {
      const res = await paypal.transactions({
        since,
        deadline,
        startChunk: accountState.paypal_chunk || 0
      });
      for (const record of res.data) ledger.charges[record.id] = record;
      accountState.paypal_chunk = res.complete ? 0 : res.stoppedAt;
      accountReport.fetched.transactions = res.data.length;
      accountReport.complete = res.complete;
      if (res.complete) ledger.watermark = now;
    } catch (err) {
      accountReport.error = err.message;
      accountReport.complete = true; // do not wedge the whole sync on PayPal
    }

    for (const [id, c] of Object.entries(ledger.charges)) {
      if (c.created < windowStart - 86400) delete ledger.charges[id];
    }

    await store.set(`${LEDGER}_${key}`, ledger);
    state.accounts[key] = accountState;
    report.accounts.push(accountReport);
    report.complete = report.complete && accountReport.complete;
  }

  await store.set(STATE, state);
  const snapshot = await rebuild({ store, config, now });

  return {
    ok: true,
    ...report,
    complete: report.complete,
    note: report.complete ? 'Sync finished.' : 'Budget ran out. Run it again to continue where it stopped.',
    snapshot
  };
}

/**
 * Re-run the maths on the stored ledger. No Stripe calls, so this is instant
 * and is what happens when matching rules in site.config.json change.
 */
export async function rebuild({ store, config, now = Date.now() } = {}) {
  const s = store || (await openStore('receipts'));
  const cfg = config || normalise(await loadConfig({ force: true }));
  const state = (await s.get(STATE)) || { accounts: {} };
  const labels = Object.keys(state.accounts).length ? Object.keys(state.accounts) : ['account_1'];

  const charges = [];
  const invoices = [];
  const sessions = [];
  const subscriptions = [];

  for (const label of labels) {
    const ledger = await s.get(`${LEDGER}_${label}`);
    if (!ledger) continue;
    charges.push(...Object.values(ledger.charges || {}));
    invoices.push(...(ledger.invoices || []));
    sessions.push(...(ledger.sessions || []));
    subscriptions.push(...(ledger.subscriptions || []));
  }

  const storedFx = await s.get(FX);
  const money = { ...(cfg.money || {}), rates: mergeRates(cfg.money, storedFx) };
  const snapshot = aggregate({ charges, invoices, sessions, subscriptions, config: { ...cfg, money }, now });

  snapshot.source = charges.length ? 'live' : 'empty';
  snapshot.fx = storedFx
    ? { base: storedFx.base, rates: storedFx.rates, date: storedFx.date, source: storedFx.source }
    : { base: (cfg.money?.base_currency || 'usd').toLowerCase(), rates: money.rates, date: null, source: 'site.config.json' };
  snapshot.providers = [...new Set(charges.map((c) => c.source || 'stripe'))];
  await s.set(SNAPSHOT, snapshot);
  return snapshot;
}

/**
 * Pulls today's exchange rates and recomputes the page with them.
 * Runs on its own every day, and from the button in the admin panel.
 */
export async function refreshRates({ fetchImpl, now = Date.now() } = {}) {
  const config = normalise(await loadConfig({ force: true }));
  const store = await openStore('receipts');
  const base = (config.money?.base_currency || 'usd').toLowerCase();
  const symbols = Object.keys(config.money?.rates || {});

  try {
    const fx = await fetchRates(base, symbols, { fetchImpl });
    await store.set(FX, fx);
    const snapshot = await rebuild({ store, config, now });
    return { ok: true, fx, note: `Rates from ${fx.source}, dated ${fx.date}.`, snapshot };
  } catch (err) {
    const previous = await store.get(FX);
    return {
      ok: false,
      error: err.message,
      note: previous
        ? `Kept the rates from ${previous.date}. The page is still correct, just not refreshed today.`
        : 'Falling back to the rates written in site.config.json.'
    };
  }
}

export async function readSnapshot() {
  const store = await openStore('receipts');
  return store.get(SNAPSHOT);
}
