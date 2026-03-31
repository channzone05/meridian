/**
 * OKX DEX API — ATH proximity and momentum data for entry timing.
 * Free API, no key required.
 */

import { log } from "../logger.js";

const OKX_PRICE_URL = "https://web3.okx.com/api/v6/dex/market/price-info";
const OKX_CANDLES_URL = "https://web3.okx.com/api/v6/dex/market/candles";

// 60s in-memory cache per mint
const _cache = new Map();
const CACHE_TTL = 60_000;

/**
 * Fetch 6x 5m candles and summarize into actionable signals.
 */
async function fetchCandleSummary(mint) {
  try {
    const res = await fetch(`${OKX_CANDLES_URL}?chainIndex=501&tokenContractAddress=${mint}&bar=5m&limit=6`);
    if (!res.ok) return null;
    const json = await res.json();
    const candles = json?.data;
    if (!candles?.length) return null;

    // Candle format: [ts, open, high, low, close, vol_tokens, vol_usd, confirmed]
    const vols = candles.map(c => parseFloat(c[6] || 0));
    const closes = candles.map(c => parseFloat(c[4] || 0));
    const highs = candles.map(c => parseFloat(c[2] || 0));
    const lows = candles.map(c => parseFloat(c[3] || 0));

    // Volume trend: first 3 avg vs last 3 avg
    const firstAvg = vols.slice(0, 3).reduce((s, v) => s + v, 0) / 3;
    const lastAvg = vols.slice(-3).reduce((s, v) => s + v, 0) / 3;
    const volume_trend = lastAvg > firstAvg * 1.2 ? "increasing"
      : lastAvg < firstAvg * 0.8 ? "decreasing" : "stable";

    // Volume dying: 3+ candles with < $10 volume
    const volume_dying = vols.filter(v => v < 10).length >= 3;

    // Price direction: first close vs last close
    const firstClose = closes[0] || 0;
    const lastClose = closes[closes.length - 1] || 0;
    const changePct = firstClose > 0 ? ((lastClose - firstClose) / firstClose) * 100 : 0;
    const price_direction = changePct > 2 ? "up" : changePct < -2 ? "down" : "ranging";

    // Price range: spread across the full window
    const allHigh = Math.max(...highs);
    const allLow = Math.min(...lows.filter(l => l > 0));
    const price_range_pct = allLow > 0 ? Math.round(((allHigh - allLow) / allLow) * 1000) / 10 : 0;

    // Acceleration: compare first-half momentum vs second-half momentum
    const mid = Math.floor(closes.length / 2);
    const firstHalfChange = mid > 0 && closes[0] > 0 ? (closes[mid] - closes[0]) / closes[0] : 0;
    const secondHalfChange = closes[mid] > 0 ? (closes[closes.length - 1] - closes[mid]) / closes[mid] : 0;
    let acceleration = "steady";
    if (Math.abs(secondHalfChange) > Math.abs(firstHalfChange) * 1.5) {
      acceleration = secondHalfChange > 0 ? "accelerating_up" : "accelerating_down";
    } else if (Math.abs(secondHalfChange) < Math.abs(firstHalfChange) * 0.5) {
      acceleration = "decelerating";
    }

    return {
      volume_trend,
      volume_dying,
      price_direction,
      price_range_pct,
      acceleration,
      latest_3_volumes_usd: vols.slice(-3).map(v => Math.round(v)),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch price info including ATH (maxPrice), momentum, and 5m candle summary from OKX.
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
    // Fetch price and candles in parallel
    const [priceRes, candles] = await Promise.all([
      fetch(OKX_PRICE_URL, {
        method: "POST",
        headers: {
          "Ok-Access-Client-type": "agent-cli",
          "Content-Type": "application/json",
        },
        body: JSON.stringify([{ chainIndex: "501", tokenContractAddress: mint }]),
      }),
      fetchCandleSummary(mint),
    ]);

    if (!priceRes.ok) {
      log("okx", `HTTP ${priceRes.status}`);
      return null;
    }

    const json = await priceRes.json();
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
      // 5m candle summary (last 30 min)
      candles: candles || null,
    };

    _cache.set(mint, { data, fetchedAt: Date.now() });
    return data;
  } catch (e) {
    log("okx", `Fetch error for ${mint.slice(0, 8)}: ${e.message}`);
    return null;
  }
}
