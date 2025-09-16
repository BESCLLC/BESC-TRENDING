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
    return (data?.data || []).filter(p => (p.liquidityUsd ?? 0) >= 100);
  } catch (e) {
    console.error('[TrendingBot] Failed to fetch pairs:', e.message);
    return [];
  }
}

async function fetchRecentTransactions(pair) {
  try {
    const from = Math.floor(DateTime.utc().minus({ minutes: Number(POLL_INTERVAL_MINUTES) }).toSeconds());
    const to = Math.floor(DateTime.utc().toSeconds());
    const url = `${HYPERCHARTS_BASE}/transactions/${pair.pair}?from=${from}&to=${to}`;
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
    if ((p.liquidityUsd ?? 0) < 100) continue; // double-check LP
    const txs = await fetchRecentTransactions(p);
    const shortVol = txs.reduce((sum, t) => sum + Number(t.amountUsd || 0), 0);
    const vol24h = Number(p.volume24h || 0);
    const finalVol = shortVol > 0 ? shortVol : vol24h;

    if (finalVol <= 0 && txs.length === 0) continue; // no activity at all

    const firstPrice = Number(txs[0]?.priceUsd || 0);
    const lastPrice = Number(txs[txs.length - 1]?.priceUsd || 0);
    const priceChange = firstPrice > 0 ? ((lastPrice / firstPrice) - 1) * 100 : 0;

    const score = (finalVol * 0.5) + (txs.length * 15) + (Math.abs(priceChange) * 40);
    scored.push({
      score,
      pair: p,
      vol: finalVol,
      txs: txs.length || (p.transactions24h ?? 0),
      priceChange
    });
  }

  scored.sort((a, b) => b.score - a.score);

  if (!scored.length) {
    const fallback = pairs
      .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
      .slice(0, Number(TRENDING_SIZE))
      .map(p => ({
        score: 0,
        pair: p,
        vol: Number(p.volume24h || 0),
        txs: p.transactions24h ?? 0,
        priceChange: 0
      }));
    return { trending: fallback, isFallback: true };
  }

  return { trending: scored.slice(0, Number(TRENDING_SIZE)), isFallback: false };
}

function formatTrending({ trending, isFallback }) {
  if (!trending.length) {
    return '😴 <b>No trending pairs right now</b>\n🕒 Check back in a few minutes!';
  }

  const title = isFallback
    ? `💤 <b>BESC HyperChain — Quiet Market</b>\nShowing top pairs by liquidity:`
    : `🔥 <b>BESC HyperChain — Top ${trending.length} Trending</b>\n🕒 Last ${POLL_INTERVAL_MINUTES} min snapshot`;

  const lines = [title, ''];

  trending.forEach((x, i) => {
    const t0 = x.pair.token0.symbol || '?';
    const t1 = x.pair.token1.symbol || '?';
    const pcEmoji = x.priceChange >= 0 ? '📈' : '📉';
    lines.push(
      `${i + 1}️⃣ <b>${t0}/${t1}</b>\n` +
      `💵 Vol: ${fmtUsd(x.vol)} | ${pcEmoji} ${x.priceChange.toFixed(2)}%\n` +
      `🧮 Tx: ${x.txs} | 💧 LQ: ${fmtUsd(x.pair.liquidityUsd)}\n` +
      `<a href="https://beschyperchain.com/pair/${x.pair.pair}">View Pair</a>\n`
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
