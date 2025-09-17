import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';

const {
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  POLL_INTERVAL_MINUTES = '5', // shorter interval = more real-time
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

// Quality filter to only show healthy pools
function isGoodPool(p) {
  const a = p.attributes;
  const liq = Number(a.reserve_in_usd || 0);
  const vol = Number(a.volume_usd.h24 || 0);
  const txs = a.transactions?.h24 || { buys: 0, sells: 0 };

  if (liq < 5000) return false;
  if (vol < 1000) return false;
  if (txs.buys < 3) return false;
  if (txs.sells > txs.buys * 3) return false;

  const created = new Date(a.pool_created_at);
  const minutesOld = (Date.now() - created.getTime()) / 60000;
  if (minutesOld < 10) return false;

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
    return `😴 <b>No trending pools right now</b>\n🕒 Chain is quiet — check back soon!`;
  }

  const lines = [
    `🔥 <b>BESC HyperChain — Top ${pools.length} Trending Pools</b>`,
    `🕒 Snapshot: Last ${POLL_INTERVAL_MINUTES} min\n`
  ];

  pools.forEach((p, i) => {
    const a = p.attributes;
    const txs = a.transactions?.h24 || { buys: 0, sells: 0 };
    const change = Number(a.price_change_percentage?.h24 || 0).toFixed(2);
    const fdv = a.market_cap_usd || a.fdv_usd || 0;
    const fdvLabel = fdv ? `🏦 <b>FDV:</b> ${fmtUsd(fdv)} | ` : '';
    const link = `https://www.geckoterminal.com/besc-hyperchain/pools/${a.address}`;

    lines.push(
      `${i + 1}️⃣ <b>${a.name}</b>\n` +
      `💵 <b>Vol:</b> ${fmtUsd(a.volume_usd.h24)} | 💧 <b>LQ:</b> ${fmtUsd(a.reserve_in_usd)}\n` +
      `${fdvLabel}📈 <b>24h:</b> ${change}% | 🛒 <b>Buys:</b> ${txs.buys} | 🔻 <b>Sells:</b> ${txs.sells}\n` +
      `<a href="${link}">📊 View on GeckoTerminal</a>\n`
    );
  });

  return lines.join('\n');
}

async function postTrending() {
  try {
    let pools = await fetchPools();

    // Sort "hotness" = volume * log(1+priceChangeAbs)
    pools.sort((a, b) => {
      const va = Number(a.attributes.volume_usd.h24);
      const vb = Number(b.attributes.volume_usd.h24);
      const ca = Math.abs(Number(a.attributes.price_change_percentage?.h24 || 0));
      const cb = Math.abs(Number(b.attributes.price_change_percentage?.h24 || 0));
      return (vb * Math.log1p(cb)) - (va * Math.log1p(ca));
    });

    const trending = pools.slice(0, Number(TRENDING_SIZE));

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
