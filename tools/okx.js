/**
 * OKX DEX enrichment for screening.
 * - price-info + candles for timing/ATH context
 * - signal feed snapshot for smart-money / KOL / whale confirmation
 */

import { log } from "../logger.js";

const OKX_PRICE_URL = "https://web3.okx.com/api/v6/dex/market/price-info";
const OKX_CANDLES_URL = "https://web3.okx.com/api/v6/dex/market/candles";
const OKX_SIGNAL_URL = "https://web3.okx.com/api/v6/dex/market/signal/list";
const OKX_HEADERS = {
  "Content-Type": "application/json",
  "Ok-Access-Client-type": "agent-cli",
  "ok-client-version": "2.2.6",
};

const PRICE_CACHE_TTL = 60_000;
const SIGNAL_SNAPSHOT_TTL = 30_000;
const SIGNAL_EMPTY_TTL = 60_000;
const OKX_MIN_REQUEST_GAP_MS = 200;

const _priceCache = new Map();
const _signalCache = new Map();

let _signalSnapshot = null;
let _signalSnapshotExpiresAt = 0;
let _signalSnapshotInflight = null;

let _okxRequestChain = Promise.resolve();
let _lastOkxRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queueOkxRequest(task) {
  const run = _okxRequestChain.then(async () => {
    const waitMs = Math.max(0, OKX_MIN_REQUEST_GAP_MS - (Date.now() - _lastOkxRequestAt));
    if (waitMs > 0) await sleep(waitMs);
    try {
      return await task();
    } finally {
      _lastOkxRequestAt = Date.now();
    }
  });

  _okxRequestChain = run.catch(() => {});
  return run;
}

function readCache(cache, key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function writeCache(cache, key, data, ttlMs) {
  cache.set(key, {
    data,
    expiresAt: Date.now() + ttlMs,
  });
}

async function fetchOkxJson(url, options = {}) {
  try {
    const res = await queueOkxRequest(() => fetch(url, {
      ...options,
      headers: {
        ...OKX_HEADERS,
        ...(options.headers || {}),
      },
    }));

    if (res.status === 429) {
      log("okx", `Rate limited: ${url}`);
      return null;
    }

    if (!res.ok) {
      log("okx", `HTTP ${res.status}: ${url}`);
      return null;
    }

    return await res.json();
  } catch (e) {
    log("okx", `Fetch error: ${e.message}`);
    return null;
  }
}

function formatUsd(value) {
  if (value == null || Number.isNaN(value)) return "$0";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${Math.round(value)}`;
}

function humanWalletType(code) {
  if (String(code) === "1") return "smart_money";
  if (String(code) === "2") return "kol";
  if (String(code) === "3") return "whale";
  return "unknown";
}

function summarizeSignalMetrics(metrics) {
  if (!metrics) return "unavailable";
  if (!metrics.signal_present) return "none in latest OKX signal feed";
  return `latest=${metrics.latest_signal_age_min ?? "?"}m | count_30m=${metrics.signal_count_30m} | count_2h=${metrics.signal_count_2h} | usd_30m=${formatUsd(metrics.signal_amount_usd_30m)} | usd_2h=${formatUsd(metrics.signal_amount_usd_2h)} | sold_ratio=${metrics.latest_sold_ratio_percent ?? "?"}% | by_type_30m S/K/W=${metrics.smart_money_count_30m}/${metrics.kol_count_30m}/${metrics.whale_count_30m}`;
}

function buildSignalMetrics(rows, tokenAddress, now = Date.now()) {
  if (!rows?.length) {
    return {
      signal_present: false,
      latest_signal_age_min: null,
      signal_count_30m: 0,
      signal_count_2h: 0,
      signal_amount_usd_30m: 0,
      signal_amount_usd_2h: 0,
      latest_sold_ratio_percent: null,
      smart_money_count_30m: 0,
      smart_money_count_2h: 0,
      kol_count_30m: 0,
      kol_count_2h: 0,
      whale_count_30m: 0,
      whale_count_2h: 0,
      latest_wallet_type: null,
      latest_trigger_wallet_count: 0,
      latest_signal_timestamp: null,
      token_address: tokenAddress,
      summary: "none in latest OKX signal feed",
    };
  }

  const cutoff30m = now - (30 * 60_000);
  const cutoff2h = now - (2 * 60 * 60_000);
  const metrics = {
    signal_present: true,
    latest_signal_age_min: null,
    signal_count_30m: 0,
    signal_count_2h: 0,
    signal_amount_usd_30m: 0,
    signal_amount_usd_2h: 0,
    latest_sold_ratio_percent: null,
    smart_money_count_30m: 0,
    smart_money_count_2h: 0,
    kol_count_30m: 0,
    kol_count_2h: 0,
    whale_count_30m: 0,
    whale_count_2h: 0,
    latest_wallet_type: null,
    latest_trigger_wallet_count: 0,
    latest_signal_timestamp: null,
    token_address: tokenAddress,
  };

  for (const row of rows) {
    const ts = Number(row?.timestamp || 0);
    if (!Number.isFinite(ts) || ts <= 0) continue;

    const walletType = humanWalletType(row?.walletType);
    const amount = Number.parseFloat(row?.amountUsd || 0) || 0;
    const within30m = ts >= cutoff30m;
    const within2h = ts >= cutoff2h;

    if (within30m) {
      metrics.signal_count_30m += 1;
      metrics.signal_amount_usd_30m += amount;
      if (walletType === "smart_money") metrics.smart_money_count_30m += 1;
      if (walletType === "kol") metrics.kol_count_30m += 1;
      if (walletType === "whale") metrics.whale_count_30m += 1;
    }

    if (within2h) {
      metrics.signal_count_2h += 1;
      metrics.signal_amount_usd_2h += amount;
      if (walletType === "smart_money") metrics.smart_money_count_2h += 1;
      if (walletType === "kol") metrics.kol_count_2h += 1;
      if (walletType === "whale") metrics.whale_count_2h += 1;
    }
  }

  const latest = rows
    .slice()
    .sort((a, b) => Number(b?.timestamp || 0) - Number(a?.timestamp || 0))[0];
  const latestTs = Number(latest?.timestamp || 0);
  metrics.latest_signal_timestamp = latestTs || null;
  metrics.latest_signal_age_min = latestTs > 0
    ? Math.max(0, Math.round((now - latestTs) / 60_000))
    : null;
  metrics.latest_sold_ratio_percent = latest?.soldRatioPercent != null
    ? Number.parseFloat(latest.soldRatioPercent)
    : null;
  metrics.latest_wallet_type = humanWalletType(latest?.walletType);
  metrics.latest_trigger_wallet_count = Number.parseInt(latest?.triggerWalletCount || "0", 10) || 0;
  metrics.signal_amount_usd_30m = Math.round(metrics.signal_amount_usd_30m * 100) / 100;
  metrics.signal_amount_usd_2h = Math.round(metrics.signal_amount_usd_2h * 100) / 100;
  metrics.summary = summarizeSignalMetrics(metrics);
  return metrics;
}

/**
 * Fetch the latest Solana signal feed snapshot once, then derive per-token
 * recency metrics from that shared snapshot.
 */
export async function fetchOkxDexSignalSnapshot() {
  if (_signalSnapshot && Date.now() < _signalSnapshotExpiresAt) {
    return _signalSnapshot;
  }
  if (_signalSnapshotInflight) {
    return _signalSnapshotInflight;
  }

  _signalSnapshotInflight = (async () => {
    const json = await fetchOkxJson(OKX_SIGNAL_URL, {
      method: "POST",
      body: JSON.stringify({
        chainIndex: "501",
        walletType: "1,2,3",
      }),
    });

    if (!json) {
      return _signalSnapshot || new Map();
    }

    const rows = Array.isArray(json.data) ? json.data : [];
    const grouped = new Map();
    for (const row of rows) {
      const tokenAddress = row?.token?.tokenAddress;
      if (!tokenAddress) continue;
      if (!grouped.has(tokenAddress)) grouped.set(tokenAddress, []);
      grouped.get(tokenAddress).push(row);
    }

    const snapshot = new Map();
    const now = Date.now();
    for (const [tokenAddress, tokenRows] of grouped.entries()) {
      snapshot.set(tokenAddress, buildSignalMetrics(tokenRows, tokenAddress, now));
    }

    _signalSnapshot = snapshot;
    _signalSnapshotExpiresAt = Date.now() + (rows.length > 0 ? SIGNAL_SNAPSHOT_TTL : SIGNAL_EMPTY_TTL);
    return snapshot;
  })().finally(() => {
    _signalSnapshotInflight = null;
  });

  return _signalSnapshotInflight;
}

/**
 * Get derived OKX signal metrics for a single mint from the shared snapshot.
 */
export async function fetchOkxDexSignal(mint) {
  if (!mint) return null;
  const cached = readCache(_signalCache, mint);
  if (cached) return cached;

  try {
    const snapshot = await fetchOkxDexSignalSnapshot();
    const result = snapshot.get(mint) || buildSignalMetrics([], mint);
    writeCache(_signalCache, mint, result, result.signal_present ? SIGNAL_SNAPSHOT_TTL : SIGNAL_EMPTY_TTL);
    return result;
  } catch (e) {
    log("okx", `Signal fetch error for ${mint.slice(0, 8)}: ${e.message}`);
    return null;
  }
}

/**
 * Fetch 6x 5m candles and summarize into actionable signals.
 */
async function fetchCandleSummary(mint) {
  const json = await fetchOkxJson(`${OKX_CANDLES_URL}?chainIndex=501&tokenContractAddress=${mint}&bar=5m&limit=6`);
  if (!json) return null;
  const candles = json?.data;
  if (!candles?.length) return null;

  const vols = candles.map((c) => parseFloat(c[6] || 0));
  const closes = candles.map((c) => parseFloat(c[4] || 0));
  const highs = candles.map((c) => parseFloat(c[2] || 0));
  const lows = candles.map((c) => parseFloat(c[3] || 0));

  const firstAvg = vols.slice(0, 3).reduce((s, v) => s + v, 0) / 3;
  const lastAvg = vols.slice(-3).reduce((s, v) => s + v, 0) / 3;
  const volume_trend = lastAvg > firstAvg * 1.2 ? "increasing"
    : lastAvg < firstAvg * 0.8 ? "decreasing" : "stable";
  const volume_dying = vols.filter((v) => v < 10).length >= 3;

  const firstClose = closes[0] || 0;
  const lastClose = closes[closes.length - 1] || 0;
  const changePct = firstClose > 0 ? ((lastClose - firstClose) / firstClose) * 100 : 0;
  const price_direction = changePct > 2 ? "up" : changePct < -2 ? "down" : "ranging";

  const allHigh = Math.max(...highs);
  const allLow = Math.min(...lows.filter((l) => l > 0));
  const price_range_pct = allLow > 0 ? Math.round(((allHigh - allLow) / allLow) * 1000) / 10 : 0;

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
    latest_3_volumes_usd: vols.slice(-3).map((v) => Math.round(v)),
  };
}

/**
 * Fetch price info including ATH, momentum, and 5m candle summary.
 */
export async function fetchOkxPriceInfo(mint) {
  if (!mint) return null;

  const cached = readCache(_priceCache, mint);
  if (cached) return cached;

  try {
    const [priceJson, candles] = await Promise.all([
      fetchOkxJson(OKX_PRICE_URL, {
        method: "POST",
        body: JSON.stringify([{ chainIndex: "501", tokenContractAddress: mint }]),
      }),
      fetchCandleSummary(mint),
    ]);

    if (!priceJson) return null;

    const d = priceJson?.data?.[0] || priceJson?.[0] || null;
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
      candles: candles || null,
    };

    writeCache(_priceCache, mint, data, PRICE_CACHE_TTL);
    return data;
  } catch (e) {
    log("okx", `Fetch error for ${mint.slice(0, 8)}: ${e.message}`);
    return null;
  }
}
