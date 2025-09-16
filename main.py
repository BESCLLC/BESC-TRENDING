import os
import time
import json
import logging
import requests
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict
from requests.exceptions import RequestException
from ratelimit import limits, sleep_and_retry

# Configure logging with both file and console output
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler("bot.log"),
        logging.StreamHandler()  # Output to console for Railway logs
    ]
)
logger = logging.getLogger(__name__)

# Configuration
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
NETWORK_SLUGS = os.environ.get("NETWORK_SLUGS", "besc-hyperchain").strip().split(",")
TRENDING_SIZE = 5  # Fixed to top 5 for clean chat
ALERT_THRESHOLD = os.environ.get("ALERT_THRESHOLD", "100").strip()
CHECK_INTERVAL_MINUTES = 5  # Update every 5 minutes
API_CALLS_PER_MINUTE = 10  # Rate limit for GeckoTerminal API

# Validate environment variables and Telegram connectivity
TG_API = f"https://api.telegram.org/bot{BOT_TOKEN}"
try:
    if not BOT_TOKEN:
        logger.error("TELEGRAM_BOT_TOKEN is missing")
        raise SystemExit("❌ TELEGRAM_BOT_TOKEN is missing")
    if not CHAT_ID:
        logger.error("TELEGRAM_CHAT_ID is missing")
        raise SystemExit("❌ TELEGRAM_CHAT_ID is missing")
    ALERT_THRESHOLD = float(ALERT_THRESHOLD)
    logger.info("Environment variables validated successfully")
    logger.info(f"Networks: {', '.join(NETWORK_SLUGS)}")
    logger.info(f"Alert threshold: {ALERT_THRESHOLD}%")

    # Test Telegram API connectivity
    test_response = requests.get(f"{TG_API}/getMe", timeout=10).json()
    if not test_response.get("ok"):
        logger.error(f"Invalid TELEGRAM_BOT_TOKEN: {test_response}")
        raise SystemExit(f"❌ Invalid TELEGRAM_BOT_TOKEN: {test_response}")
    logger.info("Telegram API connectivity verified")
except ValueError as e:
    logger.error(f"Invalid ALERT_THRESHOLD: {ALERT_THRESHOLD}")
    raise SystemExit(f"❌ Invalid ALERT_THRESHOLD: {ALERT_THRESHOLD}")
except RequestException as e:
    logger.error(f"Failed to connect to Telegram API: {e}")
    raise SystemExit(f"❌ Failed to connect to Telegram API: {e}")
except Exception as e:
    logger.error(f"Unexpected error during startup: {e}")
    raise SystemExit(f"❌ Unexpected error during startup: {e}")

# API Endpoints
GECKO_BASE = "https://api.geckoterminal.com/api/v2"
GECKO_HEADERS = {"accept": "application/json; version=20230302"}

# State
STATE_FILE = "state.json"
state = {"last_trending_id": {}, "alerted_pools": {}}

def load_state():
    global state
    try:
        with open(STATE_FILE, "r") as f:
            state = json.load(f)
        logger.info("Loaded state.json successfully")
    except FileNotFoundError:
        logger.warning("state.json not found. Using default state")
        state = {"last_trending_id": {}, "alerted_pools": {}}
    except Exception as e:
        logger.warning(f"Could not load state.json: {e}. Using default state")
        state = {"last_trending_id": {}, "alerted_pools": {}}

def save_state():
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(state, f)
        logger.info("Saved state.json successfully")
    except Exception as e:
        logger.warning(f"Could not save state.json: {e}")

@sleep_and_retry
@limits(calls=API_CALLS_PER_MINUTE, period=60)
def fetch_with_retry(url: str, headers: dict, method: str = "GET", data: dict = None, retries: int = 3, backoff: int = 2) -> dict:
    for attempt in range(retries):
        try:
            if method == "POST":
                r = requests.post(url, headers=headers, json=data, timeout=20)
            else:
                r = requests.get(url, headers=headers, timeout=20)
            r.raise_for_status()
            logger.debug(f"Fetched {url} successfully (status: {r.status_code})")
            return r.json()
        except RequestException as e:
            logger.warning(f"Request failed for {url}: {e}. Retrying {attempt+1}/{retries}")
            time.sleep(backoff * (2 ** attempt))
    logger.error(f"Failed to fetch {url} after {retries} retries")
    return {}

def tg_send(text: str, parse_mode: str = "HTML") -> Optional[int]:
    payload = {"chat_id": CHAT_ID, "text": text, "parse_mode": parse_mode, "disable_web_page_preview": True}
    try:
        data = fetch_with_retry(f"{TG_API}/sendMessage", headers={}, method="POST", data=payload)
        if not data.get("ok"):
            logger.error(f"Telegram sendMessage error: {data}")
            return None
        message_id = data["result"]["message_id"]
        logger.info(f"Sent Telegram message: {message_id}")
        return message_id
    except Exception as e:
        logger.error(f"Telegram sendMessage exception: {e}")
        return None

def tg_delete(mid: Optional[int]):
    if mid:
        try:
            fetch_with_retry(f"{TG_API}/deleteMessage", headers={}, method="POST", data={"chat_id": CHAT_ID, "message_id": mid})
            logger.info(f"Deleted Telegram message: {mid}")
        except Exception as e:
            logger.warning(f"Failed to delete Telegram message {mid}: {e}")

def tg_pin(mid: Optional[int]):
    if not mid:
        return
    try:
        fetch_with_retry(f"{TG_API}/unpinAllChatMessages", headers={}, method="POST", data={"chat_id": CHAT_ID})
        fetch_with_retry(f"{TG_API}/pinChatMessage", headers={}, method="POST", data={"chat_id": CHAT_ID, "message_id": mid, "disable_notification": True})
        logger.info(f"Pinned Telegram message: {mid}")
    except Exception as e:
        logger.warning(f"Failed to pin Telegram message {mid}: {e}")

def safe_float(x, default=0.0) -> float:
    try:
        return float(str(x).replace(",", ""))
    except (ValueError, TypeError):
        return default

def fmt_usd(n: float) -> str:
    if n >= 1_000_000:
        return f"${n/1_000_000:.2f}M"
    if n >= 1_000:
        return f"${n/1_000:.2f}K"
    return f"${n:.2f}"

def fmt_age(created_at: str) -> str:
    try:
        created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        age = datetime.now(timezone.utc) - created
        if age.days > 30:
            return f"{age.days // 30}m"
        if age.days > 0:
            return f"{age.days}d"
        return f"{int(age.total_seconds() // 3600)}h"
    except (ValueError, TypeError):
        return "N/A"

def number_emoji(n: int) -> str:
    mapping = {1: "1️⃣", 2: "2️⃣", 3: "3️⃣", 4: "4️⃣", 5: "5️⃣"}
    return mapping.get(n, f"{n}.")

def extract_pair(attr: dict) -> str:
    # Fallback extraction since include=token0,token1 is removed; use embedded attributes
    base_symbol = attr.get("base_token_symbol", "?")
    quote_symbol = attr.get("quote_token_symbol", "?")
    return f"{base_symbol}/{quote_symbol}"

def fetch_trending(slug: str, size: int = 50) -> List[tuple]:
    try:
        logger.info(f"Fetching trending pools for {slug}")
        # Fixed URL: Removed invalid &include=token0,token1
        url = f"{GECKO_BASE}/networks/{slug}/pools?sort=-volume_usd.h24&page[size]={size}"
        data = fetch_with_retry(url, GECKO_HEADERS)
        pools = data.get("data", [])
        logger.info(f"API response: {len(pools)} pools returned")
        trend_list = []
        cutoff_10m = datetime.now(timezone.utc) - timedelta(minutes=10)

        for p in pools:
            attrs = p.get("attributes", {})
            h24_vol = safe_float((attrs.get("volume_usd") or {}).get("h24", 0))
            liq = safe_float(attrs.get("reserve_in_usd", 0))
            fdv = safe_float(attrs.get("fdv_usd", 0))
            price_change_10m = safe_float((attrs.get("price_change_percentage") or {}).get("m5", 0))
            price_change_1h = safe_float((attrs.get("price_change_percentage") or {}).get("h1", 0))
            price_change_24h = safe_float((attrs.get("price_change_percentage") or {}).get("h24", 0))
            pool_age = attrs.get("pool_created_at", "")
            pool_id = p.get("id")

            # Fetch trades only if needed; fallback to 24h metrics if no recent trades
            trades_url = f"{GECKO_BASE}/networks/{slug}/pools/{pool_id}/trades"
            trades = fetch_with_retry(trades_url, GECKO_HEADERS).get("data", [])
            recent_trades = []
            if trades:
                recent_trades = [
                    tr for tr in trades
                    if datetime.fromisoformat(tr["attributes"]["timestamp"].replace("Z", "+00:00")) >= cutoff_10m
                ]

            if recent_trades:
                short_vol = sum(safe_float(tr["attributes"]["trade_amount_usd"]) for tr in recent_trades)
                net_buys = sum(
                    safe_float(tr["attributes"]["trade_amount_usd"]) * (1 if tr["attributes"]["side"] == "buy" else -1)
                    for tr in recent_trades
                )
                trade_count = len(recent_trades)
                spike_ratio = short_vol / h24_vol if h24_vol > 0 else 1.0
            else:
                # Fallback: Use 24h metrics if no recent trades
                short_vol = h24_vol * 0.1  # Approximate 10m as 1/144 of 24h
                net_buys = 0
                trade_count = safe_float(attrs.get("txns_h24", 0))
                spike_ratio = 1.0

            # Scoring: Balanced to favor high volume, price changes, liquidity, and net buys
            score = (
                (short_vol * 0.3) +
                (abs(price_change_24h) * 50) +
                (abs(price_change_1h) * 20) +
                (trade_count * 10) +
                (spike_ratio * 100) +
                (liq * 0.001) +
                (net_buys * 0.01)
            )
            trend_list.append((
                score, p, short_vol, price_change_10m, price_change_1h, price_change_24h,
                trade_count, spike_ratio, liq, fdv, net_buys, pool_age
            ))

        trend_list.sort(key=lambda x: x[0], reverse=True)
        logger.info(f"Fetched {len(trend_list)} trending pools for {slug}")
        return trend_list[:TRENDING_SIZE]  # Limit to top 5
    except Exception as e:
        logger.error(f"Error in fetch_trending for {slug}: {e}")
        return []

def send_alert(slug: str, pool: Dict, price_change_24h: float, h24_vol: float, link: str, pool_age: str):
    pool_id = pool.get("id")
    # Avoid duplicate alerts within 24 hours
    alerted_pools = state.get("alerted_pools", {}).get(slug, {})
    if pool_id in alerted_pools:
        last_alerted = datetime.fromisoformat(alerted_pools[pool_id].replace("Z", "+00:00"))
        if (datetime.now(timezone.utc) - last_alerted).total_seconds() < 24 * 3600:
            logger.debug(f"Skipping duplicate alert for pool {pool_id}")
            return
    name = extract_pair(pool.get("attributes", {}))
    text = (
        f"🚨 <b>ALERT: {name} on {slug.upper()}</b>\n"
        f"📈 24h Surge: {price_change_24h:+.2f}%\n"
        f"💵 24h Vol: {fmt_usd(h24_vol)}\n"
        f"📅 Age: {fmt_age(pool_age)}\n"
        f"<a href='{link}'>View Pool</a>"
    )
    mid = tg_send(text)
    if mid:
        state.setdefault("alerted_pools", {}).setdefault(slug, {})[pool_id] = datetime.now(timezone.utc).isoformat()
        save_state()
        logger.info(f"Sent alert for {name} on {slug}: {price_change_24h:+.2f}%")

def format_trending(slug: str, trend_list: List[tuple]) -> str:
    lines = [f"🔥 <b>{slug.upper()} — Top 5 Trending Tokens</b>", f"🕒 Updated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M')} UTC\n"]
    for i, (score, p, short_vol, pc_10m, pc_1h, pc_24h, trade_count, spike_ratio, liq, fdv, net_buys, pool_age) in enumerate(trend_list, 1):
        a = p.get("attributes", {})
        name = extract_pair(a)
        link = a.get("url") or f"https://www.geckoterminal.com/{slug}/pools/{p.get('id')}"
        pc_emoji = "📈" if pc_24h >= 0 else "📉"
        lines.append(
            f"{number_emoji(i)} <b>{name}</b>\n"
            f"{pc_emoji} 24h: {pc_24h:+.2f}% | 1h: {pc_1h:+.2f}% | 10m: {pc_10m:+.2f}%\n"
            f"💵 Vol: {fmt_usd(short_vol)} | 💧 Liq: {fmt_usd(liq)}\n"
            f"📊 FDV: {fmt_usd(fdv)} | 🛒 Net Buys: {fmt_usd(net_buys)}\n"
            f"📅 Age: {fmt_age(pool_age)} | 🧮 Trades: {trade_count}\n"
            f"<a href='{link}'>View</a>\n"
        )
    lines.append(f"<a href='https://www.geckoterminal.com/{slug}/pools'>View All Pools</a>")
    return "\n".join(lines)

def next_aligned(now: datetime) -> datetime:
    total = int(now.timestamp() // 60)
    remainder = total % CHECK_INTERVAL_MINUTES
    add = (CHECK_INTERVAL_MINUTES - remainder) % CHECK_INTERVAL_MINUTES
    if add == 0:
        add = CHECK_INTERVAL_MINUTES
    return (now + timedelta(minutes=add)).replace(second=0, microsecond=0)

def main():
    logger.info("✅ BESC Trending Bot starting up...")
    try:
        load_state()
    except Exception as e:
        logger.error(f"Failed to load state: {e}. Continuing with default state")
    
    # Test GeckoTerminal API at startup
    test_slug = NETWORK_SLUGS[0]
    test_url = f"{GECKO_BASE}/networks/{test_slug}/pools?sort=-volume_usd.h24&page[size]=5"
    test_data = fetch_with_retry(test_url, GECKO_HEADERS)
    if not test_data.get("data"):
        logger.warning(f"GeckoTerminal test fetch returned no data for {test_slug}. Check slug or API status.")
    else:
        logger.info(f"GeckoTerminal test fetch successful: {len(test_data['data'])} pools returned")
    
    next_trending = next_aligned(datetime.now(timezone.utc))
    logger.info(f"Next trending check at {next_trending.isoformat()} UTC")

    while True:
        try:
            now = datetime.now(timezone.utc)
            if now >= next_trending:
                logger.info(f"⏱ Checking trending at {now.isoformat()} UTC")
                for slug in NETWORK_SLUGS:
                    logger.info(f"Processing network: {slug}")
                    trend_list = fetch_trending(slug)
                    if trend_list:
                        # Send alerts for significant price changes
                        for _, p, _, _, _, pc_24h, _, _, _, _, _, pool_age in trend_list:
                            if abs(pc_24h) >= ALERT_THRESHOLD:
                                a = p.get("attributes", {})
                                h24_vol = safe_float((a.get("volume_usd") or {}).get("h24"))
                                link = a.get("url") or f"https://www.geckoterminal.com/{slug}/pools/{p.get('id')}"
                                send_alert(slug, p, pc_24h, h24_vol, link, pool_age)

                        # Post top 5 trending pools
                        last_mid = state.get("last_trending_id", {}).get(slug)
                        tg_delete(last_mid)
                        text = format_trending(slug, trend_list)
                        mid = tg_send(text)
                        if mid:
                            tg_pin(mid)
                            state.setdefault("last_trending_id", {})[slug] = mid
                            save_state()
                        else:
                            logger.error(f"Failed to send trending message for {slug}")
                    else:
                        logger.warning(f"No active pools found for {slug} in last 10 min")
                next_trending = next_aligned(now)
                logger.info(f"Next trending check at {next_trending.isoformat()} UTC")
            sleep_seconds = (next_trending - now).total_seconds()
            logger.debug(f"Sleeping for {sleep_seconds:.2f} seconds")
            time.sleep(max(sleep_seconds, 1))
        except Exception as e:
            logger.error(f"Main loop error: {e}. Retrying in 60 seconds")
            time.sleep(60)

if __name__ == "__main__":
    try:
        logger.info("Initializing bot...")
        main()
    except Exception as e:
        logger.critical(f"Bot crashed: {e}")
        raise
