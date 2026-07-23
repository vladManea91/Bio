/**
 * PayPal, read through the Transaction Search API.
 *
 * The closest thing PayPal has to a Stripe restricted key is a REST app's
 * Client ID and Secret with the Transaction Search feature ticked on. Those
 * exchange for a short lived access token, and that token can read your
 * transaction history.
 *
 * Two things to know, both from PayPal's own docs: a transaction can take up
 * to three hours to appear, and the history only goes back three years. Also,
 * if the app existed before you ticked Transaction Search, the permission can
 * take several hours to start working.
 *
 * Every transaction is converted into the same shape as a Stripe charge, so
 * the matching rules and the money maths do not care where a sale came from.
 */

const HOSTS = {
  live: 'https://api-m.paypal.com',
  sandbox: 'https://api-m.sandbox.paypal.com'
};

/**
 * PayPal's Transaction Search refuses any start_date older than 3 years with
 * a generic "malformed request" error that gives no hint it is a date
 * problem. This stays a few days under the real limit as a safety margin.
 */
export const MAX_HISTORY_DAYS = 1085;

/** The oldest moment PayPal will let a search start from, right now. */
export function earliestSearchable(now = Date.now()) {
  return Math.floor(now / 1000) - MAX_HISTORY_DAYS * 86400;
}

const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);

/** PayPal sends amounts as decimal strings. Stripe style minor units here. */
export function toMinor(value, currency) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return ZERO_DECIMAL.has(String(currency || '').toLowerCase()) ? Math.round(n) : Math.round(n * 100);
}

/** Split a range into chunks PayPal will accept. Its limit is 31 days. */
export function dateChunks(fromSeconds, toSeconds, days = 30) {
  const chunks = [];
  const step = days * 86400;
  for (let start = fromSeconds; start < toSeconds; start += step) {
    chunks.push({ start, end: Math.min(start + step, toSeconds) });
  }
  return chunks;
}

const iso = (seconds) => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * One PayPal transaction becomes one charge-like record. Refunds arrive as
 * their own transaction with a negative amount, which subtracts naturally.
 */
export function normalise(entry) {
  const info = entry.transaction_info || {};
  const items = entry.cart_info?.item_details || [];
  const currency = String(info.transaction_amount?.currency_code || 'usd').toLowerCase();
  const amount = toMinor(info.transaction_amount?.value, currency);
  if (!info.transaction_id || amount === 0) return null;

  const itemNames = items.map((i) => i.item_name).filter(Boolean);
  const description =
    info.transaction_subject ||
    itemNames[0] ||
    info.transaction_note ||
    items.map((i) => i.item_description).filter(Boolean)[0] ||
    null;

  const created = Math.floor(new Date(info.transaction_initiation_date || info.transaction_updated_date || Date.now()).getTime() / 1000);

  return {
    id: `pp_${info.transaction_id}`,
    created,
    amount,
    amount_refunded: 0,
    currency,
    // Only settled money counts. Pending, denied and reversed are skipped by the caller.
    status: 'succeeded',
    disputed: false,
    description,
    statement_descriptor: null,
    calculated_statement_descriptor: null,
    invoice: null,
    payment_intent: null,
    source: 'paypal',
    metadata: {
      paypal_event: info.transaction_event_code || '',
      invoice_id: info.invoice_id || '',
      custom_field: info.custom_field || '',
      items: itemNames.join(' | ')
    }
  };
}

export function createPayPal(clientId, clientSecret, { fetchImpl = fetch, env = 'live', label = 'paypal' } = {}) {
  if (!clientId || !clientSecret) throw new Error('PayPal client id and secret are both required');
  const host = HOSTS[env] || HOSTS.live;
  let token = null;
  let tokenExpires = 0;

  async function accessToken() {
    if (token && Date.now() < tokenExpires) return token;
    const res = await fetchImpl(`${host}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new Error(body.error_description || `PayPal refused the credentials (${res.status})`);
    }
    token = body.access_token;
    tokenExpires = Date.now() + Math.max((body.expires_in || 3600) - 60, 60) * 1000;
    return token;
  }

  async function get(path, params = {}) {
    const url = new URL(host + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${await accessToken()}`, Accept: 'application/json' }
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = body.message || body.error_description || `PayPal ${res.status}`;
      let message = detail;
      if (res.status === 403) {
        message = `${detail}. Tick Transaction Search on your REST app in the PayPal dashboard. A newly ticked permission can take a few hours to start working.`;
      } else if (res.status === 400 && path.includes('/reporting/transactions')) {
        message = `${detail}. PayPal Transaction Search will not go back more than 3 years, and will not search the last few hours either. If this keeps happening, it is likely one of those two limits rather than a credentials problem.`;
      }
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  /**
   * Walks the whole range in 30 day chunks, paging inside each one. Stops at
   * the deadline and reports where it stopped so the next run resumes.
   */
  async function transactions({ since, until = Math.floor(Date.now() / 1000), deadline = Infinity, startChunk = 0 } = {}) {
    const chunks = dateChunks(since, until);
    const data = [];
    let complete = true;
    let stoppedAt = startChunk;

    for (let c = startChunk; c < chunks.length; c++) {
      if (Date.now() > deadline) {
        complete = false;
        stoppedAt = c;
        break;
      }
      stoppedAt = c;
      let page = 1;
      let totalPages = 1;
      do {
        const body = await get('/v1/reporting/transactions', {
          start_date: iso(chunks[c].start),
          end_date: iso(chunks[c].end),
          fields: 'transaction_info,cart_info',
          page_size: 500,
          page
        });
        for (const entry of body.transaction_details || []) {
          if ((entry.transaction_info?.transaction_status || 'S') !== 'S') continue;
          const record = normalise(entry);
          if (record) data.push(record);
        }
        totalPages = body.total_pages || 1;
        page += 1;
      } while (page <= totalPages && Date.now() <= deadline);
      if (page <= totalPages) {
        complete = false;
        break;
      }
      stoppedAt = c + 1;
    }

    return { data, complete, stoppedAt, label };
  }

  return { label, transactions, accessToken };
}

/**
 * Reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET, plus _2 ... _9 for extra
 * accounts. Returns an empty array when PayPal is not configured, which is the
 * normal case for a Stripe only setup.
 */
export function paypalAccounts(env = process.env, { fetchImpl } = {}) {
  const accounts = [];
  const mode = (env.PAYPAL_ENV || 'live').toLowerCase();
  const add = (id, secret, i) => {
    if (!id || !secret) return;
    accounts.push(createPayPal(id.trim(), secret.trim(), { fetchImpl, env: mode, label: `paypal_${i}` }));
  };
  add(env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET, 1);
  for (let i = 2; i <= 9; i++) add(env[`PAYPAL_CLIENT_ID_${i}`], env[`PAYPAL_CLIENT_SECRET_${i}`], i);
  return accounts;
}
