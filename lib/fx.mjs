/**
 * Exchange rates, refreshed on a schedule instead of hardcoded.
 *
 * Rate semantics used everywhere in this project: rates[c] is what one unit of
 * currency c is worth in the base currency. So with base usd, rates.eur = 1.17
 * means one euro is worth 1.17 dollars. The public APIs below return the
 * opposite direction, so they get inverted here once, in one place.
 */

const SOURCES = [
  {
    name: 'frankfurter',
    url: (base, symbols) => `https://api.frankfurter.dev/v1/latest?base=${base.toUpperCase()}&symbols=${symbols.map((s) => s.toUpperCase()).join(',')}`,
    parse: (body) => ({ rates: body.rates, date: body.date })
  },
  {
    name: 'exchangerate-api',
    url: (base) => `https://open.er-api.com/v6/latest/${base.toUpperCase()}`,
    parse: (body) => {
      if (body.result && body.result !== 'success') throw new Error(body['error-type'] || 'rate lookup failed');
      return { rates: body.rates, date: (body.time_last_update_utc || '').slice(5, 16) };
    }
  }
];

/**
 * Returns { base, rates, date, source } where rates are already inverted into
 * the direction this project uses. Falls back to the second source if the
 * first is down, and throws only if both fail.
 */
export async function fetchRates(base, symbols, { fetchImpl = fetch } = {}) {
  const wanted = [...new Set(symbols.map((s) => s.toLowerCase()))].filter((s) => s !== base.toLowerCase());
  if (wanted.length === 0) {
    return { base: base.toLowerCase(), rates: { [base.toLowerCase()]: 1 }, date: new Date().toISOString().slice(0, 10), source: 'none needed' };
  }

  const problems = [];
  for (const source of SOURCES) {
    try {
      const res = await fetchImpl(source.url(base, wanted), { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`${source.name} answered ${res.status}`);
      const { rates, date } = source.parse(await res.json());

      const out = { [base.toLowerCase()]: 1 };
      for (const code of wanted) {
        const perBase = Number(rates?.[code.toUpperCase()]);
        if (!perBase || !Number.isFinite(perBase)) continue;
        out[code] = Number((1 / perBase).toFixed(6));
      }

      const found = Object.keys(out).length - 1;
      if (found === 0) throw new Error(`${source.name} returned none of the currencies asked for`);

      return {
        base: base.toLowerCase(),
        rates: out,
        date: date || new Date().toISOString().slice(0, 10),
        source: source.name,
        missing: wanted.filter((c) => !(c in out)),
        fetched_at: new Date().toISOString()
      };
    } catch (err) {
      problems.push(err.message);
    }
  }

  throw new Error(`No rate source answered. ${problems.join(' | ')}`);
}

/**
 * Live rates win over the ones written in site.config.json, but only for
 * currencies that actually came back, and only if the base still matches.
 * Everything else keeps the configured value, so a dead API means slightly
 * stale numbers rather than a broken page.
 */
export function mergeRates(configMoney = {}, stored) {
  const base = (configMoney.base_currency || 'usd').toLowerCase();
  const rates = { ...(configMoney.rates || {}), [base]: 1 };
  if (stored?.base === base && stored.rates) {
    for (const [code, value] of Object.entries(stored.rates)) {
      if (Number.isFinite(value) && value > 0) rates[code] = value;
    }
  }
  return rates;
}
