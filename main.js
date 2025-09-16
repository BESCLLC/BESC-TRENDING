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

function safeFloat(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function fmtUsd(n) {
  if (!n || n <= 0) return `$0.00`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

async function fetchPairs() {
  try {
    const { data } = await axios.get(`${HYPERCHARTS_BASE}/token/pairs/all`, { timeout: 10000 });
    return (data?.success?.data || []).filter(p => safeFloat(p.liquidityUsd) > 0);
  } catch (e) {
    console.error('[TrendingBot] Failed to fetch pairs:', e.message);
    return [];
  }
}

async function fetchTokenInfo(contract) {
  try {
    const { data } = await axios.get(`${HYPERCHARTS_BASE}/token/info/${contract}`, { timeout: 10000 });
    return data?.success?.data || null;
  } catch {
    return null;
  }
}

async function computeTrending() {
  const pairs = await fetchPairs();
  const cutoff = DateTime.utc().minus({ minutes: Number(POLL_INTERVAL_MINUTES) });
  const results = [];

  for (const pair of pairs) {
    let trades = [];

    // Get token0 + token1 info and merge transactions for this pair
    const [info0, info1] = await Promise.all([
      fetchTokenInfo(pair.token0.contract),
      fetchTokenInfo(pair.token1.contract)
    ]);

    [info0?.transactions, info1?.transactions].forEach(txList => {
      if (!txList) return;
      txList.forEach(t => {
        if (t.pair?.toLowerCase() === pair.pair.toLowerCase()) {
          if (DateTime.fromSeconds(Math.floor(t.time)) >= cutoff) {
            trades.push(t);
          }
        }
      });
    });

    if (!trades.length) continue;

    const volume = trades.reduce((sum, t) => sum + safeFloat(t.amountIn), 0);
    results.push({
      pair,
      volume,
      trades: trades.length,
      score: volume * 0.7 + trades.length * 15
    });
  }

  results.sort((a, b) => b.score - a.score);

  if (!results.length) {
    const fallback = pairs
      .sort((a, b) => safeFloat(b.liquidityUsd) - safeFloat(a.liquidityUsd))
      .slice(0, Number(TRENDING_SIZE))
      .map(p => ({ pair: p, volume: 0, trades: p.transactions24h ?? 0, score: 0 }));
    return { trending: fallback, isFallback: true };
  }

  return { trending: results.slice(0, Number(TRENDING_SIZE)), isFallback: false };
}

function formatTrending({ trending, isFallback }) {
  const header = isFallback
    ? `💤 <b>BESC HyperChain — Quiet Market</b>\n📊 Showing top pairs by liquidity:\n`
    : `🔥 <b>BESC HyperChain — Top ${trending.length} Trending</b>\n🕒 Last ${POLL_INTERVAL_MINUTES} min snapshot\n`;

  const lines = [header];

  trending.forEach((x, i) => {
    const p = x.pair;
    const t0 = p.token0.symbol || '?';
    const t1 = p.token1.symbol || '?';
    const link = `https://beschypercharts.com/pair/${p.pair}`;
    lines.push(
      `${i + 1}️⃣ <b>${t0}/${t1}</b>\n` +
      `💵 Vol: ${fmtUsd(x.volume)} | 🧮 Tx: ${x.trades}\n` +
      `💧 LQ: ${fmtUsd(safeFloat(p.liquidityUsd))}\n` +
      `<a href="${link}">View Pair</a>\n`
    );
  });

  return lines.join('\n');
}

async function postTrending() {
  try {
    const result = await computeTrending();
    console.log(`[TrendingBot] Found ${result.trending.length} trending pairs`);

    if (lastPinnedId) {
      await bot.unpinAllChatMessages(TELEGRAM_CHAT_ID).catch(() => {});
      await bot.deleteMessage(TELEGRAM_CHAT_ID, lastPinnedId).catch(() => {});
    }

    const msg = await bot.sendMessage(
      TELEGRAM_CHAT_ID,
      formatTrending(result),
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );

    await bot.pinChatMessage(TELEGRAM_CHAT_ID, msg.message_id, { disable_notification: true });
    lastPinnedId = msg.message_id;
    console.log(`[TrendingBot] ✅ Posted trending`);
  } catch (e) {
    console.error('[TrendingBot] Failed to post trending:', e.message);
  }
}

console.log('✅ BESC Trending Bot starting up...');
setInterval(postTrending, Number(POLL_INTERVAL_MINUTES) * 60 * 1000);
postTrending();
