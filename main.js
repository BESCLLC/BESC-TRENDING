import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { DateTime } from 'luxon';

const {
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  POLL_INTERVAL_MINUTES = '60',
  TRENDING_SIZE = '5'
} = process.env;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID)
  throw new Error('Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID');

const bot = new TelegramBot(TELEGRAM_TOKEN);
const HC_BASE = 'https://api.beschypercharts.com';
let lastPinnedId = null;

function safeFloat(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function fmtUsd(n) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

async function fetchPairs() {
  try {
    const { data } = await axios.get(`${HC_BASE}/token/pairs/all`, { timeout: 15000 });
    return (data?.success?.data || []).filter(p => safeFloat(p.liquidityUsd) >= 100);
  } catch (e) {
    console.error('[TrendingBot] Failed to fetch pairs:', e.message);
    return [];
  }
}

async function fetchTokenInfo(contract) {
  try {
    const { data } = await axios.get(`${HC_BASE}/token/info/${contract}`, { timeout: 15000 });
    return data?.success?.data || null;
  } catch (e) {
    console.error(`[TrendingBot] Failed to fetch info for ${contract}:`, e.message);
    return null;
  }
}

async function computeTrending() {
  const pairs = await fetchPairs();
  const cutoff = DateTime.utc().minus({ minutes: Number(POLL_INTERVAL_MINUTES) });
  const trending = [];

  for (const p of pairs) {
    const info = await fetchTokenInfo(p.token0.contract);
    if (!info?.transactions?.length) continue;

    const recentTxs = info.transactions.filter(tx => {
      const txTime = DateTime.fromSeconds(Math.floor(tx.time));
      return txTime >= cutoff;
    });

    if (!recentTxs.length) continue;

    // Get price from pair info
    const price = safeFloat(info.pair?.pairInfos?.value || p.price || 0);
    let volUsd = 0;

    // Calculate USD volume based on tokenIn and tokenOut
    for (const tx of recentTxs) {
      const amountIn = safeFloat(tx.amountIn);
      const isMainTokenIn = tx.tokenIn === info.pair?.pairInfos?.mainToken;

      // If main token is input, use amountIn * price
      // If dependent token is input, use amountOut * price (since amountOut is in main token)
      if (isMainTokenIn) {
        volUsd += amountIn * price;
      } else {
        volUsd += safeFloat(tx.amountOut) * price;
      }
    }

    trending.push({
      pair: p,
      volUsd,
      txCount: recentTxs.length,
    });
  }

  trending.sort((a, b) => b.volUsd - a.volUsd);
  return trending.slice(0, Number(TRENDING_SIZE));
}

function formatTrending(trending) {
  if (!trending.length) {
    return `😴 <b>No trending pairs right now</b>\n🕒 Chain is quiet — check back later!`;
  }

  const lines = [
    `🔥 <b>BESC HyperChain — Top ${trending.length} Trending</b>`,
    `🕒 Last ${POLL_INTERVAL_MINUTES} min snapshot\n`
  ];

  trending.forEach((x, i) => {
    const t0 = x.pair.tokenunion();
    const t1 = x.pair.token1.symbol;
    const link = `https://www.geckoterminal.com/besc/pools/${x.pair.pair}`;

    lines.push(
      `${i + 1}️⃣ <b>${t0}/${t1}</b>\n` +
      `💵 Vol: ${fmtUsd(x.volUsd)} | 🧮 Tx: ${x.txCount}\n` +
      `💧 LQ: ${fmtUsd(x.pair.liquidityUsd)}\n` +
      `<a href="${link}">View Pair</a>\n`
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

    const msg = await bot.sendMessage(
      TELEGRAM_CHAT_ID,
      formatTrending(trending),
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );

    await bot.pinChatMessage(TELEGRAM_CHAT_ID, msg.message_id, { disable_notification: true });
    lastPinnedId = msg.message_id;
    console.log(`[TrendingBot] ✅ Posted trending (${trending.length} pairs)`);
  } catch (e) {
    console.error('[TrendingBot] Failed to post trending:', e.message);
  }
}

console.log('✅ BESC Trending Bot starting up...');
setInterval(postTrending, Number(POLL_INTERVAL_MINUTES) * 60 * 1000);
postTrending();
