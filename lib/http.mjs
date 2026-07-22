import crypto from 'node:crypto';

export function json(body, { status = 200, cache = 'no-store', headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, ...headers }
  });
}

export function text(body, { status = 200, type = 'text/plain; charset=utf-8', headers = {} } = {}) {
  return new Response(body, { status, headers: { 'content-type': type, ...headers } });
}

function sameSecret(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Returns null when the caller is allowed, or a Response to send back. */
export function requireAdmin(req, env = process.env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) {
    return json({ error: 'ADMIN_TOKEN is not set in the Netlify environment variables.' }, { status: 503 });
  }
  const url = new URL(req.url);
  const given = req.headers.get('x-admin-token') || url.searchParams.get('token') || '';
  if (!given || !sameSecret(given, expected)) {
    return json({ error: 'Wrong or missing admin token.' }, { status: 401 });
  }
  return null;
}

export async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

/** Coarse per-IP limiter kept in memory. Good enough to stop form spam bursts. */
const hits = new Map();
export function rateLimit(key, { max = 10, windowMs = 60000 } = {}) {
  const now = Date.now();
  const entry = hits.get(key) || { count: 0, reset: now + windowMs };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + windowMs;
  }
  entry.count += 1;
  hits.set(key, entry);
  if (hits.size > 5000) hits.clear();
  return entry.count <= max;
}

export function clientIp(req) {
  return (
    req.headers.get('x-nf-client-connection-ip') ||
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  );
}
