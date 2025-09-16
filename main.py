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
GAINERS_SIZE = int(os.environ.get("GAINERS_SIZE", "5"))
OFFSET_MIN = int(os.environ.get("OFFSET_MIN", "2"))

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
state = {"last_trending_id": None, "last_gainers_id": None}

# ---------- UTIL ----------
def load_state():
    global state
    try:
        with open(STATE_FILE, "r") as f:
            state = json.load(f)
    except Exception as e:
        print("⚠️ Warning: Could not load state.json:", e)

def save_state():
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(state, f)
    except Exception as e:
        print("⚠️ Warning: Could not save state.json:", e)

def tg_call(method, data):
    try:
        r = requests.post(f"{TG_API}/{method}", data=data, timeout=20)
        return r.json()
    except Exception as e:
        print(f"⚠️ Telegram call failed: {method} → {e}")
        return {}

def tg_send(text: str) -> Optional[int]:
    r = tg_call("sendMessage", {"chat_id": CHAT_ID, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True})
    if not r.get("ok"):
        print("❌ Telegram sendMessage error:", r)
    return r.get("result", {}).get("message_id")

def tg_delete(mid: Optional[int]):
    if mid:
        tg_call("deleteMessage", {"chat_id": CHAT_ID, "message_id": mid})

def tg_pin(mid: Optional[int]):
    if not mid:
        return
    tg_call("unpinAllChatMessages", {"chat_id": CHAT_ID})
    tg_call("pinChatMessage", {"chat_id": CHAT_ID, "message_id": mid, "disable_notification": True})

def discover_slug() -> Optional[str]:
    try:
        r = requests.get(f"{GECKO_BASE}/networks", headers=GECKO_HEADERS, timeout=20)
        for item in r.json().get("data", []):
            name = (item.get("attributes", {}).get("name") or "").lower()
            nid = item.get("id")
            if "besc" in name:
                return nid
    except Exception as e:
        print("⚠️ Warning: Failed to fetch networks:", e)
    return None

def fetch_trending(slug: str, size: int = 50, duration: str = "5m"):
    try:
        url = f"{GECKO_BASE}/networks/{slug}/trending_pools?duration={duration}&page[size]={size}&include=base_token,quote_token"
        print(f"🌐 Fetching trending pools: {url}")
        r = requests.get(url, headers=GECKO_HEADERS, timeout=20)
        if r.status_code == 400:
            print(f"⚠️ trending_pools not supported → fallback to /pools sorted by volume")
            url = f"{GECKO_BASE}/networks/{slug}/pools?sort=-volume_usd.h24&page[size]={size}&include=base_token,quote_token"
            r = requests.get(url, headers=GECKO_HEADERS, timeout=20)
        r.raise_for_status()
        data = r.json()
        pools = data.get("data", [])
        print(f"📊 Gecko returned {len(pools)} pools")
        return pools
    except Exception as e:
        print("⚠️ Warning: Failed to fetch pools:", e)
        return []

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
    mapping = {1:"1️⃣",2:"2️⃣",3:"3️⃣",4:"4️⃣",5:"5️⃣",6:"6️⃣",7:"7️⃣",8:"8️⃣",9:"9️⃣",10:"🔟"}
    return mapping.get(n, f"{n}.")

def extract_pair(attr):
    t0 = attr.get("base_token", {}).get("data", {}).get("attributes", {}).get("symbol") or attr.get("token0", {}).get("symbol", "?")
    t1 = attr.get("quote_token", {}).get("data", {}).get("attributes", {}).get("symbol") or attr.get("token1", {}).get("symbol", "?")
    return f"{t0}/{t1}"

def extract_price_change(attr):
    pc = attr.get("price_change_percentage", {})
    return safe_float(pc.get("h24", 0)) if isinstance(pc, dict) else 0

# ---------- FORMATTERS ----------
def format_trending(slug, pools, top_n):
    if not pools:
        return "😴 <b>No trending pools detected</b>\n🕒 Chain is quiet right now. Check back soon!"
    title = "🔥 <b>Top 5 — BESC Trending</b>\n"
    lines = [title]
    for i, p in enumerate(pools[:top_n], 1):
        a = p.get("attributes", {})
        name = extract_pair(a)
        vol = safe_float((a.get("volume_usd") or {}).get("h24"))
        link = a.get("url") or f"https://www.geckoterminal.com/{slug}/pools/{p.get('id')}"
        lines.append(f"{number_emoji(i)} <b>{name}</b>\n💰 {fmt_usd(vol)} | <a href='{link}'>DexS</a>\n")
    return "\n".join(lines)

def next_aligned(now, offset):
    total = int(now.timestamp() // 60)
    remainder = (total - offset) % 5
    add = (5 - remainder) % 5
    if add == 0: add = 5
    return (now + timedelta(minutes=add)).replace(second=0, microsecond=0)

# ---------- MAIN LOOP ----------
def main():
    load_state()
    tg_call("unpinAllChatMessages", {"chat_id": CHAT_ID})  # always start fresh
    slug = FORCED_SLUG or discover_slug() or "besc-hyperchain"
    print("Using slug:", slug)

    now = datetime.now(timezone.utc)
    next_trending = next_aligned(now, 0)
    next_gainers = next_aligned(now, OFFSET_MIN)

    while True:
        now = datetime.now(timezone.utc)
        if now >= next_trending:
            pools = fetch_trending(slug)
            tg_delete(state.get("last_trending_id"))
            mid = tg_send(format_trending(slug, pools, TRENDING_SIZE))
            if mid:
                tg_pin(mid)
                state["last_trending_id"] = mid
                save_state()
            next_trending = next_aligned(now, 0)

        if now >= next_gainers:
            pools = fetch_trending(slug)
            tg_delete(state.get("last_gainers_id"))
            mid = tg_send(format_trending(slug, pools, GAINERS_SIZE))
            if mid:
                state["last_gainers_id"] = mid
                save_state()
            next_gainers = next_aligned(now, OFFSET_MIN)

        time.sleep(5)

if __name__ == "__main__":
    print("✅ BESC Trending Bot starting up...")
    main()
