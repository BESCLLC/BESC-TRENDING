import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { DateTime } from 'luxon';

const {
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  POLL_INTERVAL_MINUTES = '10',
  TRENDING_SIZE = '5',
  HYPERCHARTS_BASE = 'https://api.beschypercharts.com'
} = process.env;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID)
  throw new Error('Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID');

const bot = new TelegramBot(TELEGRAM_TOKEN);
let lastPinnedId = null;

function fmtUsd(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
}

async function fetchPairs() {
  const { data } = await axios.get(`${HYPERCHARTS_BASE}/token/pairs/all`, { timeout: 20000 });
  return (data?.success?.data || []).filter(p => (p.liquidityUsd ?? 0) > 50); // filter out zero-liquidity junk
}

async function fetchTokenInfo(address) {
  try {
    const { data } = await axios.get(`${HYPERCHARTS_BASE}/token/info/${address}`, { timeout: 15000 });
    return data?.data || null;
  } catch {
    return null;
  }
}

async function fetchRecentTxs(pairAddress) {
  const from = Math.floor(DateTime.utc().minus({ minutes: Number(POLL_INTERVAL_MINUTES) }).toSeconds());
  const to = Math.floor(DateTime.utc().toSeconds());
  try {
    const { data } = await axios.get(
      `${HYPERCHARTS_BASE}/transactions/${pairAddress}?from=${from}&to=${to}`,
      { timeout: 20000 }
    );
    return data?.data || [];
  } catch {
    return [];
  }
}

async function computeTrending() {
  const pairs = await fetchPairs();
  if (!pairs.length) return { trending: [], isFallback: true };

  // Collect unique token addresses
  const tokenAddrs = new Set();
  pairs.forEach(p => {
    if (p.token0?.contract) tokenAddrs.add(p.token0.contract.toLowerCase());
    if (p.token1?.contract) tokenAddrs.add(p.token1.contract.toLowerCase());
  });

  // Fetch token prices in parallel
  const tokenPrices = {};
  await Promise.all(
    [...tokenAddrs].map(async (addr) => {
      const info = await fetchTokenInfo(addr);
      if (info?.pair?.pairInfos?.value) tokenPrices[addr] = Number(info.pair.pairInfos.value);
    })
  );

  const scored = [];
  for (const p of pairs) {
    const txs = await fetchRecentTxs(p.pair);
    if (!txs.length) continue;

    let volUsd = 0;
    for (const tx of txs) {
      const priceIn = tokenPrices[tx.tokenIn?.toLowerCase()] ?? 0;
      const priceOut = tokenPrices[tx.tokenOut?.toLowerCase()] ?? 0;
      volUsd += (Number(tx.amountIn || 0) * priceIn) + (Number(tx.amountOut || 0) * priceOut);
    }

    scored.push({
      pair: p,
      volUsd,
      txCount: txs.length,
      score: volUsd * 0.5 + txs.length * 15
    });
  }

  scored.sort((a, b) => b.score - a.score);

  // fallback if no activity
  if (!scored.length) {
    const fallback = pairs
      .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
      .slice(0, TRENDING_SIZE)
      .map(p => ({ pair: p, volUsd: 0, txCount: p.transactions24h ?? 0, score: 0 }));
    return { trending: fallback, isFallback: true };
  }

  return { trending: scored.slice(0, TRENDING_SIZE), isFallback: false };
}

function formatTrending({ trending, isFallback }) {
  const title = isFallback
    ? `💤 <b>BESC HyperChain — Quiet Market</b>\n📊 Showing top pairs by liquidity:\n`
    : `🔥 <b>BESC HyperChain — Top ${trending.length} Trending</b>\n🕒 Last ${POLL_INTERVAL_MINUTES} min snapshot\n`;

  const lines = [title];

  trending.forEach((x, i) => {
    const t0 = x.pair.token0.symbol || '?';
    const t1 = x.pair.token1.symbol || '?';
    lines.push(
      `${i + 1}️⃣ <b>${t0}/${t1}</b>\n` +
      `💵 Vol: ${fmtUsd(x.volUsd)} | 🧮 Tx: ${x.txCount}\n` +
      `💧 LQ: ${fmtUsd(x.pair.liquidityUsd)}\n` +
      `<a href="https://beschypercharts.com/pair/${x.pair.pair}">View Pair</a>\n`
    );
  });

  return lines.join('\n');
}

async function postTrending() {
  try {
    const result = await computeTrending();

    if (lastPinnedId) {
      await bot.unpinAllChatMessages(TELEGRAM_CHAT_ID).catch(() => {});
      await bot.deleteMessage(TELEGRAM_CHAT_ID, lastPinnedId).catch(() => {});
    }

    const msg = await bot.sendMessage(
      TELEGRAM_CHAT_ID,
      formatTrending(result),
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );

    await bot.pinChatMessage(TELEGRAM_CHAT_ID, msg.message_id, { disable_notification: true });
    lastPinnedId = msg.message_id;

    console.log(`[TrendingBot] ✅ Posted trending (${result.trending.length} pairs)${result.isFallback ? ' [Fallback]' : ''}`);
  } catch (e) {
    console.error('[TrendingBot] Failed to post trending:', e.message);
  }
}

console.log('✅ BESC Trending Bot starting up...');
setInterval(postTrending, Number(POLL_INTERVAL_MINUTES) * 60 * 1000);
postTrending();
