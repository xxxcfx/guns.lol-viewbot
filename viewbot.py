import os
import random
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests

# ========== CONFIGURATION ==========
TARGET_USERNAME = "f7tv"
TARGET_URL = f"https://guns.lol/{TARGET_USERNAME}"
TOTAL_VIEWS = int(os.getenv("TOTAL_VIEWS", "500"))        # How many views to add
WORKERS = int(os.getenv("WORKERS", "1"))                  # One worker = sequential requests with 5s delay
DELAY_SECONDS = float(os.getenv("DELAY", "5"))            # 5 seconds between requests
PROXY_LIST_ENV = os.getenv("PROXY_LIST", "")              # Comma‑separated proxies (e.g., http://user:pass@ip:port,http://...)
PROXY_API_URL = os.getenv("PROXY_API_URL", "")            # Optional: URL that returns a list of proxies (one per line)
RETRIES = int(os.getenv("RETRIES", "3"))                  # Retries on 429/error

# ========== GLOBALS ==========
successful_views = 0
failed_views = 0
lock = threading.Lock()
stop_flag = threading.Event()

# ========== PROXY LOADING ==========
proxy_pool = []

def load_proxies():
    """Load proxies from environment variable or API URL"""
    global proxy_pool
    if PROXY_LIST_ENV:
        proxy_pool = [p.strip() for p in PROXY_LIST_ENV.split(",") if p.strip()]
        print(f"[+] Loaded {len(proxy_pool)} proxies from PROXY_LIST")
    elif PROXY_API_URL:
        try:
            resp = requests.get(PROXY_API_URL, timeout=10)
            proxy_pool = [line.strip() for line in resp.text.splitlines() if line.strip()]
            print(f"[+] Loaded {len(proxy_pool)} proxies from API")
        except Exception as e:
            print(f"[!] Failed to fetch proxies from API: {e}")
    else:
        print("[!] No proxies provided. Each request will use the same IP – likely blocked.")
    random.shuffle(proxy_pool)

# ========== USER AGENTS ==========
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
]

# ========== SINGLE VIEW REQUEST ==========
def send_view():
    """Try to send one view request using a random proxy."""
    global proxy_pool
    headers = {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Referer": "https://guns.lol/",
        "DNT": "1",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
    }
    # Pick a proxy
    proxy = None
    if proxy_pool:
        proxy = random.choice(proxy_pool)
    proxies = {"http": proxy, "https": proxy} if proxy else None

    for attempt in range(RETRIES):
        try:
            resp = requests.get(TARGET_URL, headers=headers, proxies=proxies, timeout=15)
            if resp.status_code == 200:
                return True
            elif resp.status_code == 429:
                # rate limited – backoff
                time.sleep(2 ** attempt)
                continue
            else:
                # other status (403, 5xx)
                return False
        except Exception as e:
            time.sleep(1)
            continue
    return False

# ========== WORKER LOOP ==========
def worker_thread(worker_id):
    global successful_views, failed_views
    while not stop_flag.is_set():
        with lock:
            if successful_views >= TOTAL_VIEWS:
                stop_flag.set()
                return
        # Send one view
        success = send_view()
        with lock:
            if success:
                successful_views += 1
                print(f"[Worker {worker_id}] ✅ View #{successful_views} added | IP rotated | Next in {DELAY_SECONDS}s")
            else:
                failed_views += 1
                print(f"[Worker {worker_id}] ❌ Failed (total fails: {failed_views}) | Next in {DELAY_SECONDS}s")
        # Check if we reached goal
        if successful_views >= TOTAL_VIEWS:
            stop_flag.set()
            return
        # Wait the delay
        time.sleep(DELAY_SECONDS)

# ========== MAIN ==========
def main():
    global successful_views, failed_views
    print("=" * 60)
    print(f"🎯 guns.lol View Bot (Fixed Method)")
    print(f"   Target: {TARGET_URL}")
    print(f"   Goal: {TOTAL_VIEWS} views")
    print(f"   Delay: {DELAY_SECONDS}s between requests")
    print(f"   Workers: {WORKERS}")
    load_proxies()
    print("=" * 60)

    with ThreadPoolExecutor(max_workers=WORKERS) as executor:
        futures = [executor.submit(worker_thread, i) for i in range(WORKERS)]
        # Wait until stop_flag set
        stop_flag.wait()
        executor.shutdown(wait=False)

    print("\n" + "=" * 60)
    print(f"🏁 Finished!")
    print(f"   Successful views added: {successful_views}")
    print(f"   Failed attempts: {failed_views}")
    print("=" * 60)

if __name__ == "__main__":
    main()
