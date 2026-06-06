const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const fs = require('fs');

// ========== CONFIG ==========
const TARGET_USERNAME = 'f7tv';
const TARGET_URL = `https://guns.lol/${TARGET_USERNAME}`;

const TOTAL_VIEWS = parseInt(process.env.TOTAL_VIEWS || '200');
const DELAY_MS = parseInt(process.env.DELAY_MS || '1000'); // 1 second between requests
const RETRIES = parseInt(process.env.RETRIES || '3');

const PROXY_FILE = 'http.txt';  // One proxy per line: ip:port

// ========== STATE ==========
let proxyPool = [];
let successfulViews = 0;
let failedViews = 0;
let stopFlag = false;

// ========== USER AGENTS ==========
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
];

// ========== LOAD PROXIES FROM FILE ==========
function loadProxiesFromFile() {
    try {
        const content = fs.readFileSync(PROXY_FILE, 'utf8');
        const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');

        const proxies = lines
            .map(line => line.trim())
            .filter(line => line.includes(':'))
            .map(line => `http://${line}`);  // ensure http:// prefix

        const unique = [...new Set(proxies)];

        console.log(`[i] Loaded ${unique.length} HTTP proxies from ${PROXY_FILE}`);
        if (unique.length > 0) {
            console.log(`   Example proxy: ${unique[0]}`);
        } else {
            console.log('[!] No valid proxies found in file.');
        }
        return unique;
    } catch (err) {
        console.error(`[!] Failed to read ${PROXY_FILE}: ${err.message}`);
        return [];
    }
}

// ========== INITIALISE POOL ==========
function refreshProxyPool() {
    proxyPool = loadProxiesFromFile();
    proxyPool.sort(() => Math.random() - 0.5);
}

// ========== EXTRACT IP ==========
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
    console.log('🎯 guns.lol View Bot (Local http.txt proxies, 1s delay)');
    console.log(`   Target: ${TARGET_URL}`);
    console.log(`   Goal: ${TOTAL_VIEWS} views`);
    console.log(`   Delay: ${DELAY_MS/1000}s`);
    console.log('='.repeat(60));

    console.log(`[i] Loading proxies from ${PROXY_FILE}...`);
    refreshProxyPool();
    if (proxyPool.length === 0) {
        console.log('[!] No proxies loaded. Exiting.');
        process.exit(1);
    }

    while (!stopFlag && successfulViews < TOTAL_VIEWS) {
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
