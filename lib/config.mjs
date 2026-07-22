import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CANDIDATES = [
  path.join(process.cwd(), 'site.config.json'),
  path.join(process.cwd(), 'public', 'site.config.json'),
  path.join(HERE, '..', 'site.config.json'),
  path.join(HERE, '..', '..', 'site.config.json'),
  path.join(HERE, '..', '..', '..', 'site.config.json')
];

let cached;

export async function loadConfig({ force = false } = {}) {
  if (cached && !force) return cached;
  for (const candidate of CANDIDATES) {
    try {
      cached = JSON.parse(await fs.readFile(candidate, 'utf8'));
      return cached;
    } catch { /* try the next path */ }
  }
  throw new Error(
    'site.config.json not found. Check that netlify.toml includes it under [functions] included_files.'
  );
}

/** Products can be given as ids only; this fills in the defaults. */
export function normalise(config) {
  return {
    ...config,
    products: (config.products || []).map((p) => ({
      revenue_display: 'total',
      match: {},
      ...p
    }))
  };
}
