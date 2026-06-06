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

// ProxyScrape API (free, returns HTTP proxies in JSON)
const PROXY_API_URL = 'https://api.proxyscrape.com/v4/free-proxy-list/get' +
  '?request=display_proxies&proxy_format=ipport&format=json' +
  '&protocol=http' +
  '&country=af%2Cal%2Cdz%2Cad%2Cao%2Car%2Cam%2Cau%2Cat%2Caz%2Cbd%2Cby%2Cbe%2Cbj%2Cbm%2Cbt%2Cbo%2Cbw%2Cbg%2Cbf%2Cbi%2Ckh%2Ccm%2Cca%2Ctd%2Ccl%2Ccn%2Cco%2Ccg%2Ccr%2Chr%2Ccy%2Ccz%2Cdk%2Cdo%2Cec%2Ceg%2Csv%2Cgq%2Cee%2Csz%2Cet%2Cfj%2Cfi%2Cfr%2Cgm%2Cge%2Cde%2Cgh%2Cgi%2Cgr%2Cgu%2Cgt%2Cgn%2Cht%2Chn%2Chk%2Chu%2Cin%2Cid%2Cir%2Ciq%2Cie%2Cil%2Cit%2Cjm%2Cjp%2Cjo%2Ckz%2Cke%2Ckr%2Ckg%2Clv%2Clb%2Cls%2Clt%2Cmg%2Cmw%2Cmy%2Cmv%2Cml%2Cmt%2Cmu%2Cmx%2Cmd%2Cmn%2Cme%2Cma%2Cmz%2Cmm%2Cna%2Cnp%2Cnl%2Cnz%2Cni%2Cng%2Cmk%2Cno%2Cpk%2Cps%2Cpa%2Cpy%2Cpe%2Cph%2Cpl%2Cpt%2Cpr%2Cqa%2Cro%2Crw%2Ckn%2Csa%2Csn%2Crs%2Csc%2Csl%2Csg%2Csk%2Csi%2Cso%2Cza%2Ces%2Clk%2Csd%2Cse%2Cch%2Csy%2Ctw%2Ctj%2Ctz%2Cth%2Ctl%2Ctg%2Ctn%2Ctr%2Cug%2Cua%2Cae%2Cgb%2Cus%2Cuy%2Cuz%2Cve%2Cvn%2Cvi%2Cye%2Czw';

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

// ========== PROXY FETCHING ==========
async function fetchProxies() {
    try {
        const resp = await axios.get(PROXY_API_URL, { timeout: 20000 });
        // Response shape: { "proxies": ["ip:port", "ip:port", ...] }
        let data = resp.data;

        // Some API versions return an array directly
        let list = [];
        if (Array.isArray(data)) {
            list = data;
        } else if (data && Array.isArray(data.proxies)) {
            list = data.proxies;
        } else if (data && Array.isArray(data.data)) {
            list = data.data;
        } else {
            console.log('[!] Unexpected response shape from ProxyScrape');
            console.dir(data, { depth: 2 });
            return [];
        }

        // Each entry is "ip:port" → convert to "http://ip:port"
        const proxies = list
            .filter(entry => typeof entry === 'string' && entry.includes(':'))
            .map(entry => `http://${entry}`)
            .filter(Boolean);

        // Remove duplicates
        const unique = [...new Set(proxies)];

        if (unique.length > 0) {
            console.log(`[i] Fetched ${unique.length} HTTP proxies from ProxyScrape`);
            console.log(`   Example: ${unique[0]}`);
        } else {
            console.log('[!] ProxyScrape returned no valid proxies.');
        }

        return unique;
    } catch (err) {
        console.error('[!] ProxyScrape fetch error:', err?.message);
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
    // Shuffle
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

    // Build proxy agent
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
    console.log('🎯 guns.lol View Bot (Node.js + ProxyScrape Free Proxies)');
    console.log(`   Target: ${TARGET_URL}`);
    console.log(`   Goal: ${TOTAL_VIEWS} views`);
    console.log(`   Delay: ${DELAY_MS/1000}s`);
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
