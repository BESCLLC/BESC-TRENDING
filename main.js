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
    const { data } = await axios.get(`${HYPERCHARTS_BASE}/token/pairs/all`, { timeout: 15000 });
    const pairs = data?.data || data?.success?.data || [];
    return pairs.filter(p => (p.liquidityUsd ?? 0) > 0)
      .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
      .slice(0, 30);
  } catch (e) {
    console.error('[TrendingBot] Failed to fetch pairs:', e.message);
    return [];
  }
}

async function fetchTxsForToken(tokenAddr) {
  try {
    const from = Math.floor(DateTime.utc().minus({ minutes: Number(POLL_INTERVAL_MINUTES) }).toSeconds());
    const to = Math.floor(DateTime.utc().toSeconds());
    const url = `${HYPERCHARTS_BASE}/transactions/${tokenAddr}?from=${from}&to=${to}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return data?.data || [];
  } catch {
    return [];
  }
}

async function computeTrending() {
  const pairs = await fetchPairs();
  const scored = [];

  for (const p of pairs) {
    const token = p.token0?.contract;
    if (!token) continue;

    const txs = await fetchTxsForToken(token);
    if (!txs.length) continue;

    const volume = txs.reduce((sum, t) => {
      const vIn = Number(t.amountIn || 0);
      const vOut = Number(t.amountOut || 0);
      return sum + vIn + vOut;
    }, 0);

    if (volume <= 0) continue; // skip useless pairs

    const score = (volume * 0.5) + (txs.length * 20) + ((p.liquidityUsd || 0) * 0.0001);
    scored.push({ ...p, txs: txs.length, volume, score });
  }

  scored.sort((a, b) => b.score - a.score);

  if (!scored.length) {
    const fallback = pairs.slice(0, Number(TRENDING_SIZE))
      .map(p => ({ ...p, txs: p.transactions24h ?? 0, volume: 0, score: 0 }));
    return { trending: fallback, isFallback: true };
  }

  return { trending: scored.slice(0, Number(TRENDING_SIZE)), isFallback: false };
}

function formatTrending({ trending, isFallback }) {
  if (!trending.length) {
    return '😴 <b>No trending pairs right now</b>\n🕒 Check back later!';
  }

  const title = isFallback
    ? `💤 <b>BESC HyperChain — Quiet Market</b>\n📊 Showing top pairs by liquidity:`
    : `🔥 <b>BESC HyperChain — Top ${trending.length} Trending</b>\n🕒 Last ${POLL_INTERVAL_MINUTES} min snapshot`;

  const lines = [title, ''];

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
