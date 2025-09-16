import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { DateTime } from 'luxon';

const {
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  POLL_INTERVAL_MINUTES = '5',
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
  try {
    const { data } = await axios.get(`${HYPERCHARTS_BASE}/token/pairs/all`, { timeout: 20000 });
    const pairs = data?.data || data?.success?.data || [];
    return pairs.filter(p => (p.liquidityUsd ?? 0) > 0).slice(0, 30); // limit to top 30 by liquidity
  } catch (e) {
    console.error('[TrendingBot] Failed to fetch pairs:', e.message);
    return [];
  }
}

async function fetchTokenTxs(tokenAddr) {
  try {
    const from = Math.floor(DateTime.utc().minus({ minutes: Number(POLL_INTERVAL_MINUTES) }).toSeconds());
    const to = Math.floor(DateTime.utc().toSeconds());
    const url = `${HYPERCHARTS_BASE}/token/info/${tokenAddr}`;
    const { data } = await axios.get(url, { timeout: 20000 });

    const txs = data?.data?.transactions || [];
    const recent = txs.filter(t => t.time >= from && t.time <= to);
    const volume = recent.reduce((sum, t) => sum + Number(t.amountIn || 0), 0);
    return { txs: recent.length, volume };
  } catch (e) {
    console.warn(`[TrendingBot] Failed to fetch token info for ${tokenAddr}:`, e.message);
    return { txs: 0, volume: 0 };
  }
}

async function computeTrending() {
  const pairs = await fetchPairs();
  const scored = [];

  for (const p of pairs) {
    // Decide which token to scan: pick token0 unless it's WBESC/BUSDC then scan token1
    const scanToken = p.token0?.contract?.toLowerCase().includes('33e22f') ||
                      p.token0?.symbol === 'WBESC'
      ? p.token1.contract
      : p.token0.contract;

    const { txs, volume } = await fetchTokenTxs(scanToken);

    if (txs === 0) continue; // skip dead pairs

    const score = (volume * 0.5) + (txs * 20) + ((p.liquidityUsd || 0) * 0.0001);
    scored.push({ ...p, txs, volume, score });
  }

  scored.sort((a, b) => b.score - a.score);

  // fallback: if none have txs, just return top liquidity pairs
  if (!scored.length) {
    const fallback = pairs.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
      .slice(0, Number(TRENDING_SIZE))
      .map(p => ({ ...p, txs: p.transactions24h ?? 0, volume: 0, score: 0 }));
    return { trending: fallback, isFallback: true };
  }

  return { trending: scored.slice(0, Number(TRENDING_SIZE)), isFallback: false };
}

function formatTrending({ trending, isFallback }) {
  if (!trending.length) {
    return '😴 <b>No trending pairs right now</b>\n🕒 Check back later!';
  }

  const header = isFallback
    ? `💤 <b>BESC HyperChain — Quiet Market</b>\n📊 Showing top pairs by liquidity:`
    : `🔥 <b>BESC HyperChain — Top ${trending.length} Trending</b>\n🕒 Last ${POLL_INTERVAL_MINUTES} min snapshot`;

  const lines = [header, ''];

  trending.forEach((p, i) => {
    const t0 = p.token0.symbol || '?';
    const t1 = p.token1.symbol || '?';
    lines.push(
      `${i + 1}️⃣ <b>${t0}/${t1}</b>\n` +
      `💵 Vol: ${fmtUsd(p.volume)} | 🧮 Tx: ${p.txs}\n` +
      `💧 LQ: ${fmtUsd(p.liquidityUsd)}\n` +
      `<a href="https://beschyperchain.com/pair/${p.pair}">View Pair</a>\n`
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
    const msg = await bot.sendMessage(TELEGRAM_CHAT_ID, formatTrending(result), {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
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
