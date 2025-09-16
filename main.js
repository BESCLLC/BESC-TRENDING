import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';

const {
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  POLL_INTERVAL_MINUTES = '5',
  TRENDING_SIZE = '5'
} = process.env;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID)
  throw new Error('Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID');

const bot = new TelegramBot(TELEGRAM_TOKEN);
const HC_BASE = 'https://api.beschypercharts.com/token/pairs/all';
const INFO_BASE = 'https://api.beschypercharts.com/token/info';

let lastPinnedId = null;

function fmtUsd(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
}

async function fetchPairs() {
  try {
    const { data } = await axios.get(HC_BASE, { timeout: 20000 });
    return (data?.success?.data || []).filter(p => (p.liquidityUsd ?? 0) > 50);
  } catch (e) {
    console.error('[TrendingBot] Failed to fetch pairs:', e.message);
    return [];
  }
}

async function fetchTokenInfo(contract) {
  try {
    const { data } = await axios.get(`${INFO_BASE}/${contract}`, { timeout: 20000 });
    return data?.success?.data || null;
  } catch {
    return null;
  }
}

async function computeTrending() {
  const pairs = await fetchPairs();
  const cutoff = Math.floor(Date.now() / 1000) - (Number(POLL_INTERVAL_MINUTES) * 60);

  const scored = [];
  for (const p of pairs) {
    // Use token0 as main token to fetch transactions
    const info = await fetchTokenInfo(p.token0.contract);
    if (!info?.transactions) continue;

    const recentTx = info.transactions.filter(tx => tx.time >= cutoff);
    if (!recentTx.length) continue;

    const txCount = recentTx.length;
    const vol = recentTx.reduce((sum, tx) => sum + (Number(tx.amountIn) || 0), 0);

    const score = txCount * 10 + vol * 0.1; // prioritize activity
    scored.push({ ...p, score, txCount, vol });
  }

  scored.sort((a, b) => b.score - a.score);

  if (!scored.length) {
    const fallback = pairs
      .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
      .slice(0, Number(TRENDING_SIZE))
      .map(p => ({ ...p, txCount: p.transactions24h || 0, vol: 0 }));
    return { trending: fallback, isFallback: true };
  }

  return { trending: scored.slice(0, Number(TRENDING_SIZE)), isFallback: false };
}

function formatTrending({ trending, isFallback }) {
  if (!trending.length) {
    return '😴 <b>No trending pairs right now</b>\n🕒 Chain is completely quiet — check back later!';
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
      `💵 Vol: ${fmtUsd(p.vol)} | 🧮 Tx: ${p.txCount}\n` +
      `💧 LQ: ${fmtUsd(p.liquidityUsd)}\n` +
      `<a href="https://www.geckoterminal.com/besc-hyperchain/pools/${p.pair}">View Pair</a>\n`
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
