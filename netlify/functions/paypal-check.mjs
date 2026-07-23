import { json, requireAdmin } from '../../lib/http.mjs';
import { paypalAccounts, earliestSearchable, MAX_HISTORY_DAYS } from '../../lib/paypal-client.mjs';

/**
 * Admin only. Tests PayPal credentials on their own, with no Stripe involved
 * and nothing written to storage. Three checks: get an access token, search a
 * recent window, and search near PayPal's 3 year limit. "Not retrieved" can
 * mean several different things and each has a different fix, so this reports
 * exactly which step failed rather than one generic error.
 */
export default async (req) => {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const accounts = paypalAccounts(process.env);
  if (accounts.length === 0) {
    return json({
      ok: false,
      step: 'configuration',
      error: 'No PayPal credentials found. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in the Netlify environment variables, then redeploy so the function picks them up.'
    });
  }

  const results = [];
  for (const paypal of accounts) {
    const result = { account: paypal.label };

    try {
      await paypal.accessToken();
      result.auth = 'ok';
    } catch (err) {
      result.auth = 'failed';
      result.step = 'authentication';
      result.error = /invalid_client|Client Authentication failed/i.test(err.message)
        ? 'The Client ID or Secret is wrong, or they are Sandbox credentials while PAYPAL_ENV is set to live (or the other way round).'
        : err.message;
      results.push(result);
      continue;
    }

    // PayPal cannot reliably search transactions from the last few hours, so
    // the window ends 3 hours ago rather than at this exact second.
    const now = Math.floor(Date.now() / 1000);
    try {
      const res = await paypal.transactions({ since: now - 7 * 86400, until: now - 3 * 3600, deadline: Date.now() + 15000 });
      result.search = 'ok';
      result.transactions_last_7_days = res.data.length;
      result.sample = res.data.slice(0, 3).map((t) => ({ id: t.id, amount: t.amount / 100, currency: t.currency, description: t.description, created: new Date(t.created * 1000).toISOString() }));
      if (res.data.length === 0) {
        result.note = 'Authenticated fine, but zero transactions in the last 7 days. This is only a quick recent-window check, not the range the real sync uses, so it does not mean older history is unreachable.';
      }
    } catch (err) {
      result.search = 'failed';
      result.step = 'transaction search';
      result.error = /403|Transaction Search/i.test(err.message)
        ? err.message
        : `${err.message}. Check that the app used for these credentials has Transaction Search ticked on under its Features in the PayPal developer dashboard.`;
      results.push(result);
      continue;
    }

    // A separate check near the 3 year edge, since that is what a full resync
    // actually depends on and a recent-window success alone does not prove it.
    try {
      const start = earliestSearchable(Date.now());
      const res = await paypal.transactions({ since: start, until: start + 7 * 86400, deadline: Date.now() + 15000 });
      result.deep_history = 'ok';
      result.deep_history_days = MAX_HISTORY_DAYS;
    } catch (err) {
      result.deep_history = 'failed';
      result.deep_history_error = err.message;
    }

    results.push(result);
  }

  return json({
    ok: results.every((r) => r.auth === 'ok' && r.search === 'ok'),
    env: process.env.PAYPAL_ENV || 'live',
    max_history_days: MAX_HISTORY_DAYS,
    results
  });
};

export const config = { path: '/api/paypal-check' };

