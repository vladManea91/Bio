import { refreshRates } from '../../lib/sync.mjs';

/** Runs every day at 12:00 UTC. Pulls today's rates and recomputes the page. */
export default async () => {
  const result = await refreshRates();
  console.log('[rates]', JSON.stringify({ ok: result.ok, note: result.note, error: result.error }));
};

export const config = { schedule: '0 12 * * *' };
