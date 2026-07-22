/**
 * A small Stripe client built on fetch. No SDK, so nothing to bundle and
 * nothing to break on a Netlify runtime upgrade.
 */

const API = 'https://api.stripe.com/v1';

function encode(params, prefix = '') {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((v) => parts.push(`${encodeURIComponent(name)}[]=${encodeURIComponent(v)}`));
    } else if (typeof value === 'object') {
      parts.push(encode(value, name));
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.filter(Boolean).join('&');
}

export class StripeError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'StripeError';
    this.status = status;
    this.code = code;
  }
}

export function createStripe(secretKey, { fetchImpl = fetch, label = 'stripe' } = {}) {
  if (!secretKey) throw new Error('Stripe secret key missing');

  async function request(method, path, params = {}, attempt = 0) {
    const query = method === 'GET' ? encode(params) : '';
    const url = `${API}${path}${query ? `?${query}` : ''}`;
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Stripe-Version': '2024-06-20',
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
      },
      body: method === 'POST' ? encode(params) : undefined
    });

    if (res.status === 429 || res.status >= 500) {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        return request(method, path, params, attempt + 1);
      }
    }

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = body.error || {};
      throw new StripeError(err.message || `Stripe ${res.status} on ${path}`, res.status, err.code);
    }
    return body;
  }

  /**
   * Page through a list endpoint. Stops when the deadline passes and reports
   * back where it got to, so a caller on a short function timeout can resume.
   */
  async function list(path, params = {}, { deadline = Infinity, max = 10000, startingAfter } = {}) {
    const data = [];
    let cursor = startingAfter;
    let complete = false;

    while (data.length < max) {
      if (Date.now() > deadline) break;
      const page = await request('GET', path, { limit: 100, ...params, starting_after: cursor });
      data.push(...page.data);
      if (!page.has_more || page.data.length === 0) {
        complete = true;
        break;
      }
      cursor = page.data[page.data.length - 1].id;
    }
    return { data, complete, cursor, label };
  }

  return {
    label,
    request,
    list,
    get: (path, params) => request('GET', path, params),
    post: (path, params) => request('POST', path, params)
  };
}

/**
 * Read every configured Stripe account. Supports one key or many:
 *   STRIPE_SECRET_KEY, STRIPE_SECRET_KEY_2 ... STRIPE_SECRET_KEY_9
 *   or STRIPE_SECRET_KEYS="rk_live_a,rk_live_b"
 */
export function stripeAccounts(env = process.env, { fetchImpl } = {}) {
  const keys = [];
  if (env.STRIPE_SECRET_KEYS) {
    env.STRIPE_SECRET_KEYS.split(',').map((s) => s.trim()).filter(Boolean).forEach((k) => keys.push(k));
  }
  if (env.STRIPE_SECRET_KEY) keys.push(env.STRIPE_SECRET_KEY.trim());
  for (let i = 2; i <= 9; i++) {
    const k = env[`STRIPE_SECRET_KEY_${i}`];
    if (k) keys.push(k.trim());
  }
  const unique = [...new Set(keys)];
  return unique.map((key, i) => createStripe(key, { fetchImpl, label: `account_${i + 1}` }));
}
