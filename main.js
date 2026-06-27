import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';

const {
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  POLL_INTERVAL_MINUTES = '5',
  TRENDING_SIZE = '8',
  MIN_LIQ = '200',
  BLOCKED_TOKENS = 'WAGMI',  // comma-separated base token names to always hide
} = process.env;

// Build a Set from the env var so adding new blocked tokens needs no redeploy
const BLOCKED_SET = new Set(
  BLOCKED_TOKENS.split(',').map(t => t.trim().toUpperCase()).filter(Boolean)
);

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID)
  throw new Error('Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID');

const bot = new TelegramBot(TELEGRAM_TOKEN);
let lastPinnedId = null;
let prevRankMap = {};
let prevH24Vol = {};
let alertedPools = new Map(); // address -> timestamp

// The chain's native wrapped token — always the "quote" in a proper pair
const CHAIN_NATIVE = 'WBESC';

// When GeckoTerminal indexes a pool backwards (bridged major as base, WBESC as quote),
// we flip it so WBESC is the base and the price/changes make sense for this chain.
const FLIP_IF_BASE = /^(WBNB|WETH|WBTC|WMATIC|WAVAX|WSOL|WFTM|WONE|WCRO|WKCS|BNB|ETH|BTC)/i;

// Stablecoin base tokens — never useful in a trending list
const STABLE_RE = /^(USDC|USDT|BUSD|BUSDC|FUSD|WUSD|DAI|FRAX|TUSD|USDD|LUSD|GUSD|USDP|MIM|CUSD|SUSD|HUSD|FDUSD|PYUSD|CRVUSD|USDB|DOLA|EURC|EURT|EURS|WUSDC|WUSDT)/i;

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
  if (n >= 1000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toFixed(3)}`;
  if (n >= 0.001) return `$${n.toFixed(6)}`;
  return `$${n.toPrecision(3)}`;
}

function fmtPct(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0.0%';
  return `${num >= 0 ? '+' : ''}${num.toFixed(1)}%`;
}

// Fall back to h1 when m5 is flat so idle pools don't get a misleading 🟢
function moodEmoji(chgM5, chgH1) {
  const n = Math.abs(Number(chgM5)) < 0.1 ? Number(chgH1) : Number(chgM5);
  if (n >= 15) return '🚀';
  if (n >= 5)  return '📈';
  if (n >= 0)  return '🟢';
  if (n >= -5) return '🟡';
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
  return ['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`;
}

// ─── Pair orientation ──────────────────────────────────────────────────────────
// GeckoTerminal sometimes indexes pools with a bridged major (WBNB, WETH) as
// the base and WBESC as the quote. On BESC HyperChain, WBESC is the native so
// we flip those pairs so the display, price, and changes are all WBESC-centric.

function getPairView(p) {
  const a = p.attributes;
  const parts = (a.name || '').split('/').map(s => s.trim());
  const baseName  = parts[0] || '';
  const quoteName = parts[1] || '';

  const flipped = FLIP_IF_BASE.test(baseName) && quoteName === CHAIN_NATIVE;

  if (flipped) {
    // Price changes: if WBNB rose +5% vs WBESC, then WBESC fell ~-5% vs WBNB
    const inv = (x) => -(Number(x) || 0);
    return {
      name:    `${CHAIN_NATIVE} / ${baseName}`,
      price:   a.quote_token_price_usd,   // USD price of WBESC
      mc:      null,                        // can't derive WBESC MC from this pool alone
      chgM5:   inv(a.price_change_percentage?.m5),
      chgH1:   inv(a.price_change_percentage?.h1),
      chgH6:   inv(a.price_change_percentage?.h6),
      chgH24:  inv(a.price_change_percentage?.h24),
      // From WBESC perspective, a "buy of WBNB" = "sell of WBESC" and vice versa
      buysH1:  a.transactions?.h1?.sells || 0,
      sellsH1: a.transactions?.h1?.buys  || 0,
      volM5:   Number(a.volume_usd?.m5  || 0),
      volH1:   Number(a.volume_usd?.h1  || 0),
      volH24:  Number(a.volume_usd?.h24 || 0),
    };
  }

  return {
    name:    a.name,
    price:   a.base_token_price_usd,
    mc:      a.market_cap_usd || a.fdv_usd,
    chgM5:   Number(a.price_change_percentage?.m5  || 0),
    chgH1:   Number(a.price_change_percentage?.h1  || 0),
    chgH6:   Number(a.price_change_percentage?.h6  || 0),
    chgH24:  Number(a.price_change_percentage?.h24 || 0),
    buysH1:  a.transactions?.h1?.buys  || 0,
    sellsH1: a.transactions?.h1?.sells || 0,
    volM5:   Number(a.volume_usd?.m5  || 0),
    volH1:   Number(a.volume_usd?.h1  || 0),
    volH24:  Number(a.volume_usd?.h24 || 0),
  };
}

// ─── Pool quality filter ───────────────────────────────────────────────────────

function isGoodPool(p) {
  const baseName = (p.attributes.name || '').split('/')[0].trim().toUpperCase();
  if (STABLE_RE.test(baseName)) return false;
  if (BLOCKED_SET.has(baseName)) return false;

  const a   = p.attributes;
  const liq = Number(a.reserve_in_usd || 0);
  const txH24 = a.transactions?.h24 || {};
  const txH1  = a.transactions?.h1  || {};
  const txM5  = a.transactions?.m5  || {};

  if (liq < Number(MIN_LIQ)) return false;
  if ((txH24.buys || 0) + (txH24.sells || 0) + (txH1.buys || 0) + (txM5.buys || 0) < 1) return false;

  return true;
}

// ─── Hotness score ─────────────────────────────────────────────────────────────

function hotness(p) {
  const a      = p.attributes;
  const volM5  = Number(a.volume_usd?.m5  || 0);
  const volH1  = Number(a.volume_usd?.h1  || 0);
  const volH24 = Number(a.volume_usd?.h24 || 0);
  const chgM5  = Math.abs(Number(a.price_change_percentage?.m5 || 0));
  const chgH1  = Math.abs(Number(a.price_change_percentage?.h1 || 0));
  const txH1   = a.transactions?.h1 || {};
  const buysH1  = txH1.buys  || 0;
  const sellsH1 = txH1.sells || 0;
  const totalH1 = buysH1 + sellsH1;

  const h24avg      = volH24 / 24;
  const accel       = h24avg > 50 ? volH1 / h24avg : 1;
  const buyPressure = totalH1 > 0 ? buysH1 / totalH1 : 0.5;

  const prevVol = prevH24Vol[a.address] ?? volH24;
  const burst   = Math.max(0, volH24 - prevVol);

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

async function fetchPools() {
  const get = (params) =>
    axios.get('https://api.geckoterminal.com/api/v2/networks/besc-hyperchain/pools', {
      params, timeout: 15000,
    }).then(r => r.data.data || []).catch(() => []);

  const [byH24, byH1] = await Promise.all([
    get({ sort: 'h24_volume_usd_desc', page: 1 }),
    get({ sort: 'h1_volume_usd_desc',  page: 1 }),
  ]);

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
  for (const [addr, ts] of alertedPools) {
    if (Date.now() - ts > 4 * 3_600_000) alertedPools.delete(addr);
  }

  for (const p of pools) {
    const a = p.attributes;
    if (alertedPools.has(a.address)) continue;

    const ageMins = (Date.now() - new Date(a.pool_created_at).getTime()) / 60000;
    if (ageMins > 30) continue;

    const liq = Number(a.reserve_in_usd || 0);
    if (liq < 200) continue;

    alertedPools.set(a.address, Date.now());

    const pv     = getPairView(p);
    const price  = fmtPrice(pv.price);
    const buyPct = pv.buysH1 + pv.sellsH1 > 0
      ? Math.round(pv.buysH1 / (pv.buysH1 + pv.sellsH1) * 100) : 50;

    await bot.sendMessage(TELEGRAM_CHAT_ID,
      `🆕 <b>NEW LAUNCH DETECTED</b>\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `<b>${pv.name}</b>  ·  ${ageStr(a.pool_created_at)} old\n` +
      (price ? `💰 <b>${price}</b>${pv.mc ? `  MC: ${fmtUsd(pv.mc)}` : ''}\n` : '') +
      `📊 5m: <b>${fmtPct(pv.chgM5)}</b>  ·  1h: <b>${fmtPct(pv.chgH1)}</b>\n` +
      `💵 Vol → 5m: ${fmtUsd(pv.volM5)}  ·  1h: ${fmtUsd(pv.volH1)}\n` +
      `💧 Liq: ${fmtUsd(liq)}  ·  ${pv.buysH1}B / ${pv.sellsH1}S (${buyPct}% buys)\n` +
      `<a href="https://www.geckoterminal.com/besc-hyperchain/pools/${a.address}">📊 Open Chart</a>`,
      { parse_mode: 'HTML', disable_web_page_preview: true }
    ).catch(e => console.error('[TrendingBot] Alert failed:', e.message));
  }
}

// ─── Trending message ──────────────────────────────────────────────────────────

function formatTrending(pools, movers) {
  const time = new Date().toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false,
  });

  if (!pools.length) {
    return (
      `🔥 <b>BESC HyperChain Trending</b>  🕒 ${time} UTC\n\n` +
      `😴 <b>No active pools right now</b>\n` +
      `Chain is quiet — check back soon!\n\n` +
      `<a href="https://www.geckoterminal.com/besc-hyperchain/pools">Browse all pools ↗</a>`
    );
  }

  const lines = [`🔥 <b>BESC HyperChain Trending</b>  🕒 ${time} UTC`];

  if (movers.length) {
    lines.push(`⬆️ <b>Movers:</b> ${movers.map(m => `${m.name} ↑${m.delta}`).join('  ')}`);
  }

  for (let i = 0; i < pools.length; i++) {
    const p  = pools[i];
    const a  = p.attributes;
    const pv = getPairView(p);

    const price    = fmtPrice(pv.price);
    const totalH1  = pv.buysH1 + pv.sellsH1;
    const buyPct   = totalH1 > 0 ? Math.round(pv.buysH1 / totalH1 * 100) : 50;

    // Volume acceleration vs h24 rolling average
    const h24avg   = pv.volH24 / 24;
    const accel    = h24avg > 50 ? pv.volH1 / h24avg : null;
    const accelTag = accel && accel > 1.5 ? ` ⚡${accel.toFixed(1)}x` : '';

    // Rank movement
    const prevRank = prevRankMap[a.address];
    let rankTag = '';
    if (prevRank !== undefined && prevRank !== i) {
      const delta = prevRank - i;
      rankTag = delta > 0 ? ` 🔺+${delta}` : ` 🔻${Math.abs(delta)}`;
    }

    // Age tag for pools under 12h old
    const ageH   = (Date.now() - new Date(a.pool_created_at).getTime()) / 3_600_000;
    const ageTag = ageH < 12 ? ` 🆕${ageStr(a.pool_created_at)}` : '';

    const bpTag = buyPct >= 70 ? ' 🟢' : buyPct >= 55 ? ' 📈' : buyPct <= 30 ? ' 🔴' : '';

    const link = `https://www.geckoterminal.com/besc-hyperchain/pools/${a.address}`;

    lines.push(
      `\n${rankBadge(i)} <b>${pv.name}</b>${rankTag}${accelTag}${ageTag}\n` +
      (price ? `💰 <b>${price}</b>${pv.mc ? `  MC: ${fmtUsd(pv.mc)}` : ''}\n` : '') +
      `${moodEmoji(pv.chgM5, pv.chgH1)} 5m: <b>${fmtPct(pv.chgM5)}</b>  ·  1h: <b>${fmtPct(pv.chgH1)}</b>\n` +
      `📅 6h: <b>${fmtPct(pv.chgH6)}</b>  ·  24h: <b>${fmtPct(pv.chgH24)}</b>\n` +
      `📊 Vol 1h: ${fmtUsd(pv.volH1)}  💧 Liq: ${fmtUsd(a.reserve_in_usd)}\n` +
      `🔄 ${buyPct}% Buys (${pv.buysH1}B / ${pv.sellsH1}S)${bpTag}  <a href="${link}">Chart ↗</a>`
    );
  }

  lines.push(`\n<i>Updated every ${POLL_INTERVAL_MINUTES}m · BESC HyperChain</i>`);

  return lines.join('\n');
}

// ─── Main loop ─────────────────────────────────────────────────────────────────

async function postTrending() {
  try {
    const pools = await fetchPools();

    pools.sort((a, b) => hotness(b) - hotness(a));

    const newRankMap = {};
    for (let i = 0; i < pools.length; i++) {
      const addr = pools[i].attributes.address;
      newRankMap[addr] = i;
      prevH24Vol[addr] = Number(pools[i].attributes.volume_usd?.h24 || 0);
    }

    const movers = pools
      .filter(p => {
        const prev = prevRankMap[p.attributes.address];
        return prev !== undefined && prev - newRankMap[p.attributes.address] >= 3;
      })
      .slice(0, 3)
      .map(p => ({
        name:  getPairView(p).name,
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
    prevRankMap  = newRankMap;

    console.log(`[TrendingBot] ✅ Posted trending (${trending.length} pools)`);
  } catch (e) {
    console.error('[TrendingBot] Failed to post trending:', e.message);
  }
}

console.log('✅ BESC HyperChain Trending Bot started.');
setInterval(postTrending, Number(POLL_INTERVAL_MINUTES) * 60 * 1000);
postTrending();
