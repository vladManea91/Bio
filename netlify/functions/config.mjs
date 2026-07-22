import { json, requireAdmin, readJson } from '../../lib/http.mjs';
import { loadLiveConfig, saveConfig, resetConfig, displayConfig, validateConfig, revisionOf } from '../../lib/config.mjs';
import { rebuild } from '../../lib/sync.mjs';

/**
 * GET  /api/config          what the public page needs, no token
 * GET  /api/config?full=1   everything including matching rules, admin only
 * POST /api/config          save, admin only, then recompute the page
 * POST /api/config?reset=1  throw away admin edits, go back to site.config.json
 */
export default async (req) => {
  const url = new URL(req.url);

  if (req.method === 'GET') {
    if (url.searchParams.get('full') === '1') {
      const denied = requireAdmin(req);
      if (denied) return denied;
      return json(await loadLiveConfig({ force: true }));
    }
    const display = displayConfig(await loadLiveConfig({ force: true }));
    display.revision = display.revision || revisionOf(display);
    return json(display, { cache: 'public, max-age=30, stale-while-revalidate=300' });
  }

  if (req.method !== 'POST') return json({ error: 'Use GET or POST.' }, { status: 405 });

  const denied = requireAdmin(req);
  if (denied) return denied;

  if (url.searchParams.get('reset') === '1') {
    const config = await resetConfig();
    const snapshot = await rebuild();
    return json({ ok: true, reset: true, config, snapshot });
  }

  const body = await readJson(req);
  const problems = validateConfig(body);
  if (problems.length) return json({ error: problems.join(' '), problems }, { status: 400 });

  const config = await saveConfig(body);
  // Matching rules may have changed, so the numbers are recomputed straight away.
  const snapshot = await rebuild({ config });

  return json({ ok: true, revision: config.revision, config, snapshot });
};

export const config = { path: '/api/config' };
