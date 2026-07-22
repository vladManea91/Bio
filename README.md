# Receipts

A link in bio page where the numbers come from Stripe instead of from you.
One page for every product you sell, every video you want people to watch, and
every place you post, with revenue read straight out of your Stripe account and
attributed to the right product.

Static HTML plus Netlify Functions. No React, no database, no monthly fee for
anything except your own Netlify plan.

```
site.config.json     everything you edit
src/                 the page template, styles and front end script
scripts/build.mjs    turns those two into public/
netlify/functions/   the API: revenue, sync, subscribe, track, checkout
lib/                 the Stripe reading and the money maths
tests/               20 tests over the money maths and the sync
```

---

## Put it online

1. **Push this folder to a GitHub repo.**

2. **Netlify: Add new site, Import an existing project**, pick the repo.
   The settings come from `netlify.toml`, so leave them alone:
   build command `npm run build`, publish directory `public`,
   functions directory `netlify/functions`.

3. **Get a Stripe key.** In Stripe: Developers, API keys, Create restricted key.
   Give it **read** access to these and nothing else:

   | Resource | Access |
   |---|---|
   | Charges | Read |
   | Invoices | Read |
   | Checkout Sessions | Read |
   | Subscriptions | Read |
   | Products, Prices | Read |

   Read only means this key can never move your money, and it cannot see a card
   number. If it leaked, the worst case is somebody learns your revenue.

4. **Add the environment variables** in Netlify under
   Site configuration, Environment variables:

   ```
   STRIPE_SECRET_KEY   rk_live_...           the key from step 3
   ADMIN_TOKEN         a long random string  protects /admin.html
   ```

   Note that a publishable key (`pk_live_...`) will not work here. Those are
   built to sit in public web pages and Stripe refuses them on every read
   endpoint. It has to be a restricted key.

   More Stripe accounts go in `STRIPE_SECRET_KEY_2`, `STRIPE_SECRET_KEY_3`, and
   so on up to 9. They all add into the same page.

5. **Deploy**, then open `yoursite.netlify.app/admin.html`, paste your admin
   token, and press **Full resync**. First run reads up to four years of
   payments. If it says the budget ran out, press it again, it carries on from
   where it stopped.

6. **Check the matching table** on that same page. Any money sitting in
   "Everything else" is revenue that did not match a product yet. Fix that in
   step "Matching" below.

After this, a scheduled function syncs every hour on its own. You never have to
open the admin page again unless you add a product.

---

## Currency

Your base currency is set to USD in `site.config.json`, because that is what
most of your sales are priced in. Anything that comes in as another currency is
converted into USD before it is added up.

The rates are not hardcoded. A scheduled function pulls fresh ones **every day
at 12:00 UTC** and then recomputes the page. It reads from Frankfurter, which
publishes the European Central Bank's daily rates, and falls back to
exchangerate-api if that is down. If both are unreachable it keeps yesterday's
rates and logs the problem, so a dead rate API never blanks out your numbers.

The rates in `site.config.json` are only the starting point, used on the very
first run and as a floor if a currency is ever missing from the live feed.

To change the time, edit the schedule in `netlify/functions/rates.mjs`:

```js
export const config = { schedule: '0 12 * * *' };   // 12:00 UTC
```

Netlify crons run in UTC, so `0 12 * * *` fires at 14:00 German summer time. For
12:00 in Germany use `0 10 * * *` in summer, `0 11 * * *` in winter.

To display the page in euros instead, change one line:

```json
"base_currency": "eur"
```

Everything else adjusts, including the rates that get fetched.

When more than one currency contributed, the receipt strip says so and gives the
date of the rates used. On a receipts page, that felt more honest than quietly
presenting a converted number as if it were exact.

---

## PayPal

PayPal has a close equivalent to a Stripe restricted key, and it is already
wired in. A REST app gives you a **Client ID and Secret**, and with the
**Transaction Search** feature enabled those can read your transaction history.
Sales from PayPal are converted into the same shape as Stripe charges, so the
same match rules, the same cards and the same receipt strip cover both.

1. Go to developer.paypal.com, Apps & Credentials, **Live**, and open or create
   an app.
2. Under that app's features, tick **Transaction Search**, and save.
3. Copy the Client ID and Secret into Netlify:

   ```
   PAYPAL_CLIENT_ID       Aa1...
   PAYPAL_CLIENT_SECRET   EK...
   PAYPAL_ENV             live
   ```

4. Press Full resync in the admin panel.

Three things PayPal does that Stripe does not, all handled but worth knowing:

- A payment can take **up to three hours** to appear in the API, so the newest
  sales lag a little. The hourly sync catches them.
- History goes back **three years**, not further, whatever you set
  `history_months` to.
- If the app already existed before you ticked Transaction Search, the
  permission can take a few hours to take effect. Until then the API answers 403
  and the admin panel will tell you exactly that.

Refunds arrive as their own negative transaction and subtract themselves.
Pending and denied payments are ignored. If PayPal fails for any reason, the
Stripe sync still completes and the page still updates.

Second PayPal account goes in `PAYPAL_CLIENT_ID_2` and `PAYPAL_CLIENT_SECRET_2`.

---

## Nothing is showing on the page

The page hides money on purpose until there is money to show, which looks
identical to being broken. To find out which one you are looking at, add
`?debug=1` to the URL:

```
https://yoursite.netlify.app/?debug=1
```

A panel appears at the bottom, visible only with that parameter, telling you
whether the API answered, how many payments are stored, how many product cards
got numbers, and how much money is sitting unassigned. It names the fix for
each case.

The three usual answers:

- **payments api not reachable** — you are opening `public/index.html` as a file
  instead of running the site. Use `npm run demo`, or deploy it.
- **stored payments: none yet** — no sync has run. Open `/admin.html`, unlock
  with your admin token, press Full resync.
- **money sitting in Everything else** — your payments arrived, they just are
  not assigned to products yet. That is the next section.

---

## Find my products

This is the one that matters, and it is why your revenue lands in "Everything
else" at the start. The phrases shipped in `site.config.json` are guesses. Your
Stripe charges say whatever ThriveCart actually writes on them, which nobody
can know in advance.

So do not guess. In `/admin.html`, press **Load unmatched payments**. You get
every payment that matched nothing, grouped by the exact text it arrived with,
biggest amount first, with a count next to each. Pick the product each group
belongs to from the dropdown, press **Assign**, and the phrase is written into
that product's matching rules, saved, and the numbers recalculated on the spot.

Work down the list until it says everything matched. It usually takes about a
minute, and you never have to open the config file.

---

## The admin panel

`/admin.html`, unlocked with your `ADMIN_TOKEN`. Everything on the public page
is editable there, and saving takes effect immediately with no redeploy:

- **Profile** — name, handle, location, bio, avatar, footer note
- **Section titles** — the headings above your products and your links
- **Main video** — paste a YouTube URL, give it a caption. It shows as a still
  image and only loads YouTube's player after someone clicks, so it costs
  nothing on arrival
- **Social icons** — add, remove, reorder, pick from the icon set
- **Products** — name, description, button text and destination, badge, how the
  revenue displays, matching phrases, and a Stripe price id if you want to sell
  from the page directly
- **Other links** — your channel, a specific video, anything else
- **Newsletter** — heading, blurb, button, confirmation message

Saved settings live in Netlify Blobs and override `site.config.json`. The file
stays the fallback, so **Reset to the file in the repo** always gets you back to
a known state. If the API is ever unreachable, the page falls back to whatever
was built at deploy time and still works.

---

## Edit the file instead

You can still edit `site.config.json` directly, commit and push. That sets the
starting point and the reset target. Note that anything you saved in the admin
panel takes priority, so press Reset if you want the file to win.

**profile** is your name, location, one line bio, avatar path and the note in
the footer. Drop your own avatar in `src/assets/` and point `avatar` at it.

**socials** are the round icons. Available icons: `instagram`, `youtube`,
`x`, `linkedin`, `tiktok`, `skool`, `globe`, `mail`, `link`.

**products** are the cards with money on them.

**links** are the cards without money: your channel, one specific video, a free
resource. Icons: `youtube`, `video`, `link`, `skool`, `globe`.

**money** controls the numbers:

```json
"money": {
  "base_currency": "eur",
  "rates": { "eur": 1, "usd": 0.92, "gbp": 1.17 },
  "window_months": 12,
  "history_months": 48
}
```

Sales in other currencies get converted with `rates`, so update those every few
months if you care about precision. `window_months` is how many bars the
sparkline draws. `history_months` is how far back the lifetime total reaches.

---

## Matching: how a payment becomes a product

This is the part that matters, because your sales come through ThriveCart. Those
arrive in Stripe as plain charges with no Stripe Product attached, so the page
cannot guess which product a payment belongs to. You tell it, per product:

```json
"match": {
  "stripe_product": ["prod_abc"],
  "stripe_price": ["price_abc"],
  "payment_link": ["plink_abc"],
  "metadata": { "sku": "CGM-01" },
  "description_contains": ["color grading manual", "color manual"]
}
```

They are checked strongest first: Stripe product id, then price id, then payment
link, then metadata, then text. Text is matched against the charge description,
the statement descriptor, any metadata values, and the line item descriptions
from invoices and Checkout sessions. It is case insensitive.

**To find the right phrase:** open a payment in the Stripe dashboard and read
its description. Whatever ThriveCart writes there is what you paste into
`description_contains`.

**After editing match rules**, open `/admin.html` and press **Rebuild
matching**. It recomputes from data already stored, makes zero Stripe calls, and
finishes instantly. Full resync is only for pulling new history.

Anything that matches nothing lands in "Everything else" and is never shown on
the public page.

### How each card shows its money

Set `revenue_display` per product:

- `total` — lifetime collected, plus the number of payments
- `monthly` — recurring revenue if the product has active subscriptions,
  otherwise this month so far
- `manual` — you type the number yourself in `manual_revenue`
- `hidden` — no money on that card, it stays a plain link

Refunds are subtracted. Failed charges and lost disputes are excluded. A yearly
subscription is divided by twelve so the monthly figure means what it says.

---

## Selling straight from the page

Optional. Most of your products link out to ThriveCart, which is fine and needs
no setup. If you want a Stripe Checkout button instead, add this to a product:

```json
"checkout": { "price": "price_1234", "mode": "payment" }
```

Then add one more environment variable, a key with **write** access to Checkout
Sessions:

```
STRIPE_CHECKOUT_KEY   rk_live_...
```

Keep it separate from the read only key. After paying, the buyer comes back to
`/?paid=product-id` and sees a confirmation.

---

## Email capture and traffic

The signup form writes to Netlify Blobs. Download the list any time from
`/admin.html`, or hit `/api/subscribers?token=YOUR_TOKEN` for the CSV.

To pipe new subscribers straight into Kit, Beehiiv or anything else, set
`SUBSCRIBE_WEBHOOK` to a URL and each new address is POSTed there as
`{"email": "..."}`.

Page views and clicks per link are counted with no cookies and no personal data.
The admin page shows the last 30 days, including which links people actually
press and where they came from. Add `?utm_source=ig` to the link in your bio and
it shows up there.

---

## Working on it locally

```bash
npm install
npm run demo     # builds, invents fake Stripe data, serves on :8888
npm run preview  # same but with no data
npm test         # 20 tests over the money maths and the sync
npm run check    # runs the real front end script against the built page
```

`npm test` covers 55 cases: the money maths, the matching, the resumable sync,
rate inversion and fallback, PayPal normalisation, config validation and
storage, the shared renderer's escaping, and the whole assign-a-phrase flow
from unmatched payment to corrected total. `npm run check` runs the
real front end script against the real built page in a headless DOM.

`npm run demo` is the fastest way to see what the page looks like with numbers
on it before you connect anything real. The fake data never touches Stripe.

If you have the Netlify CLI, `netlify dev` works too and gives you the real
Blobs storage.

---

## When something looks wrong

**The receipt strip does not appear.** It stays hidden until at least one
product has money against it. Run a sync, then check the matching table.

**All my money is in "Everything else".** Your `description_contains` phrases do
not match what Stripe actually stores. Open a real charge, copy its description,
paste a distinctive piece of it into the product's match rules, push, then press
Rebuild matching.

**I edited site.config.json but the page did not change.** Admin panel settings
override the file. Press Reset to the file in the repo, or make the change in
the panel instead.

**PayPal payments are not showing up.** Open `/admin.html` and press
**Test PayPal connection**. It checks authentication and transaction search
separately from your Stripe sync, with no Stripe involved, and tells you which
of these it is:

- **No PayPal credentials found** — `PAYPAL_CLIENT_ID` and
  `PAYPAL_CLIENT_SECRET` are not set in Netlify, or the site has not redeployed
  since you added them. Environment variables only take effect on the next
  deploy.
- **Authentication failed** — the Client ID or Secret is wrong, or they are
  **Sandbox** credentials while `PAYPAL_ENV` is set to `live` (or the other way
  round). Sandbox and Live are separate apps with separate keys in the PayPal
  dashboard, and mixing them up looks exactly like a wrong password.
- **Transaction search failed with a 403** — Transaction Search is not ticked
  on for that app yet, or was ticked on recently and has not propagated.
  Recheck the box under that app's Features, and note it can take a few hours
  to take effect after you tick it.
- **Authenticated, but 0 transactions found** — the connection itself is fine.
  Either there is genuinely nothing to find in the last 7 days, or a very
  recent sale has not become searchable yet. PayPal can take up to 3 hours to
  make a transaction searchable, which is also why the sync deliberately never
  asks for the last 3 hours of activity, to avoid PayPal rejecting a request
  for a window it cannot answer yet.

If the test passes but a Full resync still shows nothing for PayPal, the sync
panel now lists each account's result under **Accounts** after every run,
including the exact error for that account, rather than only a generic "done"
message.

**A rate looks stale.** The daily job runs at 12:00 UTC. Press Refresh rates now
in the admin panel to pull them immediately.

**Sync says the budget ran out.** Normal on the first run with a long history.
Press it again. It resumes from its cursor and does not double count.

**The numbers are lower than my Stripe dashboard.** Three likely reasons:
refunds are subtracted here, a charge older than `history_months` is not
counted, and Stripe's dashboard shows gross where this shows net of refunds.

**A currency looks off.** Update `money.rates`. They are fixed numbers, not a
live feed, on purpose: your page should not change every time the market moves.

---

## What is not here

No leaderboard, no directory, no accounts, no billing. This is your page on your
domain, not a platform. If you ever want the numbers somewhere else, they are
one GET away at `/api/revenue`, and that endpoint is public and cached.
