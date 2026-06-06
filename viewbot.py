import os
import random
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests

# ----- Configuration -----
TARGET_USERNAME = "f7tv"                     # guns.lol username
TARGET_URL = f"https://guns.lol/{TARGET_USERNAME}"
THREADS = int(os.getenv("THREADS", "10"))    # reduced to avoid instant 429
TOTAL_VIEWS = int(os.getenv("TOTAL_VIEWS", "1000"))   # total views to achieve
MAX_RETRIES = int(os.getenv("MAX_RETRIES", "5"))      # retries per request on 429
USE_PROXIES = os.getenv("USE_PROXIES", "false").lower() == "true"
PROXY_LIST = os.getenv("PROXY_LIST", "").split(",")

# ----- User Agent Rotation -----
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 Edg/91.0.864.59",
]

# ----- Global counters & locks -----
successful_views = 0
failed_views = 0
counter_lock = threading.Lock()
views_achieved = threading.Event()  # signal when total done

# ----- Proxy handling -----
def get_random_proxy():
    if USE_PROXIES and PROXY_LIST:
        return random.choice(PROXY_LIST).strip()
    return None

# ----- Single request with retries & backoff -----
def send_view_request():
    """Returns True if the request was successful (200), else False."""
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            headers = {
                "User-Agent": random.choice(USER_AGENTS),
                "Accept-Language": "en-US,en;q=0.9",
                "Referer": "https://guns.lol/",
                "Connection": "keep-alive",
            }
            proxy = get_random_proxy()
            proxies = {"http": proxy, "https": proxy} if proxy else None

            response = requests.get(TARGET_URL, headers=headers, proxies=proxies, timeout=10)

            if response.status_code == 200:
                return True   # success
            elif response.status_code == 429:
                # Rate limited – exponential backoff
                wait = min(2 ** attempt + random.uniform(0, 1), 30)   # max 30 sec
                time.sleep(wait)
                continue
            else:
                # Other errors – immediate failure
                return False
        except Exception as e:
            time.sleep(1)   # brief wait on exception
            continue
    return False

# ----- Worker thread -----
def view_worker(worker_id):
    global successful_views, failed_views
    while True:
        with counter_lock:
            if successful_views >= TOTAL_VIEWS:
                views_achieved.set()
                return
        # Send request
        success = send_view_request()
        with counter_lock:
            if success:
                successful_views += 1
                print(f"[Worker-{worker_id}] ✅ View #{successful_views} added (total: {successful_views}/{TOTAL_VIEWS})")
            else:
                failed_views += 1
                print(f"[Worker-{worker_id}] ❌ Request failed (total failed: {failed_views})")

        # Check if goal reached after update
        if successful_views >= TOTAL_VIEWS:
            views_achieved.set()
            return

        # Small delay between requests (avoids hammering)
        time.sleep(random.uniform(0.1, 0.5))

# ----- Main -----
def main():
    global successful_views, failed_views
    print("=" * 60)
    print(f"🎯 guns.lol View Bot")
    print(f"   Target: {TARGET_URL}")
    print(f"   Total views required: {TOTAL_VIEWS}")
    print(f"   Concurrent workers: {THREADS}")
    print(f"   Max retries per request: {MAX_RETRIES}")
    print(f"   Proxies: {'Enabled' if USE_PROXIES else 'Disabled'}")
    print("=" * 60)

    # Start workers
    with ThreadPoolExecutor(max_workers=THREADS) as executor:
        futures = [executor.submit(view_worker, i) for i in range(THREADS)]
        # Wait until views_achieved flag is set
        views_achieved.wait()
        # Shutdown all workers (they will exit after checking the flag)
        executor.shutdown(wait=False)

    print("\n" + "=" * 60)
    print(f"🎉 Finished!")
    print(f"   Successful views: {successful_views}")
    print(f"   Failed requests: {failed_views}")
    print("=" * 60)

if __name__ == "__main__":
    main()
