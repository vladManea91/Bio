import { json, readJson, rateLimit, clientIp } from '../../lib/http.mjs';
import { openStore } from '../../lib/store.mjs';

const day = () => new Date().toISOString().slice(0, 10);

/** Views and clicks, counted in aggregate. No cookies, no personal data. */
export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, { status: 405 });

  const ip = clientIp(req);
  if (!rateLimit(`track:${ip}`, { max: 60, windowMs: 60000 })) return json({ ok: true });

  const body = await readJson(req);
  const kind = body.kind === 'click' ? 'click' : 'view';
  const target = String(body.target || 'page').slice(0, 80);
  const source = String(body.source || 'direct').slice(0, 60);

  const store = await openStore('receipts');
  const key = `analytics_${day()}`;
  const stats = (await store.get(key)) || { views: 0, clicks: {}, sources: {}, countries: {} };

  if (kind === 'view') stats.views += 1;
  else stats.clicks[target] = (stats.clicks[target] || 0) + 1;
  stats.sources[source] = (stats.sources[source] || 0) + 1;

  const country = req.headers.get('x-nf-geo')
    ? JSON.parse(req.headers.get('x-nf-geo') || '{}')?.country?.code
    : null;
  if (country) stats.countries[country] = (stats.countries[country] || 0) + 1;

  await store.set(key, stats);
  return json({ ok: true });
};

export const config = { path: '/api/track' };
