/**
 * Renders public/ from site.config.json + src/.
 * Run: npm run build   (Netlify runs this on every deploy)
 *
 * Markup comes from src/assets/render.mjs, the same module the browser uses
 * when you change something in the admin panel, so the static page and the
 * re-rendered page are always produced by identical code.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  esc, renderHeader, renderSocials, renderVideo, renderProducts, renderLinks, renderSignup, titles
} from '../src/assets/render.mjs';
import { displayConfig, revisionOf } from '../lib/config.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'public');

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(src, dst);
    else await fs.copyFile(src, dst);
  }
}

async function main() {
  const config = JSON.parse(await fs.readFile(path.join(ROOT, 'site.config.json'), 'utf8'));
  const template = await fs.readFile(path.join(SRC, 'index.html'), 'utf8');
  const profile = config.profile || {};
  const meta = config.meta || {};
  const t = titles(config);

  const jsonld = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: profile.name,
    url: profile.site_url,
    description: profile.tagline,
    sameAs: (config.socials || []).map((s) => s.url).filter((u) => u && !String(u).startsWith('mailto:'))
  });

  const display = displayConfig(config);
  display.revision = config.revision || revisionOf(display);

  const html = template
    .replaceAll('{{TITLE}}', esc(meta.title || profile.name))
    .replaceAll('{{DESCRIPTION}}', esc(meta.description || profile.tagline))
    .replaceAll('{{SITE_URL}}', esc(profile.site_url || ''))
    .replaceAll('{{OG_IMAGE}}', esc(new URL(meta.og_image || '/assets/og.png', profile.site_url || 'https://example.com').href))
    .replaceAll('{{NAME_SHORT}}', esc((profile.name || '').split(' ')[0] || 'receipts'))
    .replaceAll('{{TOTAL_LABEL}}', esc(config.money?.total_label || 'verified from payments'))
    .replaceAll('{{HEADER}}', renderHeader(profile))
    .replaceAll('{{SOCIALS}}', renderSocials(config.socials))
    .replaceAll('{{VIDEO}}', renderVideo(config.featured_video))
    .replaceAll('{{PRODUCTS_TITLE}}', esc(t.products))
    .replaceAll('{{LINKS_TITLE}}', esc(t.links))
    .replaceAll('{{PRODUCTS}}', renderProducts(config.products))
    .replaceAll('{{LINKS}}', renderLinks(config.links))
    .replaceAll('{{SIGNUP}}', renderSignup(config.newsletter))
    .replaceAll('{{FOOTER_NOTE}}', esc(profile.footer_note || ''))
    .replaceAll('{{JSONLD}}', jsonld)
    .replaceAll('{{CONFIG_JSON}}', JSON.stringify(display).replace(/</g, '\\u003c'));

  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
  await copyDir(path.join(SRC, 'assets'), path.join(OUT, 'assets'));
  await fs.writeFile(path.join(OUT, 'index.html'), html);
  await fs.copyFile(path.join(SRC, 'admin.html'), path.join(OUT, 'admin.html'));

  await fs.writeFile(
    path.join(OUT, 'robots.txt'),
    `User-agent: *\nAllow: /\nDisallow: /admin.html\n\nSitemap: ${(profile.site_url || '').replace(/\/$/, '')}/sitemap.xml\n`
  );
  await fs.writeFile(
    path.join(OUT, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${esc(profile.site_url || '')}</loc></url></urlset>\n`
  );

  console.log(`built public/index.html  ${(Buffer.byteLength(html) / 1024).toFixed(1)} kB`);
  console.log(`       ${(config.products || []).length} products, ${(config.links || []).length} links, ${(config.socials || []).length} socials`);
}

main().catch((err) => {
  console.error('Build failed:', err.message);
  process.exit(1);
});
