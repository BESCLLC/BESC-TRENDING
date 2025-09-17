import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';

const {
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  POLL_INTERVAL_MINUTES = '15',
  TRENDING_SIZE = '5',
  NEW_POOL_ALERT_LIQ = '5000',  // min liquidity to trigger alert
  NEW_POOL_ALERT_VOL = '1000'   // min volume to trigger alert
} = process.env;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID)
  throw new Error('Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID');

const bot = new TelegramBot(TELEGRAM_TOKEN);
let lastPinnedId = null;
let lastVolumes = {};

function fmtUsd(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '$0.00';
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(2)}K`;
  return `$${num.toFixed(2)}`;
}

function isGoodPool(p) {
  const a = p.attributes;
  const liq = Number(a.reserve_in_usd || 0);
  const vol = Number(a.volume_usd.h24 || 0);
  const txs = a.transactions?.h24 || { buys: 0, sells: 0 };
  if (liq < 2000) return false;
  if (vol < 500) return false;
  if (txs.buys + txs.sells < 3) return false;
  return true;
}

async function fetchPools() {
  try {
    const { data } = await axios.get(
      'https://api.geckoterminal.com/api/v2/networks/besc-hyperchain/pools',
      { params: { sort: 'h24_volume_usd_desc', page: 1 }, timeout: 15000 }
    );
    return (data.data || []).filter(isGoodPool);
  } catch (e) {
    console.error('[TrendingBot] Failed to fetch pools:', e.message);
    return [];
  }
}

async function sendNewPoolAlerts(pools) {
  for (const p of pools) {
    const a = p.attributes;
    const created = new Date(a.pool_created_at);
    const minutesOld = (Date.now() - created.getTime()) / 60000;

    if (minutesOld < 15 &&
        Number(a.reserve_in_usd) >= Number(NEW_POOL_ALERT_LIQ) &&
        Number(a.volume_usd.h24) >= Number(NEW_POOL_ALERT_VOL)) {

      const txs = a.transactions?.h24 || { buys: 0, sells: 0 };

      await bot.sendMessage(
        TELEGRAM_CHAT_ID,
        `🚀 <b>NEW POOL DETECTED!</b>\n` +
        `🎯 <b>${a.name}</b>\n` +
        `⏱ Age: ${minutesOld.toFixed(1)} min | 🛒 Buyers: ${txs.buyers || txs.buys}\n` +
        `💧 LQ: ${fmtUsd(a.reserve_in_usd)} | 💵 Vol: ${fmtUsd(a.volume_usd.h24)}\n` +
        `📈 24h: ${Number(a.price_change_percentage?.h24 || 0).toFixed(2)}%\n` +
        `<a href="https://www.geckoterminal.com/besc-hyperchain/pools/${a.address}">📊 View Pool</a>`,
        { parse_mode: 'HTML', disable_web_page_preview: true }
      );
    }
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
    const change = Number(a.price_change_percentage?.h24 || 0);
    const fdv = a.market_cap_usd || a.fdv_usd || 0;
    const fdvLabel = fdv ? `🏦 <b>FDV:</b> ${fmtUsd(fdv)} | ` : '';

    const prevVol = lastVolumes[a.address] ?? null;
    const currentVol = Number(a.volume_usd.h24 || 0);
    const burst = prevVol !== null ? currentVol - prevVol : 0;
    lastVolumes[a.address] = currentVol;

    const burstPct = prevVol ? (burst / prevVol) * 100 : 0;
    const burstLabel =
      prevVol !== null && burst > 1000 && burstPct > 1
        ? `⚡ <b>Vol Burst:</b> +${fmtUsd(burst)} (${burstPct.toFixed(1)}%)\n`
        : '';

    let sentiment = '';
    if (txs.buys > txs.sells * 2) sentiment = '🟢 <b>Strong Buy Pressure</b>\n';
    else if (txs.sells > txs.buys * 2) sentiment = '🔻 <b>Heavy Sell Pressure</b>\n';

    const link = `https://www.geckoterminal.com/besc-hyperchain/pools/${a.address}`;

    lines.push(
      `${i + 1}️⃣ <b>${a.name}</b>\n` +
      `${burstLabel}${sentiment}` +
      `💵 <b>Vol:</b> ${fmtUsd(currentVol)} | 💧 <b>LQ:</b> ${fmtUsd(a.reserve_in_usd)}\n` +
      `${fdvLabel}📈 <b>24h:</b> ${change.toFixed(2)}% | 🛒 Buys: ${txs.buys} | 🔻 Sells: ${txs.sells}\n` +
      `<a href="${link}">📊 View on GeckoTerminal</a>\n`
    );
  });

  return lines.join('\n');
}

async function postTrending() {
  try {
    let pools = await fetchPools();

    // Weighted hotness: favors volume burst, buyers, and recency
    pools.sort((a, b) => {
      const va = Number(a.attributes.volume_usd.h24);
      const vb = Number(b.attributes.volume_usd.h24);
      const ca = Math.abs(Number(a.attributes.price_change_percentage?.h24 || 0));
      const cb = Math.abs(Number(b.attributes.price_change_percentage?.h24 || 0));

      const burstA = lastVolumes[a.attributes.address]
        ? va - lastVolumes[a.attributes.address] : 0;
      const burstB = lastVolumes[b.attributes.address]
        ? vb - lastVolumes[b.attributes.address] : 0;

      const buyersA = a.attributes.transactions?.h24?.buyers || 0;
      const buyersB = b.attributes.transactions?.h24?.buyers || 0;

      const ageA = (Date.now() - new Date(a.attributes.pool_created_at).getTime()) / 3600000;
      const ageB = (Date.now() - new Date(b.attributes.pool_created_at).getTime()) / 3600000;

      const hotnessA = va + burstA * 2 + buyersA * 50 + (va * Math.log1p(ca / 100)) + (ageA < 6 ? 500 : 0);
      const hotnessB = vb + burstB * 2 + buyersB * 50 + (vb * Math.log1p(cb / 100)) + (ageB < 6 ? 500 : 0);

      return hotnessB - hotnessA;
    });

    await sendNewPoolAlerts(pools); // fires launch alerts first

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

console.log('✅ Ultimate Alpha Bot started.');
setInterval(postTrending, Number(POLL_INTERVAL_MINUTES) * 60 * 1000);
postTrending();
