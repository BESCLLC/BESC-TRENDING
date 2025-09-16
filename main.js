import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';

const {
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  POLL_INTERVAL_MINUTES = '60',
  TRENDING_SIZE = '5',
  DEBUG = 'true' // toggle for verbose logging
} = process.env;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID)
  throw new Error('Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID');

const bot = new TelegramBot(TELEGRAM_TOKEN);
const ALL_PAIRS_URL = 'https://api.beschypercharts.com/token/pairs/all';
const INFO_URL = 'https://api.beschypercharts.com/token/info/';

let lastPinnedId = null;
const oneHourAgo = () => Math.floor(Date.now() / 1000) - (Number(POLL_INTERVAL_MINUTES) * 60);

function fmtUsd(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
}

async function fetchPairs() {
  const { data } = await axios.get(ALL_PAIRS_URL, { timeout: 20000 });
  const pairs = (data?.data || []).filter(p => (p.liquidityUsd ?? 0) >= 100);
  if (DEBUG === 'true') console.log(`[DEBUG] Fetched ${pairs.length} pairs from /all`);
  return pairs;
}

async function fetchPairInfo(contract) {
  try {
    const { data } = await axios.get(`${INFO_URL}${contract}`, { timeout: 20000 });
    return data?.success?.data || null;
  } catch (e) {
    console.warn(`[TrendingBot] Failed info for ${contract}:`, e.message);
    return null;
  }
}

async function computeTrending() {
  const pairs = await fetchPairs();
  const cutoff = oneHourAgo();

  const enriched = await Promise.all(
    pairs.map(async p => {
      const info = await fetchPairInfo(p.token0.contract);
      const txs = info?.transactions || [];
      const recent = txs.filter(t => t.time >= cutoff);
      const vol = recent.reduce((sum, t) => sum + Number(t.amountIn || 0), 0);

      if (DEBUG === 'true') {
        console.log(`\n[DEBUG] Pair ${p.token0.symbol}/${p.token1.symbol}`);
        console.log(`- Total txs: ${txs.length}, Recent (>= ${cutoff}): ${recent.length}`);
        if (recent.length > 0) {
          console.log(`- First recent tx: ${new Date(recent[0].time * 1000).toISOString()}`);
          console.log(`- Last recent tx:  ${new Date(recent[recent.length - 1].time * 1000).toISOString()}`);
          console.log(`- Volume counted: ${vol}`);
        } else {
          console.log(`- No recent tx in window`);
        }
      }

      return { ...p, vol, txCount: recent.length };
    })
  );

  const scored = enriched
    .filter(x => x.txCount > 0 || x.vol > 0)
    .map(x => ({
      pair: x,
      score: (x.vol * 0.5) + (x.txCount * 15)
    }))
    .sort((a, b) => b.score - a.score);

  if (DEBUG === 'true') console.log(`[DEBUG] ${scored.length} pairs had >0 volume or txs`);

  if (!scored.length) {
    return {
      trending: pairs.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)).slice(0, TRENDING_SIZE),
      isFallback: true
    };
  }

  return {
    trending: scored.slice(0, TRENDING_SIZE).map(x => x.pair),
    isFallback: false
  };
}

function formatTrending({ trending, isFallback }) {
  if (!trending.length) {
    return `😴 <b>No trending pairs right now</b>\n🕒 No trades in the last ${POLL_INTERVAL_MINUTES} minutes.`;
  }

  const title = isFallback
    ? `💤 <b>BESC HyperChain — Quiet Market</b>\n📊 Showing top pairs by liquidity:\n`
    : `🔥 <b>BESC HyperChain — Top ${TRENDING_SIZE} Trending</b>\n🕒 Last ${POLL_INTERVAL_MINUTES} min snapshot\n`;

  const lines = [title];

  trending.forEach((p, i) => {
    const t0 = p.token0.symbol || '?';
    const t1 = p.token1.symbol || '?';
    const vol = fmtUsd(p.vol || 0);
    const txs = p.txCount || p.transactions24h || 0;
    const liq = fmtUsd(p.liquidityUsd);
    const link = `https://www.geckoterminal.com/vsc/pools/${p.pair}`;

    lines.push(
      `${i + 1}️⃣ <b>${t0}/${t1}</b>\n` +
      `💵 Vol: ${vol} | 🧮 Tx: ${txs}\n` +
      `💧 LQ: ${liq}\n` +
      `<a href="${link}">View Pair</a>\n`
    );
  });

  return lines.join('\n');
}

async function postTrending() {
  try {
    const result = await computeTrending();

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
    console.log(`[TrendingBot] ✅ Posted trending (${result.trending.length} pairs)${result.isFallback ? ' [Fallback]' : ''}`);
  } catch (e) {
    console.error('[TrendingBot] Failed to post trending:', e.message);
  }
}

console.log('✅ BESC Trending Bot starting up...');
setInterval(postTrending, Number(POLL_INTERVAL_MINUTES) * 60 * 1000);
postTrending();
