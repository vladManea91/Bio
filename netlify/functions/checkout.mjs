import { json, readJson } from '../../lib/http.mjs';
import { createStripe } from '../../lib/stripe-client.mjs';
import { loadLiveConfig } from '../../lib/config.mjs';

/**
 * Creates a Stripe Checkout session for a product that has a price id set.
 * Needs a key with write access to Checkout Sessions: put it in
 * STRIPE_CHECKOUT_KEY, or reuse STRIPE_SECRET_KEY if that one can write.
 */
export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, { status: 405 });

  const site = await loadLiveConfig();
  const body = await readJson(req);
  const product = (site.products || []).find((p) => p.id === body.product);

  if (!product) return json({ error: 'Unknown product.' }, { status: 404 });
  const price = product.checkout?.price;
  if (!price) return json({ error: 'This product sells through its own link, not Checkout.' }, { status: 400 });

  const key = process.env.STRIPE_CHECKOUT_KEY || process.env.STRIPE_SECRET_KEY;
  if (!key) return json({ error: 'No Stripe key set for Checkout.' }, { status: 503 });

  const base = site.profile?.site_url || new URL(req.url).origin;
  const stripe = createStripe(key);

  try {
    const session = await stripe.post('/checkout/sessions', {
      mode: product.checkout.mode || 'payment',
      line_items: [{ price, quantity: product.checkout.quantity || 1 }],
      success_url: `${base}/?paid=${product.id}`,
      cancel_url: `${base}/`,
      allow_promotion_codes: true,
      metadata: { product: product.id, source: 'links-page' }
    });
    return json({ url: session.url });
  } catch (err) {
    return json({ error: err.message }, { status: 502 });
  }
};

export const config = { path: '/api/checkout' };
