import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { DateTime } from 'luxon';

const {
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  GECKO_NETWORK = 'besc-hyperchain',
  POLL_INTERVAL_MINUTES = '5',
  TRENDING_SIZE = '5'
} = process.env;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) throw new Error('Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID');

const bot = new TelegramBot(TELEGRAM_TOKEN);
const GT_BASE = 'https://api.geckoterminal.com/api/v2';
const HEADERS = { 'Accept': 'application/json;version=20230302' };

let lastPinnedId = null;

async function fetchPools() {
  try {
    // primary: trending pools
    const url = `${GT_BASE}/networks/${GECKO_NETWORK}/trending_pools?duration=24h&page[size]=50&include=base_token,quote_token`;
    const { data } = await axios.get(url, { headers: HEADERS });
    if (data?.data?.length) return data.data;

    console.warn('[TrendingBot] No trending pools returned, falling back to /pools');
    const fallbackUrl = `${GT_BASE}/networks/${GECKO_NETWORK}/pools?sort=-reserve_usd&page[size]=50&include=base_token,quote_token`;
    const { data: fb } = await axios.get(fallbackUrl, { headers: HEADERS });
    return fb?.data || [];
  } catch (e) {
    console.error('[TrendingBot] Failed to fetch pools:', e.message);
    return [];
  }
}

async function fetchTrades(poolId) {
  try {
    const url = `${GT_BASE}/networks/${GECKO_NETWORK}/pools/${poolId}/trades?page[size]=50`;
    const { data } = await axios.get(url, { headers: HEADERS });
    return data?.data || [];
  } catch (e) {
    console.warn(`[TrendingBot] Failed to fetch trades for ${poolId}:`, e.message);
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

async function computeTrending() {
  const pools = await fetchPools();
  const cutoff = DateTime.utc().minus({ minutes: Number(POLL_INTERVAL_MINUTES) });

  const scored = [];
  for (const p of pools) {
    const attrs = p.attributes || {};
    const trades = await fetchTrades(p.id);
    const recent = trades.filter(t => DateTime.fromISO(t.attributes.block_timestamp) >= cutoff);
    if (!recent.length) continue;

    const vol = recent.reduce((sum, t) => sum + safeFloat(t.attributes.volume_in_usd), 0);
    const firstPrice = safeFloat(recent[0].attributes.price_to_in_usd);
    const lastPrice = safeFloat(recent[recent.length - 1].attributes.price_to_in_usd);
    const priceChange = firstPrice > 0 ? ((lastPrice / firstPrice) - 1) * 100 : 0;
    const spike = attrs.volume_usd?.h24 ? vol / safeFloat(attrs.volume_usd.h24) : 1;

    const score = vol * 0.5 + Math.abs(priceChange) * 50 + recent.length * 10 + spike * 100;
    scored.push({ score, pool: p, vol, priceChange, trades: recent.length, spike });
  }

  return scored.sort((a, b) => b.score - a.score);
}

function formatTrending(slug, trending) {
  if (!trending.length) {
    return '😴 <b>No trending pools right now</b>\n🕒 Check back in a few minutes!';
  }
  const lines = [
    `🔥 <b>${slug.toUpperCase()} — Top ${TRENDING_SIZE} Trending</b>`,
    `🕒 Last ${POLL_INTERVAL_MINUTES} min snapshot\n`
  ];

  trending.slice(0, Number(TRENDING_SIZE)).forEach((x, i) => {
    const name = x.pool.attributes.name || 'Unknown';
    const link = `https://www.geckoterminal.com/${slug}/pools/${x.pool.id}`;
    const pcEmoji = x.priceChange >= 0 ? '📈' : '📉';
    lines.push(
      `${i + 1}️⃣ <b>${name}</b>\n` +
      `💵 Vol: ${fmtUsd(x.vol)} | ${pcEmoji} ${x.priceChange.toFixed(2)}%\n` +
      `🧮 Trades: ${x.trades} | 🚀 Spike: ${(x.spike * 100).toFixed(1)}%\n` +
      `<a href="${link}">View Pool</a>\n`
    );
  });

  return lines.join('\n');
}

async function postTrending() {
  try {
    const trending = await computeTrending();

    // auto delete + unpin old
    if (lastPinnedId) {
      await bot.unpinAllChatMessages(TELEGRAM_CHAT_ID).catch(() => {});
      await bot.deleteMessage(TELEGRAM_CHAT_ID, lastPinnedId).catch(() => {});
    }

    const msg = await bot.sendMessage(TELEGRAM_CHAT_ID, formatTrending(GECKO_NETWORK, trending), {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    await bot.pinChatMessage(TELEGRAM_CHAT_ID, msg.message_id, { disable_notification: true });
    lastPinnedId = msg.message_id;
  } catch (e) {
    console.error('[TrendingBot] Failed to post trending:', e.message);
  }
}

console.log('✅ BESC Trending Bot starting up...');
setInterval(postTrending, Number(POLL_INTERVAL_MINUTES) * 60 * 1000);
postTrending();
