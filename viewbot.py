import os
import random
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests

# ----- Configuration -----
TARGET_URL = os.getenv("TARGET_URL", "https://guns.lol/f7tv")
THREADS = int(os.getenv("THREADS", "50"))          # Number of concurrent threads
REQUESTS_PER_THREAD = int(os.getenv("REQS_PER_THREAD", "100"))  # How many requests each thread sends
DELAY_BETWEEN_REQUESTS = float(os.getenv("DELAY", "0")) # Delay in seconds between requests (0 = no delay)
USE_PROXIES = os.getenv("USE_PROXIES", "false").lower() == "true"  # set to "true" to enable proxies
PROXY_LIST = os.getenv("PROXY_LIST", "").split(",")  # comma‑separated list: http://user:pass@ip:port

# ----- User Agent Rotation -----
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1",
    # Add more user agents if you like
]

# ----- Proxy handling -----
def get_random_proxy():
    if USE_PROXIES and PROXY_LIST:
        return random.choice(PROXY_LIST).strip()
    return None

# ----- View bot worker -----
def view_worker(thread_id):
    """Sends REQUESTS_PER_THREAD requests to the target URL."""
    for i in range(REQUESTS_PER_THREAD):
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
                print(f"[Thread-{thread_id}] Request #{i+1} OK")
            else:
                print(f"[Thread-{thread_id}] Request #{i+1} Status: {response.status_code}")

        except Exception as e:
            print(f"[Thread-{thread_id}] Request #{i+1} Error: {e}")

        if DELAY_BETWEEN_REQUESTS > 0:
            time.sleep(DELAY_BETWEEN_REQUESTS)

# ----- Main -----
def main():
    print(f"Starting view bot for {TARGET_URL}")
    print(f"Threads: {THREADS}, Requests per thread: {REQUESTS_PER_THREAD}")
    print(f"Proxies: {'Enabled' if USE_PROXIES else 'Disabled'}")

    with ThreadPoolExecutor(max_workers=THREADS) as executor:
        futures = [executor.submit(view_worker, t_id) for t_id in range(THREADS)]
        for future in as_completed(futures):
            future.result()  # catch exceptions

    print("All threads finished.")

if __name__ == "__main__":
    main()
