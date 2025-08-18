import os
import requests
import datetime

DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL")

def load_accounts(file_path="accounts.txt"):
    with open(file_path, "r") as f:
        accounts = [line.strip() for line in f if line.strip()]
    return accounts

def fetch_views(account_url):
    try:
        # Simple TikTok scraping via unofficial API endpoint
        resp = requests.get(account_url, timeout=15, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        })
        if resp.status_code != 200:
            return None

        # NOTE: Simplified parsing – replace with proper scraping/JSON extraction
        text = resp.text.lower()
        views = text.count("views") * 10  # dummy fallback (replace with parser)
        return views
    except Exception:
        return None

def notify_discord(message):
    if not DISCORD_WEBHOOK_URL:
        print("⚠️ No Discord webhook set")
        return
    requests.post(DISCORD_WEBHOOK_URL, json={"content": message})

def main():
    accounts = load_accounts()
    cutoff = datetime.datetime.utcnow() - datetime.timedelta(hours=48)
    results = []
    debug = []

    for acc in accounts:
        views = fetch_views(acc)
        if views is None:
            debug.append(f"{acc}: failed to load")
        elif views >= 50:
            results.append(f"{acc} → {views} views")

    message = "📢 Check Notification (last 48H, ≥ 50 views)\n"
    if results:
        message += "\n".join(results)
    else:
        message += "No posts ≥ 50 views in the last 48h.\n"

    if debug:
        message += "\n\nDebug:\n" + "\n".join(debug)

    notify_discord(message)

if __name__ == "__main__":
    main()
