# ⚡ Crypto Console Pro

**Multiple Streams. One Signal.**

A clean, real-time futures trading terminal that combines **14 live data streams** from Binance, Bybit & OKX into one simple signal per coin:

- 🟢 **LONG** — Strong bullish consensus
- 🔴 **SHORT** — Strong bearish consensus
- 🟡 **STAY OUT** — Mixed / insufficient signal

No more tab-switching. No noisy charts. Just one clear dashboard.

---

## Features

- **14 live data streams** — prices, funding rates, order book depth, and open interest from 3 exchanges
- **Cross-exchange validation** — never trust just one platform
- **10 major coins free** — BTC, ETH, SOL, BNB, XRP, DOGE, ADA, AVAX, LINK, DOT
- **Updates every 20 seconds** — fully automatic with pause toggle
- **Works in any browser** — no install, no backend, no login
- **Free for all traders** — paid tier unlocks extra coins and advanced filters

---

## Data Streams (14 total)

| # | Stream | Source |
|---|--------|--------|
| 1 | Futures 24h tickers (price, change, volume) | Binance |
| 2 | Funding rates + mark price | Binance |
| 3 | Order book depth | Binance |
| 4 | Open interest | Binance |
| 5 | Linear futures tickers | Bybit |
| 6 | Funding rates | Bybit |
| 7 | Order book depth | Bybit |
| 8 | Open interest | Bybit |
| 9 | Swap tickers | OKX |
| 10 | Funding rates | OKX |
| 11 | Order book depth | OKX |
| 12 | Open interest | OKX |
| 13 | Cross-exchange price consensus | Computed |
| 14 | Aggregate signal score | Computed |

---

## Signal Algorithm

Each coin is scored on five weighted factors:

1. **Price Momentum** — average 24h change across all three exchanges
2. **Funding Rate** — contrarian indicator (negative funding favours longs; high positive funding favours shorts)
3. **Order Book Imbalance** — bid vs. ask volume ratio from order book depth
4. **Cross-Exchange Consensus** — whether all three exchanges agree on direction
5. **Funding Extremity** — whether funding is negative/positive on every exchange simultaneously

**Score ≥ +2 → LONG · Score ≤ −2 → SHORT · Otherwise → STAY OUT**

---

## Tech Stack

- Pure **HTML + CSS + JavaScript** — no backend, no frameworks
- Runs 100% in the browser
- Responsive design — works on desktop, tablet, and mobile

---

## Usage

Open `index.html` in any modern browser, or host the three files (`index.html`, `style.css`, `app.js`) on any static web host (GitHub Pages, Netlify, Vercel, etc.).

Live Demo: **[cryptoconsole.app](https://cryptoconsole.app)**

---

Made with ❤️ for crypto futures traders  
`#CryptoTrading #Futures #IndieDev #BuildInPublic`
