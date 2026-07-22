import { json } from '../../lib/http.mjs';
import { readSnapshot } from '../../lib/sync.mjs';
import { loadLiveConfig } from '../../lib/config.mjs';
import { monthWindow } from '../../lib/aggregate.mjs';

/** Public read. Never calls Stripe, only reads the snapshot the sync wrote. */
export default async () => {
  const site = await loadLiveConfig();
  const snapshot = await readSnapshot();

  if (!snapshot) {
    const months = monthWindow(site.money?.window_months || 12);
    return json(
      {
        source: 'empty',
        currency: (site.money?.base_currency || 'eur').toLowerCase(),
        months,
        totals: { total: 0, mrr: 0, orders: 0, window_total: 0, last30: 0, prev30: 0, change30: null, months: {} },
        products: {},
        other: { total: 0, mrr: 0, orders: 0, months: {} },
        message: 'No Stripe data yet. Open /admin.html and run a sync.'
      },
      { cache: 'public, max-age=60' }
    );
  }

  return json(snapshot, { cache: 'public, max-age=300, stale-while-revalidate=3600' });
};

export const config = { path: '/api/revenue' };
