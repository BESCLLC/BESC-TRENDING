import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { DateTime } from 'luxon';

const {
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  POLL_INTERVAL_MINUTES = '60',
  TRENDING_SIZE = '5',
  HYPERCHARTS_BASE = 'https://api.beschypercharts.com',
  GECKO_NETWORK_SLUG = 'besc-hyperchain'
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
    return (data?.success?.data || []).filter(p => (p.liquidityUsd ?? 0) > 100);
  } catch (e) {
    console.error('[TrendingBot] Failed to fetch pairs:', e.message);
    return [];
  }
}

async function fetchTokenInfo(address) {
  try {
    const { data } = await axios.get(`${HYPERCHARTS_BASE}/token/info/${address}`, { timeout: 15000 });
    return data?.success?.data || null;
  } catch {
    return null;
  }
}

async function computeTrending() {
  const pairs = await fetchPairs();
  const cutoff = DateTime.utc().minus({ minutes: Number(POLL_INTERVAL_MINUTES) });

  // Fetch token info for all pairs in parallel
  const tokenInfos = await Promise.all(
    pairs.map(p => fetchTokenInfo(p.token0.contract))
  );

  const scored = [];
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const tokenInfo = tokenInfos[i];
    if (!tokenInfo?.transactions?.length) continue;

    const recentTx = tokenInfo.transactions.filter(tx =>
      DateTime.fromSeconds(Math.floor(tx.time)) >= cutoff
    );
    if (!recentTx.length) continue;

    const vol = recentTx.reduce((sum, tx) => sum + Number(tx.amountIn || 0), 0);
    const score = vol * 0.5 + recentTx.length * 10 + (p.liquidityUsd ?? 0) * 0.0001;

    scored.push({ pair: p, vol, txCount: recentTx.length, score });
  }

  scored.sort((a, b) => b.score - a.score);

  if (!scored.length) {
    const fallback = pairs
      .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
      .slice(0, Number(TRENDING_SIZE))
      .map(p => ({ pair: p, vol: 0, txCount: p.transactions24h ?? 0, score: 0 }));
    return { trending: fallback, isFallback: true };
  }

  return { trending: scored.slice(0, Number(TRENDING_SIZE)), isFallback: false };
}

function formatTrending({ trending, isFallback }) {
  if (!trending.length) {
    return '😴 <b>No trending pairs right now</b>\n🕒 Chain is completely quiet — check back later!';
  }

  const title = isFallback
    ? `💤 <b>BESC HyperChain — Quiet Market</b>\n📊 Showing top pairs by liquidity:\n`
    : `🔥 <b>BESC HyperChain — Top ${trending.length} Trending</b>\n🕒 Last ${POLL_INTERVAL_MINUTES} min snapshot\n`;

  const lines = [title];
  trending.forEach((x, i) => {
    const t0 = x.pair.token0.symbol || '?';
    const t1 = x.pair.token1.symbol || '?';
    const link = `https://www.geckoterminal.com/${GECKO_NETWORK_SLUG}/pools/${x.pair.pair}`;

    lines.push(
      `${i + 1}️⃣ <b>${t0}/${t1}</b>\n` +
      `💵 Vol: ${fmtUsd(x.vol)} | 🧮 Tx: ${x.txCount}\n` +
      `💧 LQ: ${fmtUsd(x.pair.liquidityUsd)}\n` +
      `<a href="${link}">View Pair</a>\n`
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
    console.log(`[TrendingBot] ✅ Posted trending update (${result.trending.length} pairs)${result.isFallback ? ' [Fallback]' : ''}`);
  } catch (e) {
    console.error('[TrendingBot] Failed to post trending:', e.message);
  }
}

console.log('✅ BESC Trending Bot starting up...');
setInterval(postTrending, Number(POLL_INTERVAL_MINUTES) * 60 * 1000);
postTrending();
