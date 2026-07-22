import { json, requireAdmin } from '../../lib/http.mjs';
import { runSync, rebuild, refreshRates } from '../../lib/sync.mjs';

/**
 * Admin only.
 *   POST /api/sync            pull new payments from Stripe and PayPal
 *   POST /api/sync?full=1     reread the whole history
 *   POST /api/sync?rebuild=1  redo matching on stored data, no network calls
 *   POST /api/sync?rates=1    refresh exchange rates now
 */
export default async (req) => {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const url = new URL(req.url);
  if (url.searchParams.get('rates') === '1') {
    const result = await refreshRates();
    return json(result, { status: result.ok ? 200 : 502 });
  }

  if (url.searchParams.get('rebuild') === '1') {
    const snapshot = await rebuild();
    return json({ ok: true, mode: 'rebuild', snapshot });
  }

  const budgetMs = Math.min(Number(url.searchParams.get('budget')) || 20000, 600000);
  const full = url.searchParams.get('full') === '1';

  try {
    const result = await runSync({ budgetMs, full });
    return json(result, { status: result.ok ? 200 : 400 });
  } catch (err) {
    return json({ ok: false, error: err.message, code: err.code || null }, { status: 500 });
  }
};

export const config = { path: '/api/sync' };
