import { json, readJson, rateLimit, clientIp } from '../../lib/http.mjs';
import { openStore } from '../../lib/store.mjs';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Email capture. Stores to Netlify Blobs and optionally forwards to your ESP. */
export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, { status: 405 });

  const ip = clientIp(req);
  if (!rateLimit(`sub:${ip}`, { max: 5, windowMs: 60000 })) {
    return json({ error: 'Too many tries. Wait a minute.' }, { status: 429 });
  }

  const body = await readJson(req);
  const email = String(body.email || '').trim().toLowerCase();
  if (body.company) return json({ ok: true }); // honeypot field, pretend it worked
  if (!EMAIL.test(email) || email.length > 200) {
    return json({ error: 'That email does not look right.' }, { status: 400 });
  }

  const store = await openStore('receipts');
  const list = (await store.get('subscribers')) || { people: [] };
  if (!list.people.some((p) => p.email === email)) {
    list.people.push({
      email,
      at: new Date().toISOString(),
      source: String(body.source || '').slice(0, 120) || null,
      ref: String(body.ref || '').slice(0, 200) || null
    });
    await store.set('subscribers', list);
  }

  if (process.env.SUBSCRIBE_WEBHOOK) {
    try {
      await fetch(process.env.SUBSCRIBE_WEBHOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, source: body.source || null })
      });
    } catch (err) {
      console.error('[subscribe] webhook failed', err.message);
    }
  }

  return json({ ok: true, count: list.people.length });
};

export const config = { path: '/api/subscribe' };
