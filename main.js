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

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID)
  throw new Error('Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID');

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const BASE = 'https://api.beschypercharts.com';
let lastPinnedId = null;

// ---------- HELPERS ----------
function safeFloat(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function fmtUsd(n) {
  if (!Number.isFinite(n)) return '$0.00';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

async function fetchAllPairs() {
  const url = `${BASE}/token/pairs/all`;
  const { data } = await axios.get(url);
  return data || [];
}

async function fetchPairHistory(pairAddr, minutes) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - minutes * 60;
  const url = `${BASE}/pair/history/${pairAddr}?from=${from}&to=${to}`;
  const { data } = await axios.get(url);
  return data || [];
}

async function computeTrending() {
  const pairs = await fetchAllPairs();
  const cutoffMinutes = Number(POLL_INTERVAL_MINUTES) * 2;

  const results = [];
  for (const pair of pairs) {
    const history = await fetchPairHistory(pair.address, cutoffMinutes);
    if (!Array.isArray(history) || history.length < 2) continue;

    const volumes = history.map(h => safeFloat(h.volumeUsd || 0));
    const prices = history.map(h => safeFloat(h.priceUsd || 0));
    const vol = volumes.reduce((a, b) => a + b, 0);

    const firstPrice = prices[0];
    const lastPrice = prices[prices.length - 1];
    const priceChange = firstPrice > 0 ? ((lastPrice / firstPrice) - 1) * 100 : 0;
    const tradeCount = history.length;
    const spikeRatio = pair.volume24h > 0 ? vol / pair.volume24h : 1;

    // Weighted score so small but active tokens still rank
    const score = vol * 0.5 + Math.abs(priceChange) * 50 + tradeCount * 10 + spikeRatio * 100;

    results.push({
      score,
      pair,
      vol,
      priceChange,
      trades: tradeCount,
      spike: spikeRatio
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

function formatTrending(trending) {
  if (!trending.length) {
    return `😴 <b>No trending pools right now</b>\n🕒 Check back in a few minutes!`;
  }

  const lines = [
    `🔥 <b>BESC HyperChain — Top ${TRENDING_SIZE} Trending</b>`,
    `🕒 Last ${POLL_INTERVAL_MINUTES} min snapshot\n`
  ];

  trending.slice(0, Number(TRENDING_SIZE)).forEach((x, i) => {
    const name = x.pair?.name || `${x.pair?.token0?.symbol}/${x.pair?.token1?.symbol}` || 'Unknown';
    const link = `https://beschypercharts.com/pair/${x.pair.address}`;
    const pcEmoji = x.priceChange >= 0 ? '📈' : '📉';
    lines.push(
      `${i + 1}️⃣ <b>${name}</b>\n` +
      `💵 Vol: ${fmtUsd(x.vol)} | ${pcEmoji} ${x.priceChange.toFixed(2)}%\n` +
      `🧮 Trades: ${x.trades} | 🚀 Spike: ${(x.spike * 100).toFixed(1)}%\n` +
      `<a href="${link}">View Chart</a>\n`
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

    const msg = await bot.sendMessage(TELEGRAM_CHAT_ID, formatTrending(trending), {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });

    await bot.pinChatMessage(TELEGRAM_CHAT_ID, msg.message_id, { disable_notification: true });
    lastPinnedId = msg.message_id;
    console.log(`✅ Posted trending update with ${trending.length} pairs`);
  } catch (e) {
    console.error('[TrendingBot] Failed to post trending:', e.message);
  }
}

// ---------- START LOOP ----------
console.log('✅ BESC Trending Bot starting up...');
setInterval(postTrending, Number(POLL_INTERVAL_MINUTES) * 60 * 1000);
postTrending();
