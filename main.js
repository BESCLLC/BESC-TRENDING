import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { DateTime } from 'luxon';

const {
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  POLL_INTERVAL_MINUTES = '60', // 1 hour polling
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
    return (data?.data || data?.success?.data || []).filter(p => (p.liquidityUsd ?? 0) > 100);
  } catch (e) {
    console.error('[TrendingBot] Failed to fetch pairs:', e.message);
    return [];
  }
}

async function fetchTokenInfo(tokenAddress) {
  try {
    const url = `${HYPERCHARTS_BASE}/token/info/${tokenAddress}`;
    const { data } = await axios.get(url, { timeout: 20000 });
    return data?.data || data?.success?.data || null;
  } catch {
    return null;
  }
}

async function computeTrending() {
  const pairs = await fetchPairs();
  const topPairs = pairs.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)).slice(0, 15);

  const now = Math.floor(DateTime.utc().toSeconds());
  const oneHourAgo = now - 3600;

  const results = await Promise.all(
    topPairs.map(async p => {
      const tokenInfo = await fetchTokenInfo(p.token0.contract);
      const txs = tokenInfo?.transactions || [];
      const recentTxs = txs.filter(t => t.time >= oneHourAgo);

      if (!recentTxs.length) return null;

      const volume = recentTxs.reduce((sum, t) => sum + (Number(t.amountIn) || 0), 0);
      const score = volume * 0.7 + recentTxs.length * 15 + (p.liquidityUsd ?? 0) * 0.00005;

      return {
        pair: p,
        txs: recentTxs.length,
        volume,
        score
      };
    })
  );

  const scored = results.filter(Boolean).sort((a, b) => b.score - a.score);
  return scored.slice(0, Number(TRENDING_SIZE));
}

function formatTrending(trending) {
  if (!trending.length) {
    return `😴 <b>No trending pairs right now</b>\n🕒 No trades in the last 60 minutes.`;
  }

  const lines = [
    `🔥 <b>BESC HyperChain — Top ${trending.length} Trending</b>`,
    `🕒 Last 60 min snapshot\n`
  ];

  trending.forEach((x, i) => {
    const t0 = x.pair.token0.symbol || '?';
    const t1 = x.pair.token1.symbol || '?';
    const liq = fmtUsd(x.pair.liquidityUsd);
    const vol = fmtUsd(x.volume);
    const link = `https://www.geckoterminal.com/besc/pools/${x.pair.pair}`;
    lines.push(
      `${i + 1}️⃣ <b>${t0}/${t1}</b>\n` +
      `💵 Vol: ${vol} | 🧮 Tx: ${x.txs}\n` +
      `💧 LQ: ${liq}\n` +
      `<a href="${link}">View Pair</a>\n`
    );
  });

  return lines.join('\n');
}

async function postTrending() {
  try {
    const trending = await computeTrending();

    if (lastPinnedId) {
      await bot.unpinAllChatMessages(TELEGRAM_CHAT_ID).catch(() => {});
      await bot.deleteMessage(TELEGRAM_CHAT_ID, lastPinnedId).catch(() => {});
    }

    const msg = await bot.sendMessage(
      TELEGRAM_CHAT_ID,
      formatTrending(trending),
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );

    await bot.pinChatMessage(TELEGRAM_CHAT_ID, msg.message_id, { disable_notification: true });
    lastPinnedId = msg.message_id;
    console.log(`[TrendingBot] ✅ Posted trending (${trending.length} pairs)`);
  } catch (e) {
    console.error('[TrendingBot] Failed to post trending:', e.message);
  }
}

console.log('✅ BESC Trending Bot starting up...');
setInterval(postTrending, Number(POLL_INTERVAL_MINUTES) * 60 * 1000);
postTrending();
