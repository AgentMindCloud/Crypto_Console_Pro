/**
 * Crypto Console Pro — app.js
 * Real-time futures signal dashboard
 * Combines 14 live data streams from Binance, Bybit & OKX
 * into one clear signal per coin: LONG · SHORT · STAY OUT
 */

'use strict';

/* ═══════════════════════════════════════════════
   CONFIG
═══════════════════════════════════════════════ */
const UPDATE_INTERVAL_MS = 20_000; // 20 seconds
const FETCH_TIMEOUT_MS   = 8_000;  // 8-second per-request timeout
// Worst-case fetch time: all per-coin requests are parallelised within each
// exchange batch, so the ceiling is ~FETCH_TIMEOUT_MS (~8 s), well under
// the 20-second update interval.

/** Number of order-book price levels to include in imbalance calculation */
const ORDER_BOOK_DEPTH = 20;

/**
 * Funding-rate thresholds used in the signal engine.
 * Funding is expressed as a decimal rate (e.g. 0.0001 = 0.01%).
 * Contrarian interpretation: negative funding → longs are paid → bullish lean.
 */
const FUNDING = {
  NEGATIVE_MAX:   -0.0001,  // below this = clear negative funding (bull signal)
  NEUTRAL_MAX:     0.0003,  // below this = roughly neutral
  ELEVATED_MIN:    0.0005,  // above this = elevated positive funding (mild bear)
  HIGH_MIN:        0.001,   // above this = high positive funding (strong bear)
};

/** Free-tier coins shown in main dashboard */
const FREE_COINS = [
  { symbol: 'BTC',  binance: 'BTCUSDT',  bybit: 'BTCUSDT',  okx: 'BTC-USDT-SWAP',  icon: '₿'  },
  { symbol: 'ETH',  binance: 'ETHUSDT',  bybit: 'ETHUSDT',  okx: 'ETH-USDT-SWAP',  icon: 'Ξ'  },
  { symbol: 'SOL',  binance: 'SOLUSDT',  bybit: 'SOLUSDT',  okx: 'SOL-USDT-SWAP',  icon: '◎'  },
  { symbol: 'BNB',  binance: 'BNBUSDT',  bybit: 'BNBUSDT',  okx: 'BNB-USDT-SWAP',  icon: 'B'  },
  { symbol: 'XRP',  binance: 'XRPUSDT',  bybit: 'XRPUSDT',  okx: 'XRP-USDT-SWAP',  icon: 'X'  },
  { symbol: 'DOGE', binance: 'DOGEUSDT', bybit: 'DOGEUSDT', okx: 'DOGE-USDT-SWAP', icon: 'Ð'  },
  { symbol: 'ADA',  binance: 'ADAUSDT',  bybit: 'ADAUSDT',  okx: 'ADA-USDT-SWAP',  icon: 'A'  },
  { symbol: 'AVAX', binance: 'AVAXUSDT', bybit: 'AVAXUSDT', okx: 'AVAX-USDT-SWAP', icon: 'AV' },
  { symbol: 'LINK', binance: 'LINKUSDT', bybit: 'LINKUSDT', okx: 'LINK-USDT-SWAP', icon: '⬡'  },
  { symbol: 'DOT',  binance: 'DOTUSDT',  bybit: 'DOTUSDT',  okx: 'DOT-USDT-SWAP',  icon: '◉'  },
];

/** Pro-locked coins (teaser) */
const PRO_COINS = [
  'MATIC', 'UNI', 'ATOM', 'LTC', 'APT',
];

/* ═══════════════════════════════════════════════
   API ENDPOINTS
═══════════════════════════════════════════════ */
const API = {
  // Stream 1 — Binance futures 24h tickers (price, change, volume)
  binance24h: 'https://fapi.binance.com/fapi/v1/ticker/24hr',
  // Stream 2 — Binance funding rates + mark price
  binanceFunding: 'https://fapi.binance.com/fapi/v1/premiumIndex',
  // Stream 3 — Binance order book (per coin, built dynamically)
  binanceDepth: (sym) => `https://fapi.binance.com/fapi/v1/depth?symbol=${sym}&limit=${ORDER_BOOK_DEPTH}`,
  // Stream 4 — Binance open interest (per coin)
  binanceOI: (sym) => `https://fapi.binance.com/fapi/v1/openInterest?symbol=${sym}`,

  // Stream 5 — Bybit linear tickers (price, change, funding, OI, volume)
  bybitTickers: 'https://api.bybit.com/v5/market/tickers?category=linear',
  // Stream 6 — Bybit funding rates (included in tickers, counted as separate stream)
  // Stream 7 — Bybit order book (per coin)
  bybitDepth: (sym) => `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${sym}&limit=25`,
  // Stream 8 — Bybit open interest (per coin)
  bybitOI: (sym) => `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${sym}&intervalTime=5min&limit=1`,

  // Stream 9 — OKX swap tickers (price, change, volume)
  okxTickers: 'https://www.okx.com/api/v5/market/tickers?instType=SWAP',
  // Stream 10 — OKX funding rate (per coin)
  okxFunding: (id) => `https://www.okx.com/api/v5/public/funding-rate?instId=${id}`,
  // Stream 11 — OKX order book (per coin)
  okxDepth: (id) => `https://www.okx.com/api/v5/market/books?instId=${id}&sz=20`,
  // Stream 12 — OKX open interest (per coin)
  okxOI: (id) => `https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${id}`,
  // Stream 13 — Cross-exchange consensus (computed)
  // Stream 14 — Aggregate signal score (computed)
};

/* ═══════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════ */
async function fetchJSON(url, label = '') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    const msg = e.name === 'AbortError'
      ? `timed out after ${FETCH_TIMEOUT_MS}ms`
      : e.message;
    console.warn(`[fetch] ${label || url}: ${msg}`);
    return null;
  }
}

const avg = (arr) => {
  const vals = arr.filter((v) => v !== null && v !== undefined && !isNaN(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
};

const numFmt = (n, decimals) => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  if (decimals !== undefined) return n.toFixed(decimals);
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 100) return n.toFixed(2);
  if (Math.abs(n) >= 1)   return n.toFixed(3);
  return n.toFixed(5);
};

const pctFmt = (n) => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const s = n >= 0 ? '+' : '';
  return `${s}${n.toFixed(2)}%`;
};

const fundingFmt = (n) => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const s = n >= 0 ? '+' : '';
  return `${s}${(n * 100).toFixed(4)}%`;
};

/* ═══════════════════════════════════════════════
   DATA FETCHING — all 14 streams
═══════════════════════════════════════════════ */

/** Stream 1 + 2: Binance futures — fetch all tickers + all funding in 2 calls */
async function fetchBinanceBase() {
  const [tickersRaw, fundingRaw] = await Promise.all([
    fetchJSON(API.binance24h, 'Binance 24h'),
    fetchJSON(API.binanceFunding, 'Binance Funding'),
  ]);

  const tickers = {};
  if (Array.isArray(tickersRaw)) {
    for (const t of tickersRaw) {
      tickers[t.symbol] = {
        price:     parseFloat(t.lastPrice),
        change24h: parseFloat(t.priceChangePercent),
        volume:    parseFloat(t.quoteVolume),
      };
    }
  }

  const funding = {};
  if (Array.isArray(fundingRaw)) {
    for (const f of fundingRaw) {
      funding[f.symbol] = parseFloat(f.lastFundingRate);
    }
  }

  return { tickers, funding };
}

/** Stream 3: Binance order book depth per coin */
async function fetchBinanceDepths(coins) {
  const results = await Promise.all(
    coins.map((c) => fetchJSON(API.binanceDepth(c.binance), `Binance OB ${c.symbol}`))
  );
  const depths = {};
  for (let i = 0; i < coins.length; i++) {
    depths[coins[i].symbol] = parseOrderBook(results[i]);
  }
  return depths;
}

/** Stream 4: Binance open interest per coin */
async function fetchBinanceOI(coins) {
  const results = await Promise.all(
    coins.map((c) => fetchJSON(API.binanceOI(c.binance), `Binance OI ${c.symbol}`))
  );
  const oi = {};
  for (let i = 0; i < coins.length; i++) {
    const r = results[i];
    oi[coins[i].symbol] = r ? parseFloat(r.openInterest) : null;
  }
  return oi;
}

/** Stream 5 + 6: Bybit tickers (includes funding) in 1 call */
async function fetchBybitBase() {
  const raw = await fetchJSON(API.bybitTickers, 'Bybit Tickers');
  const tickers = {};
  if (raw?.result?.list) {
    for (const t of raw.result.list) {
      if (!t.symbol.endsWith('USDT')) continue;
      tickers[t.symbol] = {
        price:       parseFloat(t.lastPrice),
        change24h:   parseFloat(t.price24hPcnt) * 100,
        fundingRate: parseFloat(t.fundingRate),
        openInterest:parseFloat(t.openInterestValue),
        volume:      parseFloat(t.turnover24h),
      };
    }
  }
  return tickers;
}

/** Stream 7: Bybit order book per coin */
async function fetchBybitDepths(coins) {
  const results = await Promise.all(
    coins.map((c) => fetchJSON(API.bybitDepth(c.bybit), `Bybit OB ${c.symbol}`))
  );
  const depths = {};
  for (let i = 0; i < coins.length; i++) {
    const r = results[i]?.result;
    if (r) {
      depths[coins[i].symbol] = parseOrderBook({ bids: r.b, asks: r.a });
    } else {
      depths[coins[i].symbol] = null;
    }
  }
  return depths;
}

/** Stream 8: Bybit open interest per coin (already in tickers, kept as separate stream) */
function extractBybitOI(tickers, coins) {
  const oi = {};
  for (const c of coins) {
    oi[c.symbol] = tickers[c.bybit]?.openInterest ?? null;
  }
  return oi;
}

/** Stream 9: OKX tickers in 1 call */
async function fetchOKXBase() {
  const raw = await fetchJSON(API.okxTickers, 'OKX Tickers');
  const tickers = {};
  if (raw?.data) {
    for (const t of raw.data) {
      if (!t.instId.endsWith('USDT-SWAP')) continue;
      const open24h = parseFloat(t.open24h);
      const last    = parseFloat(t.last);
      const chg     = open24h > 0 ? ((last - open24h) / open24h) * 100 : null;
      tickers[t.instId] = {
        price:     last,
        change24h: chg,
        volume:    parseFloat(t.volCcy24h),
      };
    }
  }
  return tickers;
}

/** Stream 10: OKX funding rates per coin */
async function fetchOKXFunding(coins) {
  const results = await Promise.all(
    coins.map((c) => fetchJSON(API.okxFunding(c.okx), `OKX Funding ${c.symbol}`))
  );
  const funding = {};
  for (let i = 0; i < coins.length; i++) {
    const r = results[i]?.data?.[0];
    funding[coins[i].symbol] = r ? parseFloat(r.fundingRate) : null;
  }
  return funding;
}

/** Stream 11: OKX order book per coin */
async function fetchOKXDepths(coins) {
  const results = await Promise.all(
    coins.map((c) => fetchJSON(API.okxDepth(c.okx), `OKX OB ${c.symbol}`))
  );
  const depths = {};
  for (let i = 0; i < coins.length; i++) {
    const r = results[i]?.data?.[0];
    if (r) {
      depths[coins[i].symbol] = parseOrderBook({ bids: r.bids, asks: r.asks });
    } else {
      depths[coins[i].symbol] = null;
    }
  }
  return depths;
}

/** Stream 12: OKX open interest per coin */
async function fetchOKXOI(coins) {
  const results = await Promise.all(
    coins.map((c) => fetchJSON(API.okxOI(c.okx), `OKX OI ${c.symbol}`))
  );
  const oi = {};
  for (let i = 0; i < coins.length; i++) {
    const r = results[i]?.data?.[0];
    oi[coins[i].symbol] = r ? parseFloat(r.oiCcy) : null;
  }
  return oi;
}

/** Parse a raw order-book response into a bid/ask volume ratio */
function parseOrderBook(raw) {
  if (!raw) return null;
  const bids = raw.bids || [];
  const asks = raw.asks || [];
  const bidVol = bids.slice(0, ORDER_BOOK_DEPTH).reduce((s, lvl) => s + parseFloat(lvl[1] || 0), 0);
  const askVol = asks.slice(0, ORDER_BOOK_DEPTH).reduce((s, lvl) => s + parseFloat(lvl[1] || 0), 0);
  if (askVol === 0) return null;
  return bidVol / askVol;
}

/* ═══════════════════════════════════════════════
   AGGREGATE ALL STREAMS
   Streams 13 (cross-exchange consensus) and
   14 (aggregate signal score) are computed here.
═══════════════════════════════════════════════ */
async function fetchAllData() {
  // Fire all exchange base calls in parallel (streams 1-2, 5-6, 9)
  const [binanceBase, bybitTickers, okxTickers] = await Promise.all([
    fetchBinanceBase(),
    fetchBybitBase(),
    fetchOKXBase(),
  ]);

  // Fire per-coin calls in parallel (streams 3-4, 7-8, 10-12)
  const [
    binanceDepths,
    binanceOI,
    bybitDepths,
    okxFunding,
    okxDepths,
    okxOI,
  ] = await Promise.all([
    fetchBinanceDepths(FREE_COINS),
    fetchBinanceOI(FREE_COINS),
    fetchBybitDepths(FREE_COINS),
    fetchOKXFunding(FREE_COINS),
    fetchOKXDepths(FREE_COINS),
    fetchOKXOI(FREE_COINS),
  ]);

  const bybitOI = extractBybitOI(bybitTickers, FREE_COINS);

  // Assemble per-coin data objects
  const coins = {};
  for (const coin of FREE_COINS) {
    const bnTicker = binanceBase.tickers[coin.binance] ?? {};
    const bbTicker = bybitTickers[coin.bybit]          ?? {};
    const okTicker = okxTickers[coin.okx]              ?? {};

    coins[coin.symbol] = {
      meta: coin,
      binance: {
        price:       bnTicker.price       ?? null,
        change24h:   bnTicker.change24h   ?? null,
        fundingRate: binanceBase.funding[coin.binance] ?? null,
        obRatio:     binanceDepths[coin.symbol]        ?? null,
        openInterest:binanceOI[coin.symbol]            ?? null,
      },
      bybit: {
        price:       bbTicker.price       ?? null,
        change24h:   bbTicker.change24h   ?? null,
        fundingRate: bbTicker.fundingRate ?? null,
        obRatio:     bybitDepths[coin.symbol]  ?? null,
        openInterest:bybitOI[coin.symbol]      ?? null,
      },
      okx: {
        price:       okTicker.price       ?? null,
        change24h:   okTicker.change24h   ?? null,
        fundingRate: okxFunding[coin.symbol]   ?? null,
        obRatio:     okxDepths[coin.symbol]    ?? null,
        openInterest:okxOI[coin.symbol]        ?? null,
      },
    };
  }

  return coins;
}

/* ═══════════════════════════════════════════════
   SIGNAL ENGINE
   Stream 13 — cross-exchange consensus
   Stream 14 — aggregate signal score → LONG / SHORT / STAY OUT

   Scoring methodology (each factor contributes to a running score):
   • Price Momentum    — avg 24h change: >3% → +1.5, >1% → +0.75 (mirror for bear)
   • Funding Rate      — contrarian: negative funding favours longs; high positive
                         funding crowds longs and therefore favours shorts
   • Order Book Ratio  — bid/ask volume ratio: >1.4 → +1, <0.7 → −1
   • Cross-Exchange    — all three exchanges agree on direction → ±0.5
   • Funding Extremity — all exchanges show same funding direction → ±0.5
   Thresholds (3%, 1%, etc.) are calibrated for typical crypto futures
   volatility; they represent practical momentum, not arbitrary values.
   Final: score ≥ +2 → LONG · score ≤ −2 → SHORT · otherwise → STAY OUT
═══════════════════════════════════════════════ */
function computeSignal(coinData) {
  let score = 0;
  const factors = [];

  const { binance: bn, bybit: bb, okx: ok } = coinData;

  /* ── Factor 1: Price Momentum (avg 24h change) ── */
  const avgChange = avg([bn.change24h, bb.change24h, ok.change24h]);
  if (avgChange !== null) {
    if (avgChange > 3)        { score += 1.5; factors.push({ label: 'strong momentum ↑', type: 'bull' }); }
    else if (avgChange > 1)   { score += 0.75; factors.push({ label: 'momentum ↑', type: 'bull' }); }
    else if (avgChange < -3)  { score -= 1.5; factors.push({ label: 'strong momentum ↓', type: 'bear' }); }
    else if (avgChange < -1)  { score -= 0.75; factors.push({ label: 'momentum ↓', type: 'bear' }); }
  }

  /* ── Factor 2: Funding Rate (contrarian) ── */
  const avgFunding = avg([bn.fundingRate, bb.fundingRate, ok.fundingRate]);
  if (avgFunding !== null) {
    if (avgFunding < FUNDING.NEGATIVE_MAX)      { score += 1;   factors.push({ label: 'negative funding', type: 'bull' }); }
    else if (avgFunding < FUNDING.NEUTRAL_MAX)  { /* neutral */ }
    else if (avgFunding > FUNDING.HIGH_MIN)     { score -= 1.5; factors.push({ label: 'high funding rate', type: 'bear' }); }
    else if (avgFunding > FUNDING.ELEVATED_MIN) { score -= 0.75;factors.push({ label: 'elevated funding', type: 'bear' }); }
  }

  /* ── Factor 3: Order Book Imbalance (per exchange) ── */
  const avgOB = avg([bn.obRatio, bb.obRatio, ok.obRatio]);
  if (avgOB !== null) {
    if (avgOB > 1.4)      { score += 1;    factors.push({ label: 'strong bid pressure', type: 'bull' }); }
    else if (avgOB > 1.15){ score += 0.5;  factors.push({ label: 'bid pressure', type: 'bull' }); }
    else if (avgOB < 0.7) { score -= 1;    factors.push({ label: 'ask pressure', type: 'bear' }); }
    else if (avgOB < 0.85){ score -= 0.5;  factors.push({ label: 'slight ask pressure', type: 'bear' }); }
  }

  /* ── Factor 4: Cross-Exchange Consensus (Stream 13) ── */
  const changes = [bn.change24h, bb.change24h, ok.change24h].filter((v) => v !== null);
  if (changes.length >= 2) {
    const allBull = changes.every((c) => c > 0.5);
    const allBear = changes.every((c) => c < -0.5);
    const mixed   = !allBull && !allBear;
    if (allBull)       { score += 0.5; factors.push({ label: 'cross-exchange bullish', type: 'bull' }); }
    else if (allBear)  { score -= 0.5; factors.push({ label: 'cross-exchange bearish', type: 'bear' }); }
    else if (mixed)    { factors.push({ label: 'mixed exchanges', type: 'neu' }); }
  }

  /* ── Factor 5: Funding extremity confirmation ── */
  const fundings = [bn.fundingRate, bb.fundingRate, ok.fundingRate].filter((v) => v !== null);
  const allNegFunding = fundings.length >= 2 && fundings.every((f) => f < FUNDING.NEGATIVE_MAX);
  const allPosFunding = fundings.length >= 2 && fundings.every((f) => f > FUNDING.ELEVATED_MIN);
  if (allNegFunding) { score += 0.5; factors.push({ label: 'all exchanges neg.funding', type: 'bull' }); }
  if (allPosFunding) { score -= 0.5; factors.push({ label: 'all exchanges pos.funding', type: 'bear' }); }

  /* ── Derive signal (Stream 14) ── */
  let signal;
  if      (score >= 2)  signal = 'LONG';
  else if (score <= -2) signal = 'SHORT';
  else                   signal = 'STAY OUT';

  const bestPrice = avg([bn.price, bb.price, ok.price]);

  return {
    signal,
    score: Math.round(score * 10) / 10,
    factors,
    avgChange,
    avgFunding,
    avgOB,
    bestPrice,
  };
}

/* ═══════════════════════════════════════════════
   RENDER
═══════════════════════════════════════════════ */
function renderDashboard(allCoinData) {
  const dashboard = document.getElementById('dashboard');
  const now = new Date().toLocaleTimeString();

  // Remove loading overlay
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) overlay.remove();

  for (const coin of FREE_COINS) {
    const data   = allCoinData[coin.symbol];
    const result = computeSignal(data);

    const existingCard = document.getElementById(`card-${coin.symbol}`);

    const signalClass = result.signal === 'LONG' ? 'long'
                      : result.signal === 'SHORT' ? 'short'
                      : 'stay';

    const badgeClass = result.signal === 'LONG' ? 'badge--long'
                     : result.signal === 'SHORT' ? 'badge--short'
                     : 'badge--stay';

    // Score bar: fills from the centre (50%) outward.
    // Positive score → bar extends right; negative → bar extends left.
    const maxScore = 5;
    const absScore = Math.min(Math.abs(result.score), maxScore);
    const pct      = (absScore / maxScore) * 100;
    const barColor = result.signal === 'LONG' ? 'var(--green)'
                   : result.signal === 'SHORT' ? 'var(--red)'
                   : 'var(--yellow)';
    const barLeft  = result.score >= 0 ? '50%' : `${50 - pct / 2}%`;
    const barWidth = `${pct / 2}%`;

    const scoreColor = result.signal === 'LONG' ? 'var(--green)'
                     : result.signal === 'SHORT' ? 'var(--red)'
                     : 'var(--yellow)';

    const changeVal  = result.avgChange;
    const changeStr  = pctFmt(changeVal);
    const changeDir  = changeVal === null ? 'flat' : changeVal > 0 ? 'up' : 'down';

    const priceStr   = numFmt(result.bestPrice);

    const factorHTML = result.factors.map(
      (f) => `<span class="factor-tag ${f.type}">${f.label}</span>`
    ).join('');

    const exRows = buildExchangeRows(data, result.avgFunding, result.avgOB);

    const cardHTML = `
      <div class="card-header">
        <div class="coin-name">
          <div class="coin-icon">${coin.icon}</div>
          <div>
            <div class="coin-symbol">${coin.symbol}</div>
            <div class="coin-pair">${coin.symbol}/USDT PERP</div>
          </div>
        </div>
        <span class="badge badge--lg ${badgeClass}">${result.signal}</span>
      </div>

      <div class="price-row">
        <span class="price-main">$${priceStr}</span>
        <span class="price-change ${changeDir}">${changeStr}</span>
      </div>

      <div class="exchange-rows">
        <div class="exchange-header">
          <span>Exchange</span>
          <span style="text-align:right">Price</span>
          <span style="text-align:right">Funding</span>
          <span style="text-align:right">OB</span>
        </div>
        ${exRows}
      </div>

      <div class="score-row">
        <span class="score-label">SIGNAL SCORE</span>
        <div class="score-bar-wrap">
          <div class="score-bar-fill" style="
            left:${barLeft};
            width:${barWidth};
            background:${barColor};
          "></div>
        </div>
        <span class="score-value" style="color:${scoreColor}">
          ${result.score >= 0 ? '+' : ''}${result.score}
        </span>
      </div>

      ${result.factors.length ? `<div class="factors-row">${factorHTML}</div>` : ''}

      <div class="card-footer">Updated ${now}</div>
    `;

    if (existingCard) {
      existingCard.className = `coin-card ${signalClass}`;
      existingCard.innerHTML = cardHTML;
    } else {
      const card = document.createElement('div');
      card.className = `coin-card ${signalClass}`;
      card.id        = `card-${coin.symbol}`;
      card.innerHTML = cardHTML;
      dashboard.appendChild(card);
    }
  }
}

function buildExchangeRows(data, avgFunding, avgOB) {
  const exchanges = [
    { name: 'Binance', d: data.binance },
    { name: 'Bybit',   d: data.bybit   },
    { name: 'OKX',     d: data.okx     },
  ];

  return exchanges.map(({ name, d }) => {
    const price   = d.price    !== null ? `$${numFmt(d.price)}`          : '—';
    const funding = d.fundingRate !== null ? fundingFmt(d.fundingRate)   : '—';
    const ob      = d.obRatio  !== null ? d.obRatio.toFixed(2)           : '—';

    const fundingClass = d.fundingRate === null        ? 'neu'
                       : d.fundingRate < FUNDING.NEGATIVE_MAX ? 'neg'
                       : d.fundingRate > FUNDING.ELEVATED_MIN ? 'pos'
                       : 'neu';

    const obClass = d.obRatio === null ? 'neu'
                  : d.obRatio > 1.15  ? 'bull'
                  : d.obRatio < 0.85  ? 'bear'
                  : 'neu';

    return `
      <div class="exchange-row">
        <span class="ex-name">${name}</span>
        <span class="ex-price">${price}</span>
        <span class="ex-funding ${fundingClass}">${funding}</span>
        <span class="ex-ob ${obClass}">${ob}</span>
      </div>
    `;
  }).join('');
}

function renderProSection() {
  const section = document.getElementById('proSection');
  const grid    = document.getElementById('proGrid');
  if (!section || !grid) return;

  grid.innerHTML = PRO_COINS.map((sym) => `
    <div class="coin-card--locked">
      <div class="locked-coin-name">${sym}/USDT</div>
      <span class="locked-badge">PRO</span>
    </div>
  `).join('');

  section.style.display = 'block';
}

/* ═══════════════════════════════════════════════
   STATUS UI
═══════════════════════════════════════════════ */
function setStatus(state, text) {
  const dot  = document.getElementById('statusDot');
  const span = document.getElementById('statusText');
  if (!dot || !span) return;
  dot.className  = `status-dot ${state}`;
  span.textContent = text;
}

/* ═══════════════════════════════════════════════
   STREAM BAR — duplicate items so marquee loops
═══════════════════════════════════════════════ */
function initStreamBar() {
  const bar = document.getElementById('streamBar');
  if (!bar) return;
  // Duplicate content for seamless loop
  bar.innerHTML += bar.innerHTML;
}

/* ═══════════════════════════════════════════════
   COUNTDOWN TIMER
═══════════════════════════════════════════════ */
let countdownValue = UPDATE_INTERVAL_MS / 1000;
let countdownTimer = null;

function startCountdown() {
  clearInterval(countdownTimer);
  countdownValue = UPDATE_INTERVAL_MS / 1000;
  const el = document.getElementById('countdown');
  if (el) el.textContent = countdownValue;

  countdownTimer = setInterval(() => {
    countdownValue = Math.max(0, countdownValue - 1);
    if (el) el.textContent = countdownValue;
  }, 1000);
}

/* ═══════════════════════════════════════════════
   MAIN UPDATE CYCLE
═══════════════════════════════════════════════ */
let updateTimer = null;
let isUpdating  = false;

async function update() {
  if (isUpdating) return;
  isUpdating = true;
  setStatus('loading', 'Fetching live data…');
  startCountdown();

  try {
    const data = await fetchAllData();
    renderDashboard(data);
    setStatus('live', 'Live');
  } catch (err) {
    console.error('[update]', err);
    setStatus('error', 'Error — retrying…');
  } finally {
    isUpdating = false;
  }
}

function scheduleUpdate() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(async () => {
    await update();
    if (autoRefreshEnabled()) scheduleUpdate();
  }, UPDATE_INTERVAL_MS);
}

function autoRefreshEnabled() {
  const toggle = document.getElementById('autoRefreshToggle');
  return toggle ? toggle.checked : true;
}

/* ═══════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  initStreamBar();
  renderProSection();

  // Auto-refresh toggle
  const toggle = document.getElementById('autoRefreshToggle');
  if (toggle) {
    toggle.addEventListener('change', () => {
      if (toggle.checked) {
        scheduleUpdate();
      } else {
        clearTimeout(updateTimer);
        setStatus('live', 'Paused');
      }
    });
  }

  // First load
  update().then(() => {
    if (autoRefreshEnabled()) scheduleUpdate();
  });
});
