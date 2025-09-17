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
let lastPinnedId = null;

function fmtUsd(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '$0.00';
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(2)}K`;
  return `$${num.toFixed(2)}`;
}

// Quality filter: ensures we only show "good" pools
function isGoodPool(p) {
  const a = p.attributes;
  const liq = Number(a.reserve_in_usd || 0);
  const vol = Number(a.volume_usd.h24 || 0);
  const txs = a.transactions?.h24 || { buys: 0, sells: 0 };

  // 1. Liquidity ≥ $5k
  if (liq < 5000) return false;

  // 2. Volume ≥ $1k
  if (vol < 1000) return false;

  // 3. At least 3 buys in 24h
  if (txs.buys < 3) return false;

  // 4. Avoid pools with 3x more sells than buys (likely dumping)
  if (txs.sells > txs.buys * 3) return false;

  // 5. Avoid brand-new pools <15 minutes old (anti-honeypot)
  const created = new Date(a.pool_created_at);
  const minutesOld = (Date.now() - created.getTime()) / 60000;
  if (minutesOld < 15) return false;

  return true;
}

async function fetchPools() {
  try {
    const { data } = await axios.get(
      'https://api.geckoterminal.com/api/v2/networks/besc-hyperchain/pools',
      {
        params: { sort: 'h24_volume_usd_desc', page: 1 },
        timeout: 15000,
      }
    );
    return (data.data || []).filter(isGoodPool);
  } catch (e) {
    console.error('[TrendingBot] Failed to fetch pools:', e.message);
    return [];
  }
}

function formatTrending(pools) {
  if (!pools.length) {
    return `😴 <b>No trending pairs right now</b>\n🕒 Chain is quiet — check back later!`;
  }

  const lines = [
    `🔥 <b>BESC HyperChain — Top ${pools.length} Trending Pools</b>`,
    `🕒 Snapshot: Last ${POLL_INTERVAL_MINUTES} min\n`
  ];

  pools.forEach((p, i) => {
    const a = p.attributes;
    const txs = a.transactions?.h24 || { buys: 0, sells: 0 };
    const change = Number(a.price_change_percentage?.h24 || 0).toFixed(2);
    const link = `https://www.geckoterminal.com/besc-hyperchain/pools/${a.address}`;

    lines.push(
      `${i + 1}️⃣ <b>${a.name}</b>\n` +
      `💵 <b>Vol:</b> ${fmtUsd(a.volume_usd.h24)} | 💧 <b>LQ:</b> ${fmtUsd(a.reserve_in_usd)}\n` +
      `📈 <b>24h:</b> ${change}% | 🛒 <b>Buys:</b> ${txs.buys} | 🔻 <b>Sells:</b> ${txs.sells}\n` +
      `<a href="${link}">📊 View on GeckoTerminal</a>\n`
    );
  });

  return lines.join('\n');
}

async function postTrending() {
  try {
    const pools = await fetchPools();
    const trending = pools
      .sort((a, b) => Number(b.attributes.volume_usd.h24) - Number(a.attributes.volume_usd.h24))
      .slice(0, Number(TRENDING_SIZE));

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

    console.log(`[TrendingBot] ✅ Posted trending (${trending.length} pools)`);
  } catch (e) {
    console.error('[TrendingBot] Failed to post trending:', e.message);
  }
}

console.log('✅ BESC Trending Bot started.');
setInterval(postTrending, Number(POLL_INTERVAL_MINUTES) * 60 * 1000);
postTrending();
