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
  try {
    const url = `${BASE}/token/pairs/all`;
    const { data } = await axios.get(url);
    const pairs = Array.isArray(data?.data) ? data.data : [];
    console.log(`[TrendingBot] Got ${pairs.length} pairs from HyperCharts`);
    return pairs;
  } catch (e) {
    console.error('[TrendingBot] Pair fetch failed:', e.message);
    return [];
  }
}

function computeTrending(pairs) {
  const now = Date.now();
  return pairs
    .map(p => {
      const txScore = safeFloat(p.transactions24h) * 2;
      const volScore = safeFloat(p.volume24h);
      const recencyBoost = now - Date.parse(p.createdAt) < 86400000 ? 1.25 : 1; // 25% boost if <24h old
      const score = (txScore + volScore) * recencyBoost;
      return { score, pair: p };
    })
    .sort((a, b) => b.score - a.score);
}

function formatTrending(trending) {
  if (!trending.length) {
    return `😴 <b>No trending pairs right now</b>\n🕒 Check back later!`;
  }

  const lines = [
    `🔥 <b>BESC HyperChain — Top ${TRENDING_SIZE} Trending</b>`,
    `📊 Based on 24h trades + volume\n`
  ];

  trending.slice(0, Number(TRENDING_SIZE)).forEach((x, i) => {
    const p = x.pair;
    const name = `${p.token0.symbol}/${p.token1.symbol}`;
    const vol = fmtUsd(safeFloat(p.volume24h));
    const txs = p.transactions24h || 0;
    const link = `https://beschypercharts.com/pair/${p.pair}`;
    lines.push(
      `${i + 1}️⃣ <b>${name}</b>\n` +
      `💵 Vol: ${vol} | 🧮 Tx: ${txs}\n` +
      `<a href="${link}">View Pair</a>\n`
    );
  });

  return lines.join('\n');
}

async function postTrending() {
  try {
    const pairs = await fetchAllPairs();
    const trending = computeTrending(pairs);
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
    console.log(`✅ Posted trending update (${trending.length} pairs)`);
  } catch (e) {
    console.error('[TrendingBot] Failed to post trending:', e.message);
  }
}

// ---------- START LOOP ----------
console.log('✅ BESC Trending Bot starting up...');
setInterval(postTrending, Number(POLL_INTERVAL_MINUTES) * 60 * 1000);
postTrending();
