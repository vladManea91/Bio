/**
 * One renderer, used twice: scripts/build.mjs imports it in Node to produce the
 * static page, and assets/app.js imports it in the browser to re-render after
 * you change something in the admin panel. Same functions both times, so the
 * two can never drift apart.
 *
 * Pure strings in, pure strings out. No Node APIs, no DOM APIs.
 */

export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const ICONS = {
  instagram: '<rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"/>',
  youtube: '<rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9.2v5.6l5-2.8z" fill="currentColor" stroke="none"/>',
  video: '<rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9.2v5.6l5-2.8z" fill="currentColor" stroke="none"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 3 2.6 15 0 18M12 3c-2.6 3-2.6 15 0 18"/>',
  mail: '<rect x="2" y="4.5" width="20" height="15" rx="3"/><path d="m3 7 9 6 9-6"/>',
  x: '<path d="M4 4l16 16M20 4L4 20"/>',
  linkedin: '<rect x="2" y="2" width="20" height="20" rx="4"/><path d="M7 10v7M7 7v.01M12 17v-4a2 2 0 0 1 4 0v4"/>',
  tiktok: '<path d="M15 4c.6 2.4 2 3.6 4 3.8V11c-1.6 0-3-.5-4-1.3V15a5 5 0 1 1-5-5v3a2 2 0 1 0 2 2V4z"/>',
  skool: '<path d="M4 8l8-4 8 4-8 4z"/><path d="M7 10.5V15c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5v-4.5"/>',
  threads: '<path d="M12 21c-5 0-8-3.6-8-9s3-9 8-9c3.4 0 5.7 1.5 6.8 4"/><path d="M9 14c0-1.7 1.6-2.6 3.6-2.6 2.6 0 4 1.3 4 3.2 0 2-1.4 3.4-3.2 3.4-1.4 0-2.3-.8-2.3-1.8 0-1.3 1.2-2 3-2 2.6 0 4.4 1.5 4.4 4"/>',
  spotify: '<circle cx="12" cy="12" r="9"/><path d="M7.5 9.8c3-.8 6.2-.5 8.7 1M8.2 13c2.4-.6 4.9-.3 6.9.9M8.9 16c1.8-.4 3.6-.2 5.1.6"/>',
  podcast: '<path d="M12 3a4 4 0 0 1 4 4v4a4 4 0 0 1-8 0V7a4 4 0 0 1 4-4z"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  cart: '<path d="M3 4h2l2.4 11h9.6l2-8H6"/><circle cx="10" cy="19" r="1.4"/><circle cx="17" cy="19" r="1.4"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 5.5V20.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7l-1.2 1.2"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.7l1.2-1.2"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>'
};

/** Names offered in the admin dropdowns. */
export const ICON_NAMES = Object.keys(ICONS).filter((k) => k !== 'arrow');

export function icon(name, size = 19) {
  const body = ICONS[name] || ICONS.link;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** Pulls the id out of any YouTube URL shape people actually paste. */
export function youtubeId(url = '') {
  const patterns = [
    /[?&]v=([\w-]{6,})/,
    /youtu\.be\/([\w-]{6,})/,
    /youtube\.com\/embed\/([\w-]{6,})/,
    /youtube\.com\/shorts\/([\w-]{6,})/,
    /youtube\.com\/live\/([\w-]{6,})/
  ];
  for (const p of patterns) {
    const m = String(url).match(p);
    if (m) return m[1];
  }
  return null;
}

export function renderHeader(profile = {}) {
  const bits = [profile.handle, profile.location, profile.verified_since ? `since ${profile.verified_since}` : null]
    .filter(Boolean)
    .map((b) => `<span>${esc(b)}</span>`)
    .join('');
  return `<img class="head__avatar" src="${esc(profile.avatar || '/assets/avatar.svg')}" alt="${esc(profile.name || '')}" width="92" height="92">
    <h1 class="head__name">${esc(profile.name || '')}</h1>
    <div class="head__meta eyebrow">${bits}</div>
    <p class="head__tagline">${esc(profile.tagline || '')}</p>`;
}

export function renderSocials(socials = []) {
  return socials
    .filter((s) => s && s.url)
    .map((s) => `<a href="${esc(s.url)}" rel="me noopener" data-track="social:${esc(s.icon || s.label)}" aria-label="${esc(s.label || s.icon)}">${icon(s.icon)}</a>`)
    .join('');
}

/**
 * The one video you actually want people to watch. Loads as a still image and
 * only pulls in YouTube's player after a click, so it costs nothing on arrival.
 */
export function renderVideo(video = {}) {
  if (!video.enabled) return '';
  const id = video.youtube_id || youtubeId(video.url);
  if (!id) return '';
  return `<div class="section__head">
        <h2 class="section__title">${esc(video.heading || 'Start here')}</h2>
      </div>
      <div class="video" data-video="${esc(id)}" data-track="video:${esc(id)}" role="button" tabindex="0" aria-label="Play ${esc(video.title || 'the video')}">
        <img class="video__still" src="https://i.ytimg.com/vi/${esc(id)}/hqdefault.jpg" alt="" loading="lazy" width="480" height="360">
        <span class="video__play">${icon('youtube', 26)}</span>
        ${video.title ? `<span class="video__title">${esc(video.title)}</span>` : ''}
      </div>`;
}

export function renderProducts(products = []) {
  return products
    .filter((p) => p && p.id && !p.hidden)
    .map((p) => {
      const cta = esc(p.cta || 'Open');
      const ctaEl = p.checkout?.price
        ? `<button class="cta" type="button" data-checkout="${esc(p.id)}">${cta}</button>`
        : `<a class="cta" href="${esc(p.url)}" rel="noopener" data-track="cta:${esc(p.id)}">${cta}</a>`;
      return `<article class="card" data-product="${esc(p.id)}">
        <div class="card__top">
          <div>
            <h3 class="card__name"><a href="${esc(p.url)}" rel="noopener" data-track="product:${esc(p.id)}">${esc(p.name)}</a></h3>
            <p class="card__blurb">${esc(p.blurb || '')}</p>
          </div>
          ${p.badge ? `<span class="verified">${esc(p.badge)}</span>` : ''}
        </div>
        <div class="spark" data-spark hidden></div>
        <div class="spark__labels" data-spark-labels hidden></div>
        <div class="card__foot">
          <div class="money" data-money></div>
          ${ctaEl}
        </div>
      </article>`;
    })
    .join('');
}

export function renderLinks(links = []) {
  return links
    .filter((l) => l && l.url && !l.hidden)
    .map(
      (l) => `<a class="link" href="${esc(l.url)}" rel="noopener" data-track="link:${esc(l.id || l.title)}">
        <span class="link__icon">${icon(l.kind || 'link', 17)}</span>
        <span class="link__text">
          <span class="link__title">${esc(l.title)}</span>
          ${l.subtitle ? `<span class="link__sub">${esc(l.subtitle)}</span>` : ''}
        </span>
        <span class="link__arrow">${icon('arrow', 17)}</span>
      </a>`
    )
    .join('');
}

export function renderSignup(n = {}) {
  if (!n.enabled) return '';
  return `<div class="signup">
      <h2>${esc(n.heading || 'Newsletter')}</h2>
      <p>${esc(n.blurb || '')}</p>
      <div class="signup__row">
        <label class="hp" for="company">Leave this empty</label>
        <input class="hp" id="company" name="company" type="text" tabindex="-1" autocomplete="off">
        <input id="email" type="email" inputmode="email" autocomplete="email" placeholder="you@email.com" aria-label="Your email">
        <button type="button" id="subscribe">${esc(n.button || 'Join')}</button>
      </div>
      <p class="signup__note" id="signup-note" role="status" aria-live="polite"></p>
    </div>`;
}

export const titles = (config = {}) => ({
  products: config.sections?.products_title || 'My products',
  links: config.sections?.links_title || 'Where else to find me'
});
