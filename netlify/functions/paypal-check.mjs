import { json, requireAdmin } from '../../lib/http.mjs';
import { paypalAccounts } from '../../lib/paypal-client.mjs';

/**
 * Admin only. Tests PayPal credentials on their own, with no Stripe involved
 * and nothing written to storage. Two calls: get an access token, then ask
 * for one day of transactions. Reports exactly which step failed and why,
 * since "not retrieved" can mean five different things and only one of them
 * is fixed the same way.
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
        result.note = 'Authenticated fine, but zero transactions in the last 7 days. If you know a sale happened recently, PayPal can take up to 3 hours to make it searchable, or Transaction Search may not be fully active yet even though it is ticked on.';
      }
    } catch (err) {
      result.search = 'failed';
      result.step = 'transaction search';
      result.error = /403|Transaction Search/i.test(err.message)
        ? err.message
        : `${err.message}. Check that the app used for these credentials has Transaction Search ticked on under its Features in the PayPal developer dashboard.`;
    }

    results.push(result);
  }

  return json({ ok: results.every((r) => r.auth === 'ok' && r.search === 'ok'), env: process.env.PAYPAL_ENV || 'live', results });
};

export const config = { path: '/api/paypal-check' };
