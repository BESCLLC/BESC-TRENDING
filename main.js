import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';

const {
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  POLL_INTERVAL_MINUTES = '5',
  TRENDING_SIZE = '8',
  MIN_LIQ = '2000',
} = process.env;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID)
  throw new Error('Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID');

const bot = new TelegramBot(TELEGRAM_TOKEN);
let lastPinnedId = null;
let prevRankMap = {};         // address -> rank from last run
let prevH24Vol = {};          // address -> h24 volume from last run (for burst calc)
let alertedPools = new Map(); // address -> timestamp (prevents repeat alerts)

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtUsd(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num === 0) return '$0';
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(2)}`;
}

function fmtPrice(p) {
  const n = Number(p);
  if (!n || !Number.isFinite(n)) return null;
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(3)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toPrecision(3)}`;
}

function fmtPct(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0.0%';
  return `${num >= 0 ? '+' : ''}${num.toFixed(1)}%`;
}

// Emoji based on 5m price change — the freshest signal
function moodEmoji(chgM5) {
  const n = Number(chgM5);
  if (n >= 10) return '🚀';
  if (n >= 2) return '📈';
  if (n >= 0) return '🟢';
  if (n >= -3) return '🟡';
  return '🔴';
}

function ageStr(createdAt) {
  const ms = Date.now() - new Date(createdAt).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = ms / 3_600_000;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${Math.floor(h / 24)}d`;
}

function rankBadge(i) {
  return ['🥇', '🥈', '🥉'][i] ?? `<b>${i + 1}.</b>`;
}

// ─── Pool quality filter ───────────────────────────────────────────────────────

function isGoodPool(p) {
  const a = p.attributes;
  const liq    = Number(a.reserve_in_usd || 0);
  const volH1  = Number(a.volume_usd?.h1  || 0);
  const volH24 = Number(a.volume_usd?.h24 || 0);
  const txH24  = a.transactions?.h24 || {};
  if (liq < Number(MIN_LIQ)) return false;
  if (volH1 < 100 && volH24 < 300) return false;
  if ((txH24.buys || 0) + (txH24.sells || 0) < 3) return false;
  return true;
}

// ─── Hotness score ─────────────────────────────────────────────────────────────
// Weights recent (m5, h1) activity much higher than h24 to surface emerging movers.

function hotness(p) {
  const a      = p.attributes;
  const volM5  = Number(a.volume_usd?.m5  || 0);
  const volH1  = Number(a.volume_usd?.h1  || 0);
  const volH24 = Number(a.volume_usd?.h24 || 0);
  const chgM5  = Math.abs(Number(a.price_change_percentage?.m5 || 0));
  const chgH1  = Math.abs(Number(a.price_change_percentage?.h1 || 0));
  const txH1   = a.transactions?.h1 || {};
  const buysH1 = txH1.buys  || 0;
  const sellsH1 = txH1.sells || 0;

  // Volume acceleration: h1 vs the rolling h24 hourly average
  const h24avg = volH24 / 24;
  const accel  = h24avg > 50 ? volH1 / h24avg : 1;

  // Buy pressure: fraction of h1 txns that are buys
  const totalH1 = buysH1 + sellsH1;
  const buyPressure = totalH1 > 0 ? buysH1 / totalH1 : 0.5;

  // Volume spike vs previous poll
  const prevVol = prevH24Vol[a.address] ?? volH24;
  const burst   = Math.max(0, volH24 - prevVol);

  // Age bonus — brand new pools get surfaced even with low absolute volume
  const ageH    = (Date.now() - new Date(a.pool_created_at).getTime()) / 3_600_000;
  const newBonus = ageH < 1 ? 3000 : ageH < 6 ? 800 : ageH < 12 ? 150 : 0;

  return (
    volM5  * 300 +
    volH1  * 20  +
    volH24 * 0.4 +
    burst  * 10  +
    buysH1 * 100 +
    chgM5  * volM5 * 0.2 +
    chgH1  * volH1 * 0.1 +
    (accel > 2 ? volH1 * 8 * Math.min(accel, 8) : 0) +
    (buyPressure > 0.65 ? volH1 * 5 : 0) +
    newBonus
  );
}

// ─── Fetch ─────────────────────────────────────────────────────────────────────
// Pull both h24 and h1 sorted pages simultaneously so we catch both established
// leaders and tokens that are surging right now.

async function fetchPools() {
  const get = (params) =>
    axios.get('https://api.geckoterminal.com/api/v2/networks/besc-hyperchain/pools', {
      params, timeout: 15000,
    }).then(r => r.data.data || []).catch(() => []);

  const [byH24, byH1] = await Promise.all([
    get({ sort: 'h24_volume_usd_desc', page: 1 }),
    get({ sort: 'h1_volume_usd_desc',  page: 1 }),
  ]);

  // Merge and deduplicate by address
  const seen = new Set();
  return [...byH24, ...byH1].filter(p => {
    const addr = p.attributes.address;
    if (seen.has(addr)) return false;
    seen.add(addr);
    return isGoodPool(p);
  });
}

// ─── New pool alerts ───────────────────────────────────────────────────────────

async function sendNewPoolAlerts(pools) {
  // Expire old alerts so we don't hold stale addresses forever
  for (const [addr, ts] of alertedPools) {
    if (Date.now() - ts > 4 * 3_600_000) alertedPools.delete(addr);
  }

  for (const p of pools) {
    const a = p.attributes;
    if (alertedPools.has(a.address)) continue;

    const ageMins = (Date.now() - new Date(a.pool_created_at).getTime()) / 60000;
    if (ageMins > 30) continue;

    const liq   = Number(a.reserve_in_usd || 0);
    const volH1 = Number(a.volume_usd?.h1  || 0);
    const volM5 = Number(a.volume_usd?.m5  || 0);
    if (liq < 1500 && volH1 < 300) continue;

    alertedPools.set(a.address, Date.now());

    const txH1  = a.transactions?.h1 || {};
    const buys  = txH1.buys  || 0;
    const sells = txH1.sells || 0;
    const buyPct = buys + sells > 0 ? Math.round(buys / (buys + sells) * 100) : 50;
    const mc     = a.market_cap_usd || a.fdv_usd;
    const price  = fmtPrice(a.base_token_price_usd);
    const chgM5  = Number(a.price_change_percentage?.m5 || 0);
    const chgH1  = Number(a.price_change_percentage?.h1 || 0);

    await bot.sendMessage(TELEGRAM_CHAT_ID,
      `🆕 <b>NEW LAUNCH DETECTED</b>\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `<b>${a.name}</b>  ·  ${ageStr(a.pool_created_at)} old\n` +
      (price ? `💰 <b>${price}</b>${mc ? `  MC: ${fmtUsd(mc)}` : ''}\n` : '') +
      `📊 5m: <b>${fmtPct(chgM5)}</b>  1h: <b>${fmtPct(chgH1)}</b>\n` +
      `💵 Vol 5m: <b>${fmtUsd(volM5)}</b>  1h: <b>${fmtUsd(volH1)}</b>\n` +
      `💧 Liq: <b>${fmtUsd(liq)}</b>  · ${buys}B / ${sells}S (${buyPct}% buys)\n` +
      `<a href="https://www.geckoterminal.com/besc-hyperchain/pools/${a.address}">📊 Open Chart</a>`,
      { parse_mode: 'HTML', disable_web_page_preview: true }
    ).catch(e => console.error('[TrendingBot] Alert failed:', e.message));
  }
}

// ─── Trending message ──────────────────────────────────────────────────────────

function formatTrending(pools, movers) {
  if (!pools.length) {
    return `😴 <b>No trending pools right now</b>\n🕒 Chain is quiet — check back soon!`;
  }

  const time = new Date().toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false,
  });

  const lines = [`🔥 <b>BESC HyperChain — Live Trending</b>  🕒 ${time} UTC`];

  if (movers.length) {
    lines.push(`⬆️ Movers: ${movers.map(m => `${m.name} ↑${m.delta}`).join('  ')}`);
  }
  lines.push('');

  for (let i = 0; i < pools.length; i++) {
    const p = pools[i];
    const a = p.attributes;

    const volM5  = Number(a.volume_usd?.m5  || 0);
    const volH1  = Number(a.volume_usd?.h1  || 0);
    const volH24 = Number(a.volume_usd?.h24 || 0);
    const chgM5  = Number(a.price_change_percentage?.m5  || 0);
    const chgH1  = Number(a.price_change_percentage?.h1  || 0);
    const chgH6  = Number(a.price_change_percentage?.h6  || 0);
    const chgH24 = Number(a.price_change_percentage?.h24 || 0);
    const txH1   = a.transactions?.h1 || {};
    const buysH1  = txH1.buys  || 0;
    const sellsH1 = txH1.sells || 0;
    const totalH1 = buysH1 + sellsH1;
    const buyPct  = totalH1 > 0 ? Math.round(buysH1 / totalH1 * 100) : 50;
    const mc      = a.market_cap_usd || a.fdv_usd;
    const price   = fmtPrice(a.base_token_price_usd);

    // Volume acceleration vs h24 rolling average
    const h24avg   = volH24 / 24;
    const accel    = h24avg > 50 ? volH1 / h24avg : null;
    const accelTag = accel && accel > 1.5 ? ` ⚡${accel.toFixed(1)}x` : '';

    // Rank movement vs last run
    const prevRank = prevRankMap[a.address];
    let rankTag = '';
    if (prevRank !== undefined && prevRank !== i) {
      const delta = prevRank - i;
      rankTag = delta > 0 ? ` 🔺+${delta}` : ` 🔻${Math.abs(delta)}`;
    }

    // New pool tag (< 12h)
    const ageH   = (Date.now() - new Date(a.pool_created_at).getTime()) / 3_600_000;
    const ageTag = ageH < 12 ? ` 🆕${ageStr(a.pool_created_at)}` : '';

    // Buy pressure indicator
    const bpTag = buyPct >= 70 ? ' 🟢' : buyPct >= 55 ? ' 📈' : buyPct <= 30 ? ' 🔴' : '';

    const link = `https://www.geckoterminal.com/besc-hyperchain/pools/${a.address}`;

    lines.push(
      `${rankBadge(i)} <b>${a.name}</b>${rankTag}${accelTag}${ageTag}\n` +
      (price ? `   💰 <b>${price}</b>${mc ? `  MC: ${fmtUsd(mc)}` : ''}\n` : '') +
      `   ${moodEmoji(chgM5)} 5m:<b>${fmtPct(chgM5)}</b>  1h:<b>${fmtPct(chgH1)}</b>  6h:<b>${fmtPct(chgH6)}</b>  24h:<b>${fmtPct(chgH24)}</b>\n` +
      `   📊 5m:${fmtUsd(volM5)}  1h:${fmtUsd(volH1)}  💧${fmtUsd(a.reserve_in_usd)}\n` +
      `   ${buyPct}% Buys (${buysH1}B/${sellsH1}S)${bpTag}  <a href="${link}">Chart ↗</a>\n`
    );
  }

  return lines.join('\n');
}

// ─── Main loop ─────────────────────────────────────────────────────────────────

async function postTrending() {
  try {
    const pools = await fetchPools();

    // Sort by hotness (uses prevH24Vol from last run for burst calculation)
    pools.sort((a, b) => hotness(b) - hotness(a));

    // Lock in current ranks and h24 volumes for next run's comparison
    const newRankMap = {};
    for (let i = 0; i < pools.length; i++) {
      const addr = pools[i].attributes.address;
      newRankMap[addr] = i;
      prevH24Vol[addr] = Number(pools[i].attributes.volume_usd?.h24 || 0);
    }

    // Find pools that climbed ≥3 positions since last run
    const movers = pools
      .filter(p => {
        const prev = prevRankMap[p.attributes.address];
        return prev !== undefined && prev - newRankMap[p.attributes.address] >= 3;
      })
      .slice(0, 3)
      .map(p => ({
        name: p.attributes.name,
        delta: prevRankMap[p.attributes.address] - newRankMap[p.attributes.address],
      }));

    await sendNewPoolAlerts(pools);

    const trending = pools.slice(0, Number(TRENDING_SIZE));

    if (lastPinnedId) {
      await bot.unpinAllChatMessages(TELEGRAM_CHAT_ID).catch(() => {});
      await bot.deleteMessage(TELEGRAM_CHAT_ID, lastPinnedId).catch(() => {});
    }

    const msg = await bot.sendMessage(
      TELEGRAM_CHAT_ID,
      formatTrending(trending, movers),
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );

    await bot.pinChatMessage(TELEGRAM_CHAT_ID, msg.message_id, { disable_notification: true });
    lastPinnedId = msg.message_id;
    prevRankMap = newRankMap;

    console.log(`[TrendingBot] ✅ Posted trending (${trending.length} pools)`);
  } catch (e) {
    console.error('[TrendingBot] Failed to post trending:', e.message);
  }
}

console.log('✅ BESC HyperChain Trending Bot started.');
setInterval(postTrending, Number(POLL_INTERVAL_MINUTES) * 60 * 1000);
postTrending();
