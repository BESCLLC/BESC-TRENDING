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

function safeFloat(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function fmtUsd(n) {
  if (!n || n <= 0) return '$0.00';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

async function fetchPairs() {
  try {
    const { data } = await axios.get(`${HYPERCHARTS_BASE}/token/pairs/all`, { timeout: 15000 });
    const pairs = data?.success?.data || [];
    // Filter out zero-liquidity pairs
    return pairs.filter(p => safeFloat(p.liquidityUsd) > 0);
  } catch (e) {
    console.error('[TrendingBot] Failed to fetch pairs:', e.message);
    return [];
  }
}

async function fetchPairVolumeAndTxs(pair) {
  try {
    const cutoff = DateTime.utc().minus({ minutes: Number(POLL_INTERVAL_MINUTES) }).toSeconds();
    const token0Info = await axios.get(`${HYPERCHARTS_BASE}/token/info/${pair.token0.contract}`, { timeout: 15000 });
    const txs = token0Info?.data?.success?.data?.pair?.transactions || [];
    const recent = txs.filter(t => t.time >= cutoff);
    const volume = recent.reduce((sum, t) => sum + safeFloat(t.amountIn) + safeFloat(t.amountOut), 0);
    return { volume, txCount: recent.length };
  } catch (e) {
    return { volume: 0, txCount: 0 };
  }
}

async function computeTrending() {
  const pairs = await fetchPairs();
  const scored = [];

  for (const p of pairs) {
    const { volume, txCount } = await fetchPairVolumeAndTxs(p);
    if (volume <= 0 && txCount === 0) continue; // Skip dead pairs

    const score = (volume * 0.5) + (txCount * 15);
    scored.push({ ...p, volume, txCount, score });
  }

  scored.sort((a, b) => b.score - a.score);

  if (!scored.length) {
    const fallback = pairs
      .sort((a, b) => safeFloat(b.liquidityUsd) - safeFloat(a.liquidityUsd))
      .slice(0, Number(TRENDING_SIZE))
      .map(p => ({ ...p, volume: 0, txCount: p.transactions24h ?? 0, score: 0 }));
    return { trending: fallback, isFallback: true };
  }

  return { trending: scored.slice(0, Number(TRENDING_SIZE)), isFallback: false };
}

function formatTrending({ trending, isFallback }) {
  if (!trending.length) {
    return '😴 <b>No trending pairs right now</b>\n🕒 Chain is completely quiet — check back later!';
  }

  const title = isFallback
    ? `💤 <b>BESC HyperChain — Quiet Market</b>\nShowing top pairs by liquidity:`
    : `🔥 <b>BESC HyperChain — Top ${trending.length} Trending</b>\n🕒 Last ${POLL_INTERVAL_MINUTES} min snapshot`;

  const lines = [title, ''];

  trending.forEach((p, i) => {
    const t0 = p.token0.symbol || '?';
    const t1 = p.token1.symbol || '?';
    lines.push(
      `${i + 1}️⃣ <b>${t0}/${t1}</b>\n` +
      `💵 Vol: ${fmtUsd(p.volume)} | 🧮 Tx: ${p.txCount}\n` +
      `💧 LQ: ${fmtUsd(p.liquidityUsd)}\n` +
      `<a href="https://beschypercharts.com/pair/${p.pair}">View Pair</a>\n`
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
