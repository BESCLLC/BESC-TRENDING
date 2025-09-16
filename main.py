import os
import time
import json
import requests
from datetime import datetime, timezone, timedelta
from typing import Optional

# ---------- CONFIG ----------
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
FORCED_SLUG = os.environ.get("NETWORK_SLUG", "besc-hyperchain").strip()
TRENDING_SIZE = int(os.environ.get("TRENDING_SIZE", "5"))
CHECK_MINUTES = 5

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
HEADERS = {"accept": "application/json; version=20230302"}

STATE_FILE = "state.json"
state = {"last_trending_id": None}

# ---------- STATE ----------
def load_state():
    global state
    try:
        with open(STATE_FILE, "r") as f:
            state = json.load(f)
    except:
        print("⚠️ No previous state found, starting fresh.")

def save_state():
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(state, f)
    except:
        print("⚠️ Could not save state.json")

# ---------- TELEGRAM ----------
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
        except Exception as e:
            print("⚠️ Could not delete message:", e)

def tg_unpin_all():
    try:
        requests.post(f"{TG_API}/unpinAllChatMessages", data={"chat_id": CHAT_ID}, timeout=20)
    except:
        pass

def tg_pin(mid: Optional[int]):
    if mid:
        try:
            requests.post(f"{TG_API}/pinChatMessage", data={"chat_id": CHAT_ID, "message_id": mid, "disable_notification": True}, timeout=20)
        except:
            pass

# ---------- HELPERS ----------
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

def fetch_pools(slug):
    try:
        url = f"{GECKO_BASE}/networks/{slug}/pools?page[size]=50"
        r = requests.get(url, headers=HEADERS, timeout=20)
        return r.json().get("data", [])
    except Exception as e:
        print("⚠️ Failed to fetch pools:", e)
        return []

def fetch_trades(slug, pool_id):
    try:
        url = f"{GECKO_BASE}/networks/{slug}/pools/{pool_id}/trades?page[size]=50"
        r = requests.get(url, headers=HEADERS, timeout=20)
        return r.json().get("data", [])
    except:
        return []

def fetch_trending(slug):
    pools = fetch_pools(slug)
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=15)
    scored = []

    for p in pools:
        attrs = p.get("attributes", {})
        h24_vol = safe_float((attrs.get("volume_usd") or {}).get("h24"))
        pool_id = p.get("id")
        trades = fetch_trades(slug, pool_id)
        recent = [t for t in trades if datetime.fromisoformat(t["attributes"]["block_timestamp"].replace("Z","+00:00")) >= cutoff]
        if not recent: continue

        short_vol = sum(safe_float(t["attributes"]["volume_in_usd"]) for t in recent)
        first_price = safe_float(recent[0]["attributes"]["price_to_in_usd"])
        last_price = safe_float(recent[-1]["attributes"]["price_to_in_usd"])
        price_change = ((last_price / first_price) - 1) * 100 if first_price > 0 else 0
        trade_count = len(recent)
        spike = short_vol / h24_vol if h24_vol > 0 else 1.0
        score = (short_vol * 0.5) + (abs(price_change) * 80) + (trade_count * 10) + (spike * 100)

        scored.append((score, p, short_vol, price_change, trade_count, spike))

    scored.sort(key=lambda x: x[0], reverse=True)
    return scored

def format_trending(slug, scored):
    if not scored:
        return "😴 <b>No trending pools right now</b>\n🕒 Check back in a few minutes!"
    lines = [f"🔥 <b>{slug.upper()} — Top {TRENDING_SIZE} Trending</b>", f"🕒 Last 15 min snapshot\n"]
    for i, (score, p, short_vol, pc, trades, spike) in enumerate(scored[:TRENDING_SIZE], 1):
        name = p.get("attributes", {}).get("name", "Unknown")
        link = f"https://www.geckoterminal.com/{slug}/pools/{p['id']}"
        pc_emoji = "📈" if pc >= 0 else "📉"
        lines.append(
            f"{number_emoji(i)} <b>{name}</b>\n"
            f"💵 Vol: {fmt_usd(short_vol)} | {pc_emoji} {pc:+.2f}%\n"
            f"🧮 Trades: {trades} | 🚀 Spike: {spike*100:.1f}%\n"
            f"<a href='{link}'>View Pool</a>\n"
        )
    return "\n".join(lines)

def next_aligned(now):
    total = int(now.timestamp() // 60)
    remainder = total % CHECK_MINUTES
    add = (CHECK_MINUTES - remainder) % CHECK_MINUTES
    if add == 0: add = CHECK_MINUTES
    return (now + timedelta(minutes=add)).replace(second=0, microsecond=0)

# ---------- MAIN ----------
def main():
    load_state()
    slug = FORCED_SLUG
    print("Using slug:", slug)
    next_check = next_aligned(datetime.now(timezone.utc))

    while True:
        now = datetime.now(timezone.utc)
        if now >= next_check:
            print(f"⏱ Checking trending at {now.isoformat()} UTC")
            scored = fetch_trending(slug)
            tg_unpin_all()  # make sure old pinned is gone
            tg_delete(state.get("last_trending_id"))
            mid = tg_send(format_trending(slug, scored))
            if mid:
                tg_pin(mid)
                state["last_trending_id"] = mid
                save_state()
            next_check = next_aligned(now)
        time.sleep(5)

if __name__ == "__main__":
    print("✅ BESC Trending Bot starting up...")
    main()
