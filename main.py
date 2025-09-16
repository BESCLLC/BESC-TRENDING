import os
import time
import json
import requests
from datetime import datetime, timezone, timedelta
from typing import Optional

# --- CONFIG ---
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

# --- STATE HELPERS ---
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

# --- TELEGRAM HELPERS ---
def tg_send(text: str) -> Optional[int]:
    payload = {"chat_id": CHAT_ID, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
    try:
        r = requests.post(f"{TG_API}/sendMessage", data=payload, timeout=20)
        data = r.json()
        if not data.get("ok"):
            print("❌ Telegram sendMessage error:", data)
        return data.get("result", {}).get("message_id")
    except Exception as e:
        print("❌ Telegram sendMessage exception:", e)
        return None

def tg_delete(mid: Optional[int]):
    if mid:
        try:
            requests.post(f"{TG_API}/deleteMessage", data={"chat_id": CHAT_ID, "message_id": mid}, timeout=20)
        except:
            pass

def tg_pin(mid: Optional[int]):
    if not mid:
        return
    try:
        requests.post(f"{TG_API}/unpinAllChatMessages", data={"chat_id": CHAT_ID}, timeout=20)
        requests.post(f"{TG_API}/pinChatMessage", data={"chat_id": CHAT_ID, "message_id": mid, "disable_notification": True}, timeout=20)
    except:
        pass

# --- HELPERS ---
def safe_float(x, default=0.0):
    try:
        return float(str(x).replace(",", ""))
    except:
        return default

def fmt_usd(n: float) -> str:
    if n >= 1_000_000: return f"${n/1_000_000:.2f}M"
    if n >= 1_000: return f"${n/1_000:.2f}K"
    return f"${n:.2f}"

def number_emoji(n: int) -> str:
    mapping = {1:"1️⃣",2:"2️⃣",3:"3️⃣",4:"4️⃣",5:"5️⃣"}
    return mapping.get(n, f"{n}.")

def extract_pair(attr):
    t0 = attr.get("token0", {}).get("symbol","?")
    t1 = attr.get("token1", {}).get("symbol","?")
    return f"{t0}/{t1}"

# --- DATA FETCH ---
def fetch_trending(slug: str, size: int = 50):
    try:
        url = f"{GECKO_BASE}/networks/{slug}/pools?sort=-volume_usd.h24&page[size]={size}"
        r = requests.get(url, headers=GECKO_HEADERS, timeout=20)
        r.raise_for_status()
        pools = r.json().get("data", [])
    except Exception as e:
        print(f"⚠️ Failed to fetch pools: {e}")
        return []

    trend_list = []
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=10)

    for p in pools:
        attrs = p.get("attributes", {})
        h24_vol = safe_float((attrs.get("volume_usd") or {}).get("h24"))
        pool_id = p.get("id")

        # Get trades for last 10 min
        try:
            trades_url = f"{GECKO_BASE}/networks/{slug}/pools/{pool_id}/trades"
            t = requests.get(trades_url, headers=GECKO_HEADERS, timeout=15)
            trades = t.json().get("data", [])
        except:
            trades = []

        if not trades:
            continue

        recent_trades = [
            tr for tr in trades
            if datetime.fromisoformat(tr["attributes"]["timestamp"].replace("Z", "+00:00")) >= cutoff
        ]
        if not recent_trades:
            continue

        short_vol = sum(float(tr["attributes"]["trade_amount_usd"]) for tr in recent_trades)
        first_price = float(recent_trades[0]["attributes"]["price_usd"])
        last_price = float(recent_trades[-1]["attributes"]["price_usd"])
        price_change = ((last_price / first_price) - 1) * 100 if first_price > 0 else 0
        trade_count = len(recent_trades)
        spike_ratio = short_vol / h24_vol if h24_vol > 0 else 1.0

        score = (short_vol * 0.5) + (abs(price_change) * 100) + (trade_count * 20) + (spike_ratio * 200)
        trend_list.append((score, p, short_vol, price_change, trade_count, spike_ratio))

    trend_list.sort(key=lambda x: x[0], reverse=True)
    return trend_list

# --- FORMATTER ---
def format_trending(slug, trend_list, top_n):
    lines = [
        "🔥 <b>BESC Hyperchain — Live Trending</b>",
        f"🕒 Last 10 min activity • {datetime.now(timezone.utc).strftime('%H:%M UTC')}\n"
    ]
    for i, (score, p, short_vol, price_change, trade_count, spike_ratio) in enumerate(trend_list[:top_n], 1):
        a = p.get("attributes", {})
        name = extract_pair(a)
        link = a.get("url") or f"https://www.geckoterminal.com/{slug}/pools/{p.get('id')}"
        pc_emoji = "📈" if price_change >= 0 else "📉"
        lines.append(
            f"{number_emoji(i)} <b>{name}</b>\n"
            f"{pc_emoji} {price_change:+.2f}% | 💵 {fmt_usd(short_vol)} | 🧮 {trade_count} trades\n"
            f"🚀 Spike: {spike_ratio*100:.1f}% <a href='{link}'>View</a>\n"
        )
    lines.append("<a href='https://www.geckoterminal.com/besc-hyperchain/pools'>🔎 View All Pools</a>")
    return "\n".join(lines)

def next_aligned(now):
    total = int(now.timestamp() // 60)
    remainder = total % 5
    add = (5 - remainder) % 5
    if add == 0: add = 5
    return (now + timedelta(minutes=add)).replace(second=0, microsecond=0)

# --- MAIN LOOP ---
def main():
    load_state()
    slug = FORCED_SLUG or "besc-hyperchain"
    print("Using slug:", slug)

    next_trending = next_aligned(datetime.now(timezone.utc))

    while True:
        now = datetime.now(timezone.utc)
        if now >= next_trending:
            print(f"⏱ Checking trending at {now.isoformat()} UTC")
            trend_list = fetch_trending(slug)

            tg_delete(state.get("last_trending_id"))

            if trend_list:
                mid = tg_send(format_trending(slug, trend_list, TRENDING_SIZE))
            else:
                mid = tg_send("😴 <b>Nothing Trending detected yet — everyone’s asleep on-chain.</b>\n🕒 Check back in a few minutes!")

            if mid:
                tg_pin(mid)
                state["last_trending_id"] = mid
                save_state()

            next_trending = next_aligned(now)
        time.sleep(5)

if __name__ == "__main__":
    print("✅ BESC Trending Bot starting up...")
    main()
