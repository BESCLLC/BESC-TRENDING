
import os
import time
import json
import requests
from datetime import datetime, timezone, timedelta
from typing import Optional

# ---------- CONFIG ----------
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
FORCED_SLUG = os.environ.get("NETWORK_SLUG", "").strip()
TRENDING_SIZE = int(os.environ.get("TRENDING_SIZE", "5"))

print("🔎 Debug: Container launched.")
print("BOT_TOKEN present:", bool(BOT_TOKEN))
print("CHAT_ID value:", CHAT_ID)
print("FORCED_SLUG:", FORCED_SLUG)

if not BOT_TOKEN or not CHAT_ID:
    print("❌ ERROR: Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID")
    time.sleep(15)
    raise SystemExit("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID")

TG_API = f"https://api.telegram.org/bot{BOT_TOKEN}"
GECKO_BASE = "https://api.geckoterminal.com/api/v2"
GECKO_HEADERS = {"accept": "application/json; version=20230302"}

STATE_FILE = "state.json"
state = {"last_trending_id": None}

# ---------- UTIL ----------
def load_state():
    global state
    try:
        with open(STATE_FILE, "r") as f:
            state = json.load(f)
    except Exception as e:
        print("⚠️ Could not load state.json:", e)

def save_state():
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(state, f)
    except Exception as e:
        print("⚠️ Could not save state.json:", e)

def tg_send(text: str) -> Optional[int]:
    payload = {"chat_id": CHAT_ID, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
    try:
        r = requests.post(f"{TG_API}/sendMessage", data=payload, timeout=20)
        data = r.json()
        if not data.get("ok"):
            print("❌ Telegram sendMessage error:", data)
        return data["result"]["message_id"] if data.get("ok") else None
    except Exception as e:
        print("❌ Telegram sendMessage exception:", e)
        return None

def tg_delete_and_unpin(mid: Optional[int]):
    try:
        requests.post(f"{TG_API}/unpinAllChatMessages", data={"chat_id": CHAT_ID}, timeout=20)
    except:
        pass
    if mid:
        try:
            requests.post(f"{TG_API}/deleteMessage", data={"chat_id": CHAT_ID, "message_id": mid}, timeout=20)
        except:
            pass

def tg_pin(mid: Optional[int]):
    if not mid:
        return
    try:
        requests.post(f"{TG_API}/pinChatMessage", data={"chat_id": CHAT_ID, "message_id": mid, "disable_notification": True}, timeout=20)
    except:
        pass

def safe_float(x, default=0.0):
    try:
        return float(str(x).replace(",", ""))
    except:
        return default

def fmt_usd(n: float) -> str:
    if n >= 1_000_000:
        return f"${n/1_000_000:.2f}M"
    if n >= 1_000:
        return f"${n/1_000:.2f}K"
    return f"${n:.2f}"

def number_emoji(n: int) -> str:
    mapping = {1:"1️⃣",2:"2️⃣",3:"3️⃣",4:"4️⃣",5:"5️⃣"}
    return mapping.get(n, f"{n}.")

def extract_pair(attr):
    t0 = attr.get("token0", {}).get("symbol","?")
    t1 = attr.get("token1", {}).get("symbol","?")
    return f"{t0}/{t1}"

# ---------- TRENDING FETCH ----------
def fetch_trending(slug: str, size: int = 50, lookback_minutes: int = 10):
    try:
        url = f"{GECKO_BASE}/networks/{slug}/pools?sort=-volume_usd.h24&page[size]={size}"
        r = requests.get(url, headers=GECKO_HEADERS, timeout=20)
        r.raise_for_status()
        pools = r.json().get("data", [])
        trend_list = []
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=lookback_minutes)

        for p in pools:
            attrs = p.get("attributes", {})
            h24_vol = safe_float((attrs.get("volume_usd") or {}).get("h24"))
            pool_id = p.get("id")

            trades_url = f"{GECKO_BASE}/networks/{slug}/pools/{pool_id}/trades"
            t = requests.get(trades_url, headers=GECKO_HEADERS, timeout=20)
            trades = t.json().get("data", [])
            if not trades:
                continue

            recent_trades = [
                tr for tr in trades
                if datetime.fromisoformat(tr["attributes"]["block_timestamp"].replace("Z", "+00:00")) >= cutoff
            ]
            if not recent_trades:
                continue

            short_vol = sum(safe_float(tr["attributes"]["volume_in_usd"]) for tr in recent_trades)
            first_price = safe_float(recent_trades[0]["attributes"]["price_to_in_usd"])
            last_price = safe_float(recent_trades[-1]["attributes"]["price_to_in_usd"])
            price_change = ((last_price / first_price) - 1) * 100 if first_price > 0 else 0
            trade_count = len(recent_trades)
            spike_ratio = short_vol / h24_vol if h24_vol > 0 else 0.01

            score = (short_vol * 0.5) + (abs(price_change) * 100) + (trade_count * 20) + (spike_ratio * 200)
            trend_list.append((score, p, short_vol, price_change, trade_count, spike_ratio))

        trend_list.sort(key=lambda x: x[0], reverse=True)
        return trend_list
    except Exception as e:
        print("⚠️ Failed to fetch pools:", e)
        return []

# ---------- FORMAT ----------
def format_trending(slug, trend_list, top_n, lookback_minutes):
    lines = [f"🔥 <b>BESC Hyperchain — Trending ({lookback_minutes}m)</b>", "🕒 Snapshot of recent trades\n"]
    if not trend_list:
        lines.append("😴 <i>No trading activity in the last hour.</i>\n🕒 Liquidity is quiet — check back later!")
        return "\n".join(lines)

    for i, (score, p, short_vol, price_change, trade_count, spike_ratio) in enumerate(trend_list[:top_n], 1):
        a = p.get("attributes", {})
        name = extract_pair(a)
        link = a.get("url") or f"https://www.geckoterminal.com/{slug}/pools/{p.get('id')}"
        pc_emoji = "📈" if price_change >= 0 else "📉"
        lines.append(
            f"{number_emoji(i)} <b>{name}</b>\n"
            f"💵 Vol: {fmt_usd(short_vol)} | {pc_emoji} {price_change:+.2f}%\n"
            f"🧮 Trades: {trade_count} | 🚀 Spike: {spike_ratio*100:.1f}%\n"
            f"<a href='{link}'>View</a>\n"
        )
    lines.append(f"<a href='https://www.geckoterminal.com/{slug}/pools'>View All Pools</a>")
    return "\n".join(lines)

# ---------- MAIN LOOP ----------
def next_aligned(now):
    total = int(now.timestamp() // 60)
    remainder = total % 5
    add = (5 - remainder) % 5
    if add == 0: add = 5
    return (now + timedelta(minutes=add)).replace(second=0, microsecond=0)

def main():
    load_state()
    slug = FORCED_SLUG or "besc-hyperchain"
    print("Using slug:", slug)

    now = datetime.now(timezone.utc)
    next_trending = next_aligned(now)

    while True:
        now = datetime.now(timezone.utc)
        if now >= next_trending:
            print(f"⏱ Checking trending at {now.isoformat()} UTC")
            # Progressive fallback: 10m → 30m → 60m
            for lookback in [10, 30, 60]:
                trend_list = fetch_trending(slug, lookback_minutes=lookback)
                if trend_list:
                    break
            tg_delete_and_unpin(state.get("last_trending_id"))
            mid = tg_send(format_trending(slug, trend_list, TRENDING_SIZE, lookback))
            if mid:
                tg_pin(mid)
                state["last_trending_id"] = mid
                save_state()
            next_trending = next_aligned(now)
        time.sleep(5)

if __name__ == "__main__":
    print("✅ BESC Trending Bot starting up...")
    main()
