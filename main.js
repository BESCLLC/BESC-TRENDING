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
    const { data } = await axios.get(`${HYPERCHARTS_BASE}/token/pairs/all`, {
      timeout: 20000
    });
    const pairs = data?.data || [];
    return pairs.filter(p => (p.liquidityUsd ?? 0) > 1); // Filter out dead LP
  } catch (e) {
    console.error('[TrendingBot] Failed to fetch pairs:', e.message);
    return [];
  }
}

async function fetchRecentVolume(pair) {
  try {
    const from = Math.floor(DateTime.utc().minus({ minutes: Number(POLL_INTERVAL_MINUTES) }).toSeconds());
    const to = Math.floor(DateTime.utc().toSeconds());
    const url = `${HYPERCHARTS_BASE}/transactions/${pair.pair}?from=${from}&to=${to}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    const txs = data?.data || [];
    return txs.reduce((sum, t) => sum + Number(t.amountUsd || 0), 0);
  } catch {
    return pair.volume24h ?? 0;
  }
}

async function computeTrending() {
  const pairs = await fetchPairs();
  const scored = [];

  for (const p of pairs) {
    const vol = await fetchRecentVolume(p);
    const tx = p.transactions24h ?? 0;
    const score = (vol * 0.5) + (tx * 5) + ((p.mcap || 1) > 0 ? 10 : 0);
    scored.push({ score, pair: p, vol, tx });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, Number(TRENDING_SIZE));
}

function formatTrending(trending) {
  if (!trending.length) {
    return '😴 <b>No trending pairs right now</b>\n🕒 Check back in a few minutes!';
  }

  const lines = [
    `🔥 <b>BESC HyperChain — Top ${trending.length} Trending</b>`,
    `🕒 Last ${POLL_INTERVAL_MINUTES} min snapshot\n`
  ];

  trending.forEach((x, i) => {
    const t0 = x.pair.token0.symbol || '?';
    const t1 = x.pair.token1.symbol || '?';
    lines.push(
      `${i + 1}️⃣ <b>${t0}/${t1}</b>\n` +
      `💵 Vol: ${fmtUsd(x.vol)} | 🧮 Tx: ${x.tx}\n` +
      `💧 LQ: ${fmtUsd(x.pair.liquidityUsd)}\n` +
      `<a href="https://beschyperchain.com/pair/${x.pair.pair}">View Pair</a>\n`
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
    console.log(`[TrendingBot] Posted trending (${trending.length} pairs)`);
  } catch (e) {
    console.error('[TrendingBot] Failed to post trending:', e.message);
  }
}

console.log('✅ BESC Trending Bot starting up...');
setInterval(postTrending, Number(POLL_INTERVAL_MINUTES) * 60 * 1000);
postTrending();
