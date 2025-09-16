import os
import time
import json
import requests
from datetime import datetime, timezone, timedelta
from typing import Optional, Tuple, List

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

def tg_delete(mid: Optional[int]):
    if mid:
        try:
            requests.post(f"{TG_API}/deleteMessage", data={"chat_id": CHAT_ID, "message_id": mid}, timeout=20)
        except:
            pass

def tg_unpin_all():
    try:
        requests.post(f"{TG_API}/unpinAllChatMessages", data={"chat_id": CHAT_ID}, timeout=20)
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
    if n >= 1_000_000: return f"${n/1_000_000:.2f}M"
    if n >= 1_000: return f"${n/1_000:.2f}K"
    return f"${n:.2f}"

def number_emoji(n: int) -> str:
    mapping = {1:"1️⃣",2:"2️⃣",3:"3️⃣",4:"4️⃣",5:"5️⃣"}
    return mapping.get(n, f"{n}.")

def extract_pair(pool, included):
    try:
        base_id = pool["relationships"]["base_token"]["data"]["id"]
        quote_id = pool["relationships"]["quote_token"]["data"]["id"]
        base_token = next((i for i in included if i["id"] == base_id), None)
        quote_token = next((i for i in included if i["id"] == quote_id), None)
        base_symbol = base_token["attributes"]["symbol"] if base_token else "?"
        quote_symbol = quote_token["attributes"]["symbol"] if quote_token else "?"
        return f"{base_symbol}/{quote_symbol}"
    except:
        return "Unknown/Pair"

# ---------- FETCH ----------
def fetch_trending(slug: str, duration="5m", size: int = 50) -> Tuple[List, List]:
    try:
        url = f"{GECKO_BASE}/networks/{slug}/trending_pools?duration={duration}&page[size]={size}&include=base_token,quote_token"
        r = requests.get(url, headers=GECKO_HEADERS, timeout=20)
        r.raise_for_status()
        data = r.json()
        return data.get("data", []), data.get("included", [])
    except Exception as e:
        print(f"⚠️ Failed to fetch pools ({duration}):", e)
        return [], []

# ---------- FORMAT ----------
def format_trending(slug, pools, included, top_n):
    if not pools:
        return "😴 <b>No trending pools right now</b>\n🕒 Chain is quiet — check back soon!"
    lines = [f"🔥 <b>{slug.upper()} — Top {top_n} Trending</b>", f"🕒 Snapshot: {datetime.now(timezone.utc).strftime('%H:%M UTC')}\n"]
    for i, p in enumerate(pools[:top_n], 1):
        a = p.get("attributes", {})
        name = extract_pair(p, included)
        vol = safe_float((a.get("volume_usd") or {}).get("h24"))
        liq = safe_float(a.get("reserve_in_usd"))
        lines.append(
            f"{number_emoji(i)} <b>{name}</b>\n"
            f"💵 24h Vol: {fmt_usd(vol)} | 💧 Liq: {fmt_usd(liq)}\n"
            f"<a href='https://www.geckoterminal.com/{slug}/pools/{p['id']}'>View Pool</a>\n"
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
            pools, included = fetch_trending(slug, "5m")
            if not pools:
                pools, included = fetch_trending(slug, "1h")
            if not pools:
                pools, included = fetch_trending(slug, "24h")

            tg_delete(state.get("last_trending_id"))
            tg_unpin_all()

            mid = tg_send(format_trending(slug, pools, included, TRENDING_SIZE))
            if mid:
                tg_pin(mid)
                state["last_trending_id"] = mid
                save_state()

            next_trending = next_aligned(now)
        time.sleep(5)

if __name__ == "__main__":
    print("✅ BESC Trending Bot starting up...")
    main()
