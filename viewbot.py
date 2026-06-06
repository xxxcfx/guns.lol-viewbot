const Proxifly = require('proxifly');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');

// ========== CONFIG ==========
const TARGET_USERNAME = 'f7tv';
const TARGET_URL = `https://guns.lol/${TARGET_USERNAME}`;

const TOTAL_VIEWS = parseInt(process.env.TOTAL_VIEWS || '200');
const DELAY_MS = parseInt(process.env.DELAY_MS || '5000'); // 5 seconds
const RETRIES = parseInt(process.env.RETRIES || '3');
const PROXY_REFRESH_INTERVAL = parseInt(process.env.PROXY_REFRESH_INTERVAL || '20');

const PROXIFLY_API_KEY = process.env.PROXIFLY_API_KEY || '3wjHnRJ6pgxMDrwvpkykFSv3jRGNnSqh4VTbJ8kfSBZp';

// ========== STATE ==========
let proxyPool = [];
let successfulViews = 0;
let failedViews = 0;
let requestCount = 0;
let stopFlag = false;

// ========== USER AGENTS ==========
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
];

// ========== PROXY FETCHING (using official Proxifly API) ==========
async function fetchProxies() {
    try {
        const proxifly = new Proxifly({ apiKey: PROXIFLY_API_KEY });
        const result = await proxifly.getProxy({
            protocol: 'http',            // Only HTTP (axios-compatible)
            https: true,
            quantity: 20,                // 20 proxies per batch
            format: 'json'               // Default, but explicit
        });

        // --- Handle response shape ---
        let proxies = [];

        if (Array.isArray(result)) {
            // Multiple proxies: array of proxy objects
            proxies = result.map(p => p.proxy); // e.g. "http://ip:port"
        } else if (result && result.proxy) {
            // Single proxy: object with .proxy string
            proxies = [result.proxy];
        } else if (result && Array.isArray(result.proxies)) {
            // Fallback: some versions return { proxies: [...] }
            proxies = result.proxies.map(p => p.proxy || `${p.protocol}://${p.ip}:${p.port}`);
        } else {
            console.log('[!] Unexpected response shape from Proxifly');
            console.dir(result, { depth: 3 });
            return [];
        }

        // Filter out non-HTTP proxies (just in case)
        proxies = proxies.filter(p => p.startsWith('http://') || p.startsWith('https://'));

        // Remove duplicates
        proxies = [...new Set(proxies)];

        if (proxies.length > 0) {
            console.log(`[i] Fetched ${proxies.length} HTTP proxies from Proxifly`);
            console.log(`   Example: ${proxies[0]}`);
        } else {
            console.log('[!] No usable HTTP proxies returned.');
        }

        return proxies;
    } catch (err) {
        console.error('[!] Proxifly fetch error:', err?.message);
        if (err?.response?.data) {
            console.error('   Response data:', err.response.data);
        }
        if (err?.message?.includes('out of daily requests')) {
            console.error('[✗] Proxifly daily quota exhausted.');
            process.exit(1);
        }
        return [];
    }
}

async function refreshProxyPool() {
    const newProxies = await fetchProxies();
    if (newProxies.length > 0) {
        proxyPool = newProxies;
        console.log(`[i] Proxy pool refreshed: ${proxyPool.length} proxies`);
    } else {
        console.log('[!] No proxies returned – keeping current pool.');
    }
    // Shuffle for randomness
    proxyPool.sort(() => Math.random() - 0.5);
}

// ========== EXTRACT IP FROM PROXY STRING ==========
function extractIp(proxyStr) {
    if (!proxyStr) return 'direct';
    const parts = proxyStr.split('://');
    const ipPort = parts[1] || parts[0];
    return ipPort.split(':')[0];
}

// ========== SINGLE VIEW REQUEST ==========
async function sendView() {
    const proxy = proxyPool.length > 0 ? proxyPool[Math.floor(Math.random() * proxyPool.length)] : null;
    const ip = extractIp(proxy);

    // Build proxy agent for axios
    let proxyAgent = null;
    if (proxy) {
        const proxyUrl = new URL(proxy);
        if (proxyUrl.protocol === 'http:') {
            proxyAgent = new HttpProxyAgent(proxy);
        } else if (proxyUrl.protocol === 'https:') {
            proxyAgent = new HttpsProxyAgent(proxy);
        }
    }

    const config = {
        headers: {
            'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Referer': 'https://guns.lol/',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
        },
        httpAgent: proxyAgent,
        httpsAgent: proxyAgent,
        timeout: 15000,
    };

    for (let attempt = 0; attempt < RETRIES; attempt++) {
        try {
            const resp = await axios.get(TARGET_URL, config);
            if (resp.status === 200) {
                return { success: true, ip };
            } else if (resp.status === 429) {
                const wait = Math.min(Math.pow(2, attempt) + Math.random(), 10) * 1000;
                console.log(`   ⏳ 429 rate limit – waiting ${wait/1000}s`);
                await sleep(wait);
                continue;
            } else {
                return { success: false, ip, status: resp.status };
            }
        } catch (err) {
            await sleep(1000);
        }
    }
    return { success: false, ip, status: 'error' };
}

// ========== SLEEP ==========
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== MAIN LOOP ==========
async function main() {
    console.log('='.repeat(60));
    console.log('🎯 guns.lol View Bot (Node.js + Proxifly v3.0.1)');
    console.log(`   Target: ${TARGET_URL}`);
    console.log(`   Goal: ${TOTAL_VIEWS} views`);
    console.log(`   Delay: ${DELAY_MS/1000}s`);
    console.log(`   Proxifly API Key: ${PROXIFLY_API_KEY.slice(0, 8)}...`);
    console.log('='.repeat(60));

    console.log('[i] Fetching initial proxy pool...');
    await refreshProxyPool();
    if (proxyPool.length === 0) {
        console.log('[!] Warning: No proxies loaded. Continuing without proxies (likely blocked).');
    }

    while (!stopFlag && successfulViews < TOTAL_VIEWS) {
        requestCount++;
        if (requestCount % PROXY_REFRESH_INTERVAL === 0) {
            console.log('[i] Refreshing proxy pool...');
            await refreshProxyPool();
        }

        const { success, ip, status } = await sendView();
        if (success) {
            successfulViews++;
            console.log(`✅ View #${successfulViews} added | IP: ${ip} | Next in ${DELAY_MS/1000}s`);
        } else {
            failedViews++;
            console.log(`❌ Failed (total fails: ${failedViews}) | IP: ${ip} | Status: ${status || 'unknown'} | Next in ${DELAY_MS/1000}s`);
        }

        if (successfulViews >= TOTAL_VIEWS) {
            break;
        }
        await sleep(DELAY_MS);
    }

    console.log('\n' + '='.repeat(60));
    console.log('🏁 Finished!');
    console.log(`   Successful views added: ${successfulViews}`);
    console.log(`   Failed attempts: ${failedViews}`);
    console.log('='.repeat(60));
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
