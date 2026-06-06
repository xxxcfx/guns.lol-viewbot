import os
import random
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests

# ========== CONFIGURATION ==========
TARGET_USERNAME = "f7tv"
TARGET_URL = f"https://guns.lol/{TARGET_USERNAME}"
TOTAL_VIEWS = int(os.getenv("TOTAL_VIEWS", "200"))       # How many views to add
WORKERS = int(os.getenv("WORKERS", "1"))                  # Keep 1 for sequential requests
DELAY = float(os.getenv("DELAY", "5"))                    # Seconds between requests
RETRIES = int(os.getenv("RETRIES", "3"))                  # Retry on error/429
PROXY_API = "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text"
PROXY_REFRESH_INTERVAL = int(os.getenv("PROXY_REFRESH_INTERVAL", "50"))  # Refresh proxies every N requests

# ========== GLOBALS ==========
proxy_pool = []
successful_views = 0
failed_views = 0
lock = threading.Lock()
stop_flag = threading.Event()
request_counter = 0

# ========== USER AGENTS ==========
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
]

# ========== PROXY LOADING ==========
def fetch_proxies():
    """Fetch proxy list from the API and return as list."""
    try:
        resp = requests.get(PROXY_API, timeout=15)
        if resp.status_code == 200:
            proxies = [line.strip() for line in resp.text.splitlines() if line.strip()]
            proxies = list(set(proxies))  # remove duplicates
            return proxies
        else:
            print(f"[!] Proxy API returned status {resp.status_code}")
            return []
    except Exception as e:
        print(f"[!] Failed to fetch proxies: {e}")
        return []

def refresh_proxy_pool():
    """Refresh global proxy_pool with fresh proxies."""
    global proxy_pool
    new_proxies = fetch_proxies()
    if new_proxies:
        proxy_pool = new_proxies
        print(f"[i] Proxy pool refreshed: {len(proxy_pool)} proxies loaded")
    else:
        print("[!] Proxy fetch returned empty list. Keeping current pool.")
    random.shuffle(proxy_pool)

# ========== HELPER: Extract IP from proxy string ==========
def extract_ip(proxy_str):
    """Extract IP from 'protocol://ip:port' or return 'direct'."""
    if not proxy_str:
        return "direct"
    # Remove protocol prefix
    if "://" in proxy_str:
        ip_port = proxy_str.split("://")[1]
    else:
        ip_port = proxy_str
    # Remove port
    if ":" in ip_port:
        ip = ip_port.split(":")[0]
    else:
        ip = ip_port
    return ip

# ========== SINGLE VIEW REQUEST ==========
def send_view():
    """Send one view request using a random proxy.
    Returns (success: bool, proxy_ip: str)"""
    global proxy_pool, request_counter

    proxy = None
    proxy_ip = "direct"
    if proxy_pool:
        proxy = random.choice(proxy_pool)
        proxy_ip = extract_ip(proxy)
    
    proxies = {"http": proxy, "https": proxy} if proxy else None

    headers = {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Referer": "https://guns.lol/",
        "DNT": "1",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
    }

    for attempt in range(RETRIES):
        try:
            resp = requests.get(TARGET_URL, headers=headers, proxies=proxies, timeout=15)
            if resp.status_code == 200:
                return (True, proxy_ip)
            elif resp.status_code == 429:
                wait = min(2 ** attempt + random.uniform(0, 1), 10)
                time.sleep(wait)
                continue
            else:
                return (False, proxy_ip)
        except Exception as e:
            time.sleep(1)
            continue
    return (False, proxy_ip)

# ========== WORKER LOOP ==========
def worker_thread(worker_id):
    global successful_views, failed_views, request_counter
    while not stop_flag.is_set():
        with lock:
            if successful_views >= TOTAL_VIEWS:
                stop_flag.set()
                return
        # Refresh proxy pool periodically
        with lock:
            request_counter += 1
            if request_counter % PROXY_REFRESH_INTERVAL == 0:
                refresh_proxy_pool()

        success, proxy_ip = send_view()
        with lock:
            if success:
                successful_views += 1
                print(f"[Worker {worker_id}] ✅ View #{successful_views} added | IP: {proxy_ip} | Next in {DELAY}s")
            else:
                failed_views += 1
                print(f"[Worker {worker_id}] ❌ Failed (total fails: {failed_views}) | IP: {proxy_ip} | Next in {DELAY}s")
        if successful_views >= TOTAL_VIEWS:
            stop_flag.set()
            return
        time.sleep(DELAY)

# ========== MAIN ==========
def main():
    global successful_views, failed_views
    print("=" * 60)
    print(f"🎯 guns.lol View Bot (Live IP logging)")
    print(f"   Target: {TARGET_URL}")
    print(f"   Goal: {TOTAL_VIEWS} views")
    print(f"   Delay: {DELAY}s between requests")
    print(f"   Proxy refresh every {PROXY_REFRESH_INTERVAL} requests")
    print(f"   Proxy API: {PROXY_API}")
    print("=" * 60)
    
    print("[i] Fetching initial proxy pool...")
    refresh_proxy_pool()

    if not proxy_pool:
        print("[!] Warning: No proxies found. Continuing without proxies.")
    
    with ThreadPoolExecutor(max_workers=WORKERS) as executor:
        futures = [executor.submit(worker_thread, i) for i in range(WORKERS)]
        stop_flag.wait()
        executor.shutdown(wait=False)
    
    print("\n" + "=" * 60)
    print(f"🏁 Finished!")
    print(f"   Successful views added: {successful_views}")
    print(f"   Failed attempts: {failed_views}")
    print("=" * 60)

if __name__ == "__main__":
    main()
