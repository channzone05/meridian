/**
 * OKX DEX API — ATH proximity and momentum data for entry timing.
 * Free API, no key required.
 */

import { log } from "../logger.js";

const OKX_PRICE_URL = "https://web3.okx.com/api/v6/dex/market/price-info";

// 60s in-memory cache per mint
const _cache = new Map();
const CACHE_TTL = 60_000;

/**
 * Fetch price info including ATH (maxPrice) and momentum data from OKX.
 * Returns null on failure.
 */
export async function fetchOkxPriceInfo(mint) {
  if (!mint) return null;

  // Check cache
  const cached = _cache.get(mint);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.data;
  }

  try {
    const res = await fetch(OKX_PRICE_URL, {
      method: "POST",
      headers: {
        "Ok-Access-Client-type": "agent-cli",
        "Content-Type": "application/json",
      },
      body: JSON.stringify([{ chainIndex: "501", tokenContractAddress: mint }]),
    });

    if (!res.ok) {
      log("okx", `HTTP ${res.status}`);
      return null;
    }

    const json = await res.json();
    const d = json?.data?.[0] || json?.[0] || null;
    if (!d) {
      log("okx", `No data for ${mint.slice(0, 8)}`);
      return null;
    }

    const price = parseFloat(d.price || 0);
    const maxPrice = parseFloat(d.maxPrice || 0);

    const data = {
      ath_proximity_pct: maxPrice > 0 ? Math.round((price / maxPrice) * 1000) / 10 : null,
      price,
      max_price: maxPrice,
      min_price: parseFloat(d.minPrice || 0),
      change_5m: parseFloat(d.priceChange5M || 0),
      change_1h: parseFloat(d.priceChange1H || 0),
      change_4h: parseFloat(d.priceChange4H || 0),
      change_24h: parseFloat(d.priceChange24H || 0),
      volume_5m: parseFloat(d.volume5M || 0),
      volume_1h: parseFloat(d.volume1H || 0),
    };

    _cache.set(mint, { data, fetchedAt: Date.now() });
    return data;
  } catch (e) {
    log("okx", `Fetch error for ${mint.slice(0, 8)}: ${e.message}`);
    return null;
  }
}
