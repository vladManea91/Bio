/**
 * Configuration comes from two places:
 *   site.config.json   the file in the repo, the starting point
 *   the blob store     whatever you last saved in the admin panel
 *
 * The saved version wins. That is what lets you change your links, your video
 * and your matching rules from the admin panel without a redeploy.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEY = 'config';

const CANDIDATES = [
  path.join(process.cwd(), 'site.config.json'),
  path.join(process.cwd(), 'public', 'site.config.json'),
  path.join(HERE, '..', 'site.config.json'),
  path.join(HERE, '..', '..', 'site.config.json'),
  path.join(HERE, '..', '..', '..', 'site.config.json')
];

let cachedFile;

/** The file in the repo. */
export async function loadConfig({ force = false } = {}) {
  if (cachedFile && !force) return cachedFile;
  for (const candidate of CANDIDATES) {
    try {
      cachedFile = JSON.parse(await fs.readFile(candidate, 'utf8'));
      return cachedFile;
    } catch { /* try the next path */ }
  }
  throw new Error('site.config.json not found. Check [functions] included_files in netlify.toml.');
}

/** The file, with anything saved from the admin panel layered on top. */
export async function loadLiveConfig({ store, force = false } = {}) {
  const file = await loadConfig({ force });
  const s = store || (await openStore('receipts'));
  const saved = await s.get(KEY);
  if (!saved) return normalise(file);
  return normalise({ ...file, ...saved });
}

export async function saveConfig(config, { store } = {}) {
  const s = store || (await openStore('receipts'));
  const clean = normalise(config);
  clean.revision = Date.now().toString(36);
  clean.saved_at = new Date().toISOString();
  await s.set(KEY, clean);
  return clean;
}

export async function resetConfig({ store } = {}) {
  const s = store || (await openStore('receipts'));
  await s.delete(KEY);
  return normalise(await loadConfig({ force: true }));
}

/** Fills in defaults so nothing downstream has to guess. */
export function normalise(config = {}) {
  return {
    ...config,
    sections: { products_title: 'My products', links_title: 'Where else to find me', ...(config.sections || {}) },
    featured_video: { enabled: false, heading: 'Start here', ...(config.featured_video || {}) },
    socials: (config.socials || []).filter((s) => s && s.url),
    links: (config.links || []).filter((l) => l && l.url),
    // Payments matching these never count anywhere: not on a product, not in
    // "Everything else", not in the lifetime total. For things that are not a
    // product sale at all — refund adjustments, test charges, a one-off
    // consulting invoice that happened to land in the same Stripe account.
    ignore: {
      stripe_product: [],
      stripe_price: [],
      payment_link: [],
      metadata: {},
      description_contains: [],
      ...(config.ignore || {})
    },
    products: (config.products || [])
      .filter((p) => p && p.id)
      .map((p) => ({
        revenue_display: 'total',
        ...p,
        match: {
          stripe_product: [],
          stripe_price: [],
          payment_link: [],
          metadata: {},
          description_contains: [],
          ...(p.match || {})
        }
      }))
  };
}

/** Everything the public page is allowed to see. Matching rules stay private. */
export function displayConfig(config = {}) {
  const c = normalise(config);
  return {
    revision: c.revision || null,
    profile: c.profile || {},
    sections: c.sections,
    featured_video: c.featured_video,
    socials: c.socials,
    links: c.links,
    newsletter: c.newsletter || {},
    money: {
      base_currency: (c.money?.base_currency || 'usd').toLowerCase(),
      window_months: c.money?.window_months || 12,
      total_label: c.money?.total_label || 'verified from payments',
      show_total_bar: c.money?.show_total_bar !== false
    },
    products: c.products.map((p) => ({
      id: p.id,
      name: p.name,
      blurb: p.blurb || '',
      url: p.url || '#',
      cta: p.cta || 'Open',
      badge: p.badge || null,
      hidden: Boolean(p.hidden),
      revenue_display: p.revenue_display,
      manual_revenue: p.manual_revenue ?? null,
      checkout: p.checkout?.price ? { price: p.checkout.price } : null
    }))
  };
}

/** Cheap stable hash so the browser can tell whether anything changed. */
export function revisionOf(value) {
  const text = JSON.stringify(value);
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

/** Rejects the shapes that would break the page, and says which field. */
export function validateConfig(config) {
  const problems = [];
  if (!config || typeof config !== 'object') return ['The config must be an object.'];
  if (!config.profile?.name) problems.push('profile.name cannot be empty.');

  const ids = new Set();
  for (const [i, p] of (config.products || []).entries()) {
    if (!p.id) problems.push(`Product ${i + 1} needs an id.`);
    else if (ids.has(p.id)) problems.push(`Two products share the id "${p.id}".`);
    else if (!/^[a-z0-9-]+$/.test(p.id)) problems.push(`Product id "${p.id}" may only use lowercase letters, numbers and dashes.`);
    ids.add(p.id);
    if (!p.name) problems.push(`Product "${p.id || i + 1}" needs a name.`);
    if (p.revenue_display && !['total', 'monthly', 'manual', 'hidden'].includes(p.revenue_display)) {
      problems.push(`Product "${p.id}" has an unknown revenue_display "${p.revenue_display}".`);
    }
  }

  for (const [i, l] of (config.links || []).entries()) {
    if (!l.url) problems.push(`Link ${i + 1} needs a url.`);
  }
  for (const [i, s] of (config.socials || []).entries()) {
    if (!s.url) problems.push(`Social ${i + 1} needs a url.`);
  }
  if (config.money && !config.money.base_currency) problems.push('money.base_currency cannot be empty.');

  return problems;
}
