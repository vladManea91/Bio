import { runSync } from '../../lib/sync.mjs';

/** Runs on its own every hour. Keeps the page fresh without anyone clicking. */
export default async () => {
  try {
    const result = await runSync({ budgetMs: 20000 });
    console.log('[cron] sync', JSON.stringify({ ok: result.ok, complete: result.complete, error: result.error }));
  } catch (err) {
    console.error('[cron] sync failed', err.message);
  }
};

export const config = { schedule: '17 * * * *' };
