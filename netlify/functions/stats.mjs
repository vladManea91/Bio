import { json, requireAdmin } from '../../lib/http.mjs';
import { openStore } from '../../lib/store.mjs';

/** Admin only. Last 30 days of traffic, rolled up. */
export default async (req) => {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const store = await openStore('receipts');
  const days = [];
  const totals = { views: 0, clicks: {}, sources: {}, countries: {} };

  for (let i = 0; i < 30; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const stats = await store.get(`analytics_${d}`);
    if (!stats) {
      days.push({ date: d, views: 0, clicks: 0 });
      continue;
    }
    const clickCount = Object.values(stats.clicks || {}).reduce((a, b) => a + b, 0);
    days.push({ date: d, views: stats.views || 0, clicks: clickCount });
    totals.views += stats.views || 0;
    for (const [k, v] of Object.entries(stats.clicks || {})) totals.clicks[k] = (totals.clicks[k] || 0) + v;
    for (const [k, v] of Object.entries(stats.sources || {})) totals.sources[k] = (totals.sources[k] || 0) + v;
    for (const [k, v] of Object.entries(stats.countries || {})) totals.countries[k] = (totals.countries[k] || 0) + v;
  }

  const subscribers = (await store.get('subscribers')) || { people: [] };
  return json({ days: days.reverse(), totals, subscribers: subscribers.people.length });
};

export const config = { path: '/api/stats' };
