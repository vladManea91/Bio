/**
 * Renders public/ from site.config.json + src/.
 * Run: npm run build   (Netlify runs this on every deploy)
 *
 * The page ships as real HTML so it reads well without JavaScript and so
 * link previews and search engines see the content. JavaScript only fills in
 * the live Stripe numbers on top.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'public');

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const ICONS = {
  instagram: '<rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"/>',
  youtube: '<rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9.2v5.6l5-2.8z" fill="currentColor" stroke="none"/>',
  video: '<rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9.2v5.6l5-2.8z" fill="currentColor" stroke="none"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 3 2.6 15 0 18M12 3c-2.6 3-2.6 15 0 18"/>',
  mail: '<rect x="2" y="4.5" width="20" height="15" rx="3"/><path d="m3 7 9 6 9-6"/>',
  x: '<path d="M4 4l16 16M20 4L4 20"/>',
  linkedin: '<rect x="2" y="2" width="20" height="20" rx="4"/><path d="M7 10v7M7 7v.01M12 17v-4a2 2 0 0 1 4 0v4"/>',
  tiktok: '<path d="M15 4c.6 2.4 2 3.6 4 3.8V11c-1.6 0-3-.5-4-1.3V15a5 5 0 1 1-5-5v3a2 2 0 1 0 2 2V4z"/>',
  skool: '<path d="M4 8l8-4 8 4-8 4z"/><path d="M7 10.5V15c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5v-4.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7l-1.2 1.2"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.7l1.2-1.2"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>'
};

const icon = (name, size = 19) => {
  const body = ICONS[name] || ICONS.link;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
};

function renderSocials(socials = []) {
  return socials
    .map(
      (s) => `<a href="${esc(s.url)}" rel="me noopener" data-track="social:${esc(s.icon || s.label)}" aria-label="${esc(s.label)}">${icon(s.icon)}</a>`
    )
    .join('\n      ');
}

function renderProducts(products = []) {
  return products
    .map((p) => {
      const hasCheckout = Boolean(p.checkout?.price);
      const cta = esc(p.cta || 'Open');
      const ctaEl = hasCheckout
        ? `<button class="cta" type="button" data-checkout="${esc(p.id)}">${cta}</button>`
        : `<a class="cta" href="${esc(p.url)}" rel="noopener" data-track="cta:${esc(p.id)}">${cta}</a>`;

      const badge = p.badge ? `<span class="verified">${esc(p.badge)}</span>` : '';

      return `<article class="card" data-product="${esc(p.id)}">
        <div class="card__top">
          <div>
            <h3 class="card__name"><a href="${esc(p.url)}" rel="noopener" data-track="product:${esc(p.id)}">${esc(p.name)}</a></h3>
            <p class="card__blurb">${esc(p.blurb || '')}</p>
          </div>
          ${badge}
        </div>
        <div class="spark" data-spark hidden></div>
        <div class="spark__labels" data-spark-labels hidden></div>
        <div class="card__foot">
          <div class="money" data-money></div>
          ${ctaEl}
        </div>
      </article>`;
    })
    .join('\n      ');
}

function renderLinks(links = []) {
  return links
    .map(
      (l) => `<a class="link" href="${esc(l.url)}" rel="noopener" data-track="link:${esc(l.id)}">
        <span class="link__icon">${icon(l.kind || 'link', 17)}</span>
        <span class="link__text">
          <span class="link__title">${esc(l.title)}</span>
          ${l.subtitle ? `<span class="link__sub">${esc(l.subtitle)}</span>` : ''}
        </span>
        <span class="link__arrow">${icon('arrow', 17)}</span>
      </a>`
    )
    .join('\n      ');
}

function renderSignup(n = {}) {
  if (!n.enabled) return '';
  return `<section class="section">
    <div class="signup">
      <h2>${esc(n.heading || 'Newsletter')}</h2>
      <p>${esc(n.blurb || '')}</p>
      <div class="signup__row">
        <label class="hp" for="company">Leave this empty</label>
        <input class="hp" id="company" name="company" type="text" tabindex="-1" autocomplete="off">
        <input id="email" type="email" inputmode="email" autocomplete="email" placeholder="you@email.com" aria-label="Your email">
        <button type="button" id="subscribe">${esc(n.button || 'Join')}</button>
      </div>
      <p class="signup__note" id="signup-note" role="status" aria-live="polite"></p>
    </div>
  </section>`;
}

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

  const metaBits = [profile.handle, profile.location, profile.verified_since ? `since ${profile.verified_since}` : null]
    .filter(Boolean)
    .map((b) => `<span>${esc(b)}</span>`)
    .join('');

  const jsonld = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: profile.name,
    url: profile.site_url,
    description: profile.tagline,
    sameAs: (config.socials || []).map((s) => s.url).filter((u) => !String(u).startsWith('mailto:'))
  });

  // The browser gets the display config only. Matching rules stay on the server.
  const publicConfig = {
    profile: { name: profile.name, site_url: profile.site_url },
    money: { base_currency: config.money?.base_currency || 'eur', window_months: config.money?.window_months || 12 },
    products: (config.products || []).map((p) => ({
      id: p.id,
      name: p.name,
      revenue_display: p.revenue_display || 'total',
      manual_revenue: p.manual_revenue ?? null
    })),
    newsletter: { success: config.newsletter?.success || 'You are on the list.' },
    tape: { total_label: config.money?.total_label || 'verified through Stripe', show: config.money?.show_total_bar !== false }
  };

  const html = template
    .replaceAll('{{TITLE}}', esc(meta.title || profile.name))
    .replaceAll('{{DESCRIPTION}}', esc(meta.description || profile.tagline))
    .replaceAll('{{SITE_URL}}', esc(profile.site_url || ''))
    .replaceAll('{{OG_IMAGE}}', esc(new URL(meta.og_image || '/assets/og.png', profile.site_url || 'https://example.com').href))
    .replaceAll('{{AVATAR}}', esc(profile.avatar || '/assets/avatar.svg'))
    .replaceAll('{{NAME_SHORT}}', esc((profile.name || '').split(' ')[0] || 'receipts'))
    .replaceAll('{{NAME}}', esc(profile.name || ''))
    .replaceAll('{{META}}', metaBits)
    .replaceAll('{{TAGLINE}}', esc(profile.tagline || ''))
    .replaceAll('{{TOTAL_LABEL}}', esc(config.money?.total_label || 'verified through Stripe'))
    .replaceAll('{{SOCIALS}}', renderSocials(config.socials))
    .replaceAll('{{PRODUCTS}}', renderProducts(config.products))
    .replaceAll('{{LINKS}}', renderLinks(config.links))
    .replaceAll('{{SIGNUP}}', renderSignup(config.newsletter))
    .replaceAll('{{FOOTER_NOTE}}', esc(profile.footer_note || ''))
    .replaceAll('{{JSONLD}}', jsonld)
    .replaceAll('{{CONFIG_JSON}}', JSON.stringify(publicConfig).replace(/</g, '\\u003c'));

  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
  await copyDir(path.join(SRC, 'assets'), path.join(OUT, 'assets'));
  await fs.writeFile(path.join(OUT, 'index.html'), html);
  await fs.copyFile(path.join(SRC, 'admin.html'), path.join(OUT, 'admin.html'));

  const robots = `User-agent: *\nAllow: /\nDisallow: /admin.html\n\nSitemap: ${(profile.site_url || '').replace(/\/$/, '')}/sitemap.xml\n`;
  await fs.writeFile(path.join(OUT, 'robots.txt'), robots);
  await fs.writeFile(
    path.join(OUT, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${esc(profile.site_url || '')}</loc></url></urlset>\n`
  );

  const bytes = Buffer.byteLength(html);
  console.log(`built public/index.html  ${(bytes / 1024).toFixed(1)} kB`);
  console.log(`       ${(config.products || []).length} products, ${(config.links || []).length} links, ${(config.socials || []).length} socials`);
}

main().catch((err) => {
  console.error('Build failed:', err.message);
  process.exit(1);
});
