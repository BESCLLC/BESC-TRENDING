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
    const pairs = (data?.success?.data || []).filter(p => safeFloat(p.liquidityUsd) >= 100);
    console.log(`[TrendingBot] Fetched ${pairs.length} pairs with liquidity >= $100`);
    return pairs;
  } catch (e) {
    console.error('[TrendingBot] Failed to fetch pairs:', e.message);
    return [];
  }
}

async function fetchTokenInfo(contract) {
  try {
    const { data } = await axios.get(`${HC_BASE}/token/info/${contract}`, { timeout: 15000 });
    const info = data?.success?.data || null;
    console.log(`[TrendingBot] Fetched info for contract ${contract}: ${info ? `Success, ${info.transactions?.length || 0} transactions` : 'No data'}`);
    return info;
  } catch (e) {
    console.error(`[TrendingBot] Failed to fetch info for ${contract}: ${e.message}`);
    return null;
  }
}

async function computeTrending() {
  const pairs = await fetchPairs();
  const cutoff = DateTime.utc().minus({ minutes: Number(POLL_INTERVAL_MINUTES) });
  console.log(`[TrendingBot] Cutoff time: ${cutoff.toISO()}`);
  const trending = [];

  for (const p of pairs) {
    console.log(`[TrendingBot] Processing pair ${p.token0.symbol}/${p.token1.symbol} (${p.pair})`);

    // Try fetching transactions for both token0 and token1
    const info0 = await fetchTokenInfo(p.token0.contract);
    const info1 = await fetchTokenInfo(p.token1.contract);

    // Combine transactions from both tokens
    const transactions = [
      ...(info0?.transactions || []),
      ...(info1?.transactions || [])
    ].filter(tx => {
      const txTime = DateTime.fromSeconds(Math.floor(tx.time));
      return txTime >= cutoff && tx.pair === p.pair; // Ensure transactions belong to this pair
    });

    console.log(`[TrendingBot] Found ${transactions.length} recent transactions for ${p.token0.symbol}/${p.token1.symbol}`);

    if (!transactions.length) continue;

    const price = safeFloat(p.price || info0?.pair?.pairInfos?.value || info1?.pair?.pairInfos?.value || 0);
    if (price === 0) {
      console.log(`[TrendingBot] Skipping ${p.token0.symbol}/${p.token1.symbol}: Zero price`);
      continue;
    }
    console.log(`[TrendingBot] Price for ${p.token0.symbol}/${p.token1.symbol}: ${price}`);

    let volUsd = 0;
    const mainToken = info0?.pair?.pairInfos?.mainToken || p.token0.contract;
    for (const tx of transactions) {
      const amountIn = safeFloat(tx.amountIn);
      const amountOut = safeFloat(tx.amountOut);
      const isMainTokenIn = tx.tokenIn === mainToken;
      // If input is main token, use amountIn; if output is main token, use amountOut
      const vol = isMainTokenIn ? amountIn : amountOut * price;
      volUsd += vol;
      console.log(`[TrendingBot] Tx ${tx._id}: isMainTokenIn=${isMainTokenIn}, amountIn=${amountIn}, amountOut=${amountOut}, vol=${vol}`);
    }

    console.log(`[TrendingBot] Total volume for ${p.token0.symbol}/${p.token1.symbol}: ${volUsd}`);

    trending.push({
      pair: p,
      volUsd,
      txCount: transactions.length,
    });
  }

  trending.sort((a, b) => b.volUsd - a.volUsd);
  console.log(`[TrendingBot] Top ${trending.length} trending pairs:`, trending.map(t => ({
    pair: `${t.pair.token0.symbol}/${t.pair.token1.symbol}`,
    volUsd: t.volUsd,
    txCount: t.txCount
  })));

  return trending.slice(0, Number(TRENDING_SIZE));
}

function formatTrending(trending) {
  if (!trending.length) {
    console.log('[TrendingBot] No trending pairs to format');
    return `😴 <b>No trending pairs right now</b>\n🕒 Chain is quiet — check back later!`;
  }

  const lines = [
    `🔥 <b>BESC HyperChain — Top ${trending.length} Trending</b>`,
    `🕒 Last ${POLL_INTERVAL_MINUTES} min snapshot\n`
  ];

  trending.forEach((x, i) => {
    const t0 = x.pair.token0.symbol;
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
