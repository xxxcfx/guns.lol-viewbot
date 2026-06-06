import os
import random
import time
import threading
from concurrent.futures import ThreadPoolExecutor
import requests

# ========== CONFIGURATION ==========
TARGET_USERNAME = "f7tv"
TARGET_URL = f"https://guns.lol/{TARGET_USERNAME}"
TOTAL_VIEWS = int(os.getenv("TOTAL_VIEWS", "500"))
WORKERS = int(os.getenv("WORKERS", "1"))
DELAY = float(os.getenv("DELAY", "5"))
RETRIES = int(os.getenv("RETRIES", "3"))

# Proxifly settings
PROXIFLY_API_KEY = os.getenv("PROXIFLY_API_KEY", "3wjHnRJ6pgxMDrwvpkykFSv3jRGNnSqh4VTbJ8kfSBZp")
PROXIFLY_API_URL = "https://api.proxifly.dev/v1/proxies"
PROXY_REFRESH_INTERVAL = int(os.getenv("PROXY_REFRESH_INTERVAL", "50"))

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

# ========== PROXY LOADING (Proxifly) ==========
def fetch_proxies():
    """Fetch proxy list from Proxifly API."""
    try:
        params = {
            "api_key": PROXIFLY_API_KEY,
            "limit": 100,          # Max proxies per request
            "protocol": "http",    # or "socks5" if needed
        }
        resp = requests.get(PROXIFLY_API_URL, params=params, timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            # Proxifly returns an array of objects: [{"ip":"...","port":...,"protocol":"http"}, ...]
            proxies = []
            for p in data:
                if "ip" in p and "port" in p:
                    protocol = p.get("protocol", "http")
                    proxy_str = f"{protocol}://{p['ip']}:{p['port']}"
                    proxies.append(proxy_str)
            return proxies
        else:
            print(f"[!] Proxifly API returned status {resp.status_code}: {resp.text[:100]}")
            return []
    except Exception as e:
        print(f"[!] Failed to fetch proxies from Proxifly: {e}")
        return []

def refresh_proxy_pool():
    global proxy_pool
    new_proxies = fetch_proxies()
    if new_proxies:
        proxy_pool = new_proxies
        print(f"[i] Proxifly pool refreshed: {len(proxy_pool)} proxies loaded")
    else:
        print("[!] Proxifly returned empty list. Keeping current pool.")
    random.shuffle(proxy_pool)

# ========== HELPER ==========
def extract_ip(proxy_str):
    if not proxy_str:
        return "direct"
    if "://" in proxy_str:
        ip_port = proxy_str.split("://")[1]
    else:
        ip_port = proxy_str
    if ":" in ip_port:
        ip = ip_port.split(":")[0]
    else:
        ip = ip_port
    return ip

# ========== SINGLE VIEW REQUEST ==========
def send_view():
    global proxy_pool
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

# ========== WORKER ==========
def worker_thread(worker_id):
    global successful_views, failed_views, request_counter
    while not stop_flag.is_set():
        with lock:
            if successful_views >= TOTAL_VIEWS:
                stop_flag.set()
                return
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
    print("🎯 guns.lol View Bot (Proxifly Residential Proxies)")
    print(f"   Target: {TARGET_URL}")
    print(f"   Goal: {TOTAL_VIEWS} views")
    print(f"   Delay: {DELAY}s between requests")
    print(f"   Proxifly API Key: {PROXIFLY_API_KEY[:8]}...")
    print("=" * 60)

    print("[i] Fetching initial proxy pool from Proxifly...")
    refresh_proxy_pool()
    if not proxy_pool:
        print("[!] Warning: No proxies loaded. Continuing without proxies.")

    with ThreadPoolExecutor(max_workers=WORKERS) as executor:
        futures = [executor.submit(worker_thread, i) for i in range(WORKERS)]
        stop_flag.wait()
        executor.shutdown(wait=False)

    print("\n" + "=" * 60)
    print("🏁 Finished!")
    print(f"   Successful views added: {successful_views}")
    print(f"   Failed attempts: {failed_views}")
    print("=" * 60)

if __name__ == "__main__":
    main()
