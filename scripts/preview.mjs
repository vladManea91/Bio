/**
 * Local preview without the Netlify CLI.
 *   node scripts/preview.mjs          serve public/ and the /api routes
 *   node scripts/preview.mjs --demo   seed made up Stripe data first
 *
 * The demo data is generated locally and never touches Stripe, so you can see
 * exactly how the page looks before you plug in a real key.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8888);
const DEMO = process.argv.includes('--demo');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml'
};

/** Fake Stripe API used only by --demo. */
function demoStripe(config) {
  const now = Date.now();
  const products = config.products || [];
  const charges = [];
  let n = 0;

  products.forEach((p, pi) => {
    const phrase = p.match?.description_contains?.[0] || p.name;
    const price = [4900, 300000, 900, 3900][pi % 4];
    const volume = [140, 22, 260, 80][pi % 4];
    for (let i = 0; i < volume; i++) {
      const ageDays = Math.floor(Math.pow(Math.random(), 0.8) * 420);
      charges.push({
        id: `ch_demo_${n++}`,
        status: 'succeeded',
        amount: price,
        amount_refunded: Math.random() < 0.03 ? price : 0,
        currency: 'usd',
        created: Math.floor((now - ageDays * 86400000) / 1000),
        description: `ThriveCart - ${phrase}`,
        payment_intent: `pi_demo_${n}`,
        metadata: {}
      });
    }
  });

  const page = (all, url) => {
    const limit = Number(url.searchParams.get('limit') || 100);
    const after = url.searchParams.get('starting_after');
    const start = after ? all.findIndex((x) => x.id === after) + 1 : 0;
    const slice = all.slice(start, start + limit);
    return { object: 'list', data: slice, has_more: start + limit < all.length };
  };

  return async (rawUrl) => {
    const url = new URL(rawUrl);
    const reply = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.pathname === '/v1/charges') return reply(page(charges, url));
    if (url.pathname === '/v1/subscriptions') {
      return reply({
        object: 'list',
        has_more: false,
        data: [
          {
            id: 'sub_demo',
            status: 'active',
            items: {
              data: [{
                quantity: 12,
                price: { id: 'price_demo', product: 'prod_demo', currency: 'eur', unit_amount: 300000, recurring: { interval: 'year', interval_count: 1 } }
              }]
            }
          }
        ]
      });
    }
    return reply({ object: 'list', data: [], has_more: false });
  };
}

async function seedDemo() {
  const { runSync } = await import('../lib/sync.mjs');
  const config = JSON.parse(await fs.readFile(path.join(ROOT, 'site.config.json'), 'utf8'));
  const result = await runSync({
    env: { STRIPE_SECRET_KEY: 'rk_demo' },
    fetchImpl: demoStripe(config),
    budgetMs: 60000,
    full: true
  });
  console.log('demo data seeded:', Object.entries(result.snapshot.products).map(([k, v]) => `${k}=${Math.round(v.total)}`).join(' '));
}

/** Map the function modules onto their configured paths. */
async function loadRoutes() {
  const dir = path.join(ROOT, 'netlify', 'functions');
  const routes = new Map();
  for (const file of await fs.readdir(dir)) {
    if (!file.endsWith('.mjs')) continue;
    const mod = await import(path.join(dir, file));
    if (mod.config?.path) routes.set(mod.config.path, mod.default);
  }
  return routes;
}

const routes = await loadRoutes();
if (DEMO) await seedDemo();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  const handler = routes.get(url.pathname);
  if (handler) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(`http://localhost:${PORT}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined
    });
    try {
      const out = await handler(request, {});
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  let file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end('nope');
    return;
  }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`preview on http://localhost:${PORT}${DEMO ? '  (demo data)' : ''}`);
});
