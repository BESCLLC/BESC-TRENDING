import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { DateTime } from 'luxon';

const {
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  POLL_INTERVAL_MINUTES = '5',
  TRENDING_SIZE = '5'
} = process.env;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) throw new Error('Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID');

const bot = new TelegramBot(TELEGRAM_TOKEN);
const HC_BASE = 'https://api.beschypercharts.com/token/pairs/all';

let lastPinnedId = null;

async function fetchPairs() {
  try {
    const { data } = await axios.get(HC_BASE, { timeout: 15000 });
    if (!data?.success?.data) {
      console.warn('[TrendingBot] Unexpected response from HyperCharts:', data);
      return [];
    }
    return data.success.data;
  } catch (e) {
    console.error('[TrendingBot] Failed to fetch pairs:', e.message);
    return [];
  }
}

function safeFloat(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function fmtUsd(n) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function computeTrending(pairs) {
  const cutoff = DateTime.utc().minus({ minutes: 10 });
  const active = pairs.filter(p => {
    // Parse createdAt or fallback to now
    const lastActivity = DateTime.fromISO(p.updatedAt || p.createdAt || DateTime.utc().toISO());
    return lastActivity >= cutoff || (p.transactions24h && p.transactions24h > 0);
  });

  // Score based on recent txs + liquidity
  return active
    .map(p => ({
      ...p,
      score: (p.transactions24h || 0) * 10 + safeFloat(p.liquidityUsd) * 0.0001
    }))
    .sort((a, b) => b.score - a.score);
}

function formatTrending(trending, fallbackPairs) {
  if (!trending.length) {
    if (fallbackPairs.length) {
      return (
        `😴 <b>No trades in last 10 min</b>\n` +
        `📊 Showing top pairs by liquidity instead:\n\n` +
        fallbackPairs
          .slice(0, Number(TRENDING_SIZE))
          .map((p, i) => {
            const name = `${p.token0.symbol}/${p.token1.symbol}`;
            return `${i + 1}️⃣ <b>${name}</b> — 💧 ${fmtUsd(safeFloat(p.liquidityUsd))}`;
          })
          .join('\n')
      );
    }
    return `😴 <b>No trending pairs right now</b>\n🕒 Chain is completely quiet — check back later!`;
  }

  const lines = [
    `🔥 <b>BESC HyperChain — Top ${TRENDING_SIZE} Trending</b>`,
    `🕒 Last 10 min activity snapshot\n`
  ];

  trending.slice(0, Number(TRENDING_SIZE)).forEach((p, i) => {
    const name = `${p.token0.symbol}/${p.token1.symbol}`;
    const vol = fmtUsd(safeFloat(p.volume24h));
    const txs = p.transactions24h || 0;
    const liq = fmtUsd(safeFloat(p.liquidityUsd));
    const link = `https://beschypercharts.com/pair/${p.pair}`;
    lines.push(
      `${i + 1}️⃣ <b>${name}</b>\n` +
      `💵 Vol: ${vol} | 🧮 Tx: ${txs}\n` +
      `💧 LQ: ${liq}\n` +
      `<a href="${link}">View Pair</a>\n`
    );
  });

  return lines.join('\n');
}

async function postTrending() {
  try {
    const pairs = await fetchPairs();
    console.log(`[TrendingBot] Got ${pairs.length} pairs from HyperCharts`);

    const trending = computeTrending(pairs);

    if (lastPinnedId) {
      await bot.unpinAllChatMessages(TELEGRAM_CHAT_ID).catch(() => {});
      await bot.deleteMessage(TELEGRAM_CHAT_ID, lastPinnedId).catch(() => {});
    }

    const msg = await bot.sendMessage(
      TELEGRAM_CHAT_ID,
      formatTrending(trending, pairs),
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );

    await bot.pinChatMessage(TELEGRAM_CHAT_ID, msg.message_id, { disable_notification: true });
    lastPinnedId = msg.message_id;
    console.log(`[TrendingBot] ✅ Posted trending update (${trending.length} pairs in 10 min window)`);
  } catch (e) {
    console.error('[TrendingBot] Failed to post trending:', e.message);
  }
}

console.log('✅ BESC Trending Bot starting up...');
setInterval(postTrending, Number(POLL_INTERVAL_MINUTES) * 60 * 1000);
postTrending();
