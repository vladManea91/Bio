import test from 'node:test';
import assert from 'node:assert/strict';
import { normalise, displayConfig, validateConfig, saveConfig, loadLiveConfig, resetConfig, revisionOf } from '../lib/config.mjs';
import { openStore } from '../lib/store.mjs';
import { renderProducts, renderLinks, renderSocials, renderVideo, youtubeId, titles } from '../src/assets/render.mjs';

test('normalise fills in the defaults nothing should have to guess', () => {
  const c = normalise({ products: [{ id: 'a', name: 'A' }] });
  assert.equal(c.sections.products_title, 'My products');
  assert.equal(c.featured_video.enabled, false);
  assert.deepEqual(c.products[0].match.description_contains, []);
  assert.equal(c.products[0].revenue_display, 'total');
});

test('the public config never leaks matching rules', () => {
  const display = displayConfig({
    profile: { name: 'V' },
    products: [{ id: 'a', name: 'A', match: { description_contains: ['secret phrase'] }, checkout: { price: 'price_1' } }]
  });
  const text = JSON.stringify(display);
  assert.ok(!text.includes('secret phrase'), 'match rules stay on the server');
  assert.ok(!text.includes('description_contains'));
  assert.deepEqual(display.products[0].checkout, { price: 'price_1' });
});

test('validation catches the mistakes that would break the page', () => {
  assert.deepEqual(validateConfig({ profile: { name: 'V' }, products: [] }), []);
  assert.match(validateConfig({ profile: {} }).join(' '), /profile.name/);
  assert.match(validateConfig({ profile: { name: 'V' }, products: [{ id: 'A B', name: 'x' }] }).join(' '), /lowercase/);
  assert.match(validateConfig({ profile: { name: 'V' }, products: [{ id: 'a', name: 'x' }, { id: 'a', name: 'y' }] }).join(' '), /share the id/);
  assert.match(validateConfig({ profile: { name: 'V' }, products: [{ id: 'a', name: 'x', revenue_display: 'sideways' }] }).join(' '), /revenue_display/);
  assert.match(validateConfig({ profile: { name: 'V' }, links: [{ title: 'x' }] }).join(' '), /needs a url/);
});

test('saved settings win over the file, and reset gives the file back', async () => {
  const store = await openStore(`cfgtest_${Date.now()}`);
  const fromFile = await loadLiveConfig({ store, force: true });
  const originalTitle = fromFile.sections.products_title;

  const edited = { ...fromFile, sections: { ...fromFile.sections, products_title: 'The things I made' } };
  const saved = await saveConfig(edited, { store });
  assert.ok(saved.revision, 'saving stamps a revision');

  const live = await loadLiveConfig({ store, force: true });
  assert.equal(live.sections.products_title, 'The things I made');

  const back = await resetConfig({ store });
  assert.equal(back.sections.products_title, originalTitle);
});

test('a revision changes when anything about the page changes', () => {
  const a = revisionOf({ links: [{ url: 'https://a' }] });
  const b = revisionOf({ links: [{ url: 'https://b' }] });
  assert.notEqual(a, b);
  assert.equal(a, revisionOf({ links: [{ url: 'https://a' }] }), 'and stays the same when nothing does');
});

/* ---------------- the shared renderer ---------------- */

test('youtube ids come out of every url shape people paste', () => {
  assert.equal(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://youtube.com/embed/dQw4w9WgXcQ?rel=0'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('not a video'), null);
});

test('the video block stays out until it is switched on and has an id', () => {
  assert.equal(renderVideo({ enabled: false, url: 'https://youtu.be/abc123' }), '');
  assert.equal(renderVideo({ enabled: true, url: 'nonsense' }), '');
  assert.match(renderVideo({ enabled: true, url: 'https://youtu.be/abc123' }), /data-video="abc123"/);
});

test('hidden items never reach the page', () => {
  assert.equal(renderProducts([{ id: 'a', name: 'A', hidden: true }]), '');
  assert.equal(renderLinks([{ id: 'a', title: 'A', url: 'https://x', hidden: true }]), '');
  assert.equal(renderSocials([{ label: 'x' }]), '', 'a social with no url is dropped');
});

test('user text is escaped, not executed', () => {
  const html = renderProducts([{ id: 'a', name: '<script>alert(1)</script>', url: 'https://x"onmouseover="evil()' }]);
  assert.ok(!html.includes('<script>'), 'no raw script tag');
  assert.ok(!html.includes('"onmouseover'), 'the quote is escaped so it cannot break out of the attribute');
  assert.ok(html.includes('&quot;onmouseover'), 'it survives as inert text instead');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('a checkout price turns the button into a real button', () => {
  assert.match(renderProducts([{ id: 'a', name: 'A', url: 'https://x' }]), /<a class="cta"/);
  assert.match(renderProducts([{ id: 'a', name: 'A', url: 'https://x', checkout: { price: 'price_1' } }]), /<button class="cta"/);
});

test('section headings fall back to sensible defaults', () => {
  assert.equal(titles({}).products, 'My products');
  assert.equal(titles({ sections: { products_title: 'What I built' } }).products, 'What I built');
});
