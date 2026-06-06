const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ========== CONFIG ==========
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'YOUR_BOT_TOKEN';
const ALLOWED_CHANNEL_ID = '1512808669522165832';
const LOG_CHANNEL_ID = '1512806516145520670';
const MAX_VIEWS_PER_USER_PER_DAY = 50;
const SPECIAL_USER_ID = '1350293413915918367'; // unlimited user
const PROXY_FILE = 'http.txt';
const THUMBNAIL_URL = 'https://cdn.discordapp.com/attachments/1502245820114669579/1512809050394464397/download_2.jpg?ex=6a2570b8&is=6a241f38&hm=cd678daa95c326ff11313e17167ee91d5caeafbf1329e1fce1d0da954c3d9f14&';
const BROWSER_TIMEOUT = 30000;
const NAVIGATION_TIMEOUT = 15000;
const PROXY_TEST_TIMEOUT = 5000;

// ========== STATE ==========
let proxyPool = [];
let workingProxies = [];
let dailyViews = {};
const TODAY = () => new Date().toISOString().slice(0, 10);
const DATA_FILE = path.join(__dirname, 'dailyViews.json');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function loadDailyViews() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            dailyViews = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            console.log(`[i] Loaded daily views data (${Object.keys(dailyViews).length} entries)`);
        } else {
            console.log('[i] No daily views file found, starting fresh');
        }
    } catch (e) {
        console.error(`[!] Failed to load daily views: ${e.message}`);
    }
}
function saveDailyViews() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(dailyViews, null, 2));
        console.log(`[i] Saved daily views data`);
    } catch (e) {
        console.error(`[!] Failed to save daily views: ${e.message}`);
    }
}

function loadProxiesFromFile() {
    try {
        const content = fs.readFileSync(PROXY_FILE, 'utf8');
        const lines = content.split(/\r?\n/).filter(l => l.trim());
        const proxies = lines.map(l => l.trim()).filter(l => l.includes(':')).map(l => `http://${l}`);
        const unique = [...new Set(proxies)];
        console.log(`[✓] Loaded ${unique.length} unique proxies from ${PROXY_FILE}`);
        return unique;
    } catch (err) {
        console.error(`[!] Failed to read ${PROXY_FILE}: ${err.message}`);
        return [];
    }
}

// ========== PROXY TESTING ==========
async function testProxy(proxyUrl) {
    try {
        const parsed = new URL(proxyUrl);
        const response = await axios.get('http://httpbin.org/ip', {
            proxy: {
                host: parsed.hostname,
                port: Number(parsed.port),
                protocol: 'http'
            },
            timeout: PROXY_TEST_TIMEOUT
        });
        return response.status === 200 && response.data && response.data.origin;
    } catch { return false; }
}

async function filterWorkingProxies() {
    console.log(`[PROXY] Testing ${proxyPool.length} proxies...`);
    const results = await Promise.allSettled(proxyPool.map(proxy => testProxy(proxy)));
    workingProxies = [];
    for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'fulfilled' && results[i].value === true) {
            workingProxies.push(proxyPool[i]);
        }
    }
    console.log(`[PROXY] After filtering: ${workingProxies.length} working proxies remaining`);
}

// ========== REAL VIEW WITH PUPPETEER ==========
async function sendRealView(targetUrl, onLog, forceDirect = false) {
    const useProxy = !forceDirect && workingProxies.length > 0;
    const proxy = useProxy ? workingProxies[Math.floor(Math.random() * workingProxies.length)] : null;
    const ip = proxy ? proxy.split('://')[1].split(':')[0] : 'direct';

    console.log(`[VIEW] Starting view for ${targetUrl} ${proxy ? `via proxy ${ip}` : 'directly'}`);

    let browser = null;
    try {
        const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--window-size=1280,720',
        ];
        if (proxy) args.push(`--proxy-server=${proxy}`);

        console.log(`[VIEW] Launching Puppeteer browser...`);
        browser = await puppeteer.launch({
            headless: true,
            args,
            timeout: BROWSER_TIMEOUT,
        });
        console.log(`[VIEW] Browser launched successfully`);

        const page = await browser.newPage();
        const userAgent = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        ][Math.floor(Math.random() * 3)];
        await page.setUserAgent(userAgent);
        await page.setViewport({ width: 1280, height: 720 });
        console.log(`[VIEW] Page setup done, user-agent: ${userAgent.slice(0, 50)}...`);

        // Step 1: Navigate
        console.log(`[VIEW] Navigating to ${targetUrl}...`);
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: NAVIGATION_TIMEOUT });
        console.log(`[VIEW] Page loaded successfully`);
        const log1 = {
            proxy: proxy || 'none', ip, status: 'loaded', success: true,
            timestamp: new Date().toISOString(), type: 'load',
        };
        if (onLog) onLog(log1);

        // Wait 3 seconds AFTER page fully loaded
        console.log(`[VIEW] Waiting 3 seconds before click (page fully loaded)...`);
        await sleep(3000);

        // Step 2: Click centre
        const viewport = page.viewport();
        const centerX = viewport.width / 2;
        const centerY = viewport.height / 2;
        console.log(`[VIEW] Clicking centre of screen (${centerX}, ${centerY})`);
        await page.mouse.click(centerX, centerY);
        console.log(`[VIEW] Click executed`);

        const log2 = {
            proxy: proxy || 'none', ip, status: 'clicked', success: true,
            timestamp: new Date().toISOString(), type: 'click',
        };
        if (onLog) onLog(log2);

        // Wait 2 seconds after click
        console.log(`[VIEW] Waiting 2 seconds after click...`);
        await sleep(2000);

        await browser.close();
        console.log(`[VIEW] Browser closed, view completed successfully`);
        return { success: true, ip, proxy, status: 200 };
    } catch (err) {
        console.error(`[VIEW] Puppeteer error: ${err.message}`);
        if (browser) {
            await browser.close().catch(() => {});
            console.log(`[VIEW] Browser closed after error`);
        }
        const logErr = {
            proxy: proxy || 'none', ip, status: 'error', success: false,
            timestamp: new Date().toISOString(), type: 'error',
        };
        if (onLog) onLog(logErr);
        return { success: false, ip, proxy, status: 'error' };
    }
}

// ========== FALLBACK: try proxy first, then direct ==========
async function sendViewWithFallback(targetUrl, onLog) {
    if (workingProxies.length > 0) {
        console.log(`[FALLBACK] Attempting with working proxy...`);
        const result = await sendRealView(targetUrl, onLog, false);
        if (result.success) {
            console.log(`[FALLBACK] Proxy attempt succeeded`);
            return result;
        }
        console.log(`[FALLBACK] Proxy failed, trying direct connection...`);
    } else {
        console.log(`[FALLBACK] No working proxies, using direct connection`);
    }
    const result = await sendRealView(targetUrl, onLog, true);
    console.log(`[FALLBACK] Direct attempt result: ${result.success ? 'success' : 'failed'}`);
    return result;
}

// ========== DISCORD BOT ==========
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once('ready', async () => {
    console.log(`[✓] Logged in as ${client.user.tag}`);
    loadDailyViews();
    proxyPool = loadProxiesFromFile();
    if (proxyPool.length > 0) {
        await filterWorkingProxies();
    } else {
        console.warn('[!] No proxies loaded – will use direct connection only.');
    }
    console.log('[READY] Bot is fully initialized');
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    console.log(`[COMMAND] ${interaction.commandName} used by ${interaction.user.tag}`);

    if (interaction.channelId !== ALLOWED_CHANNEL_ID) {
        return interaction.reply({
            content: `❌ Commands can only be used in <#${ALLOWED_CHANNEL_ID}>.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    const commandName = interaction.commandName;
    const requester = interaction.user;
    const isSpecial = requester.id === SPECIAL_USER_ID;

    // ========== /views ==========
    if (commandName === 'views') {
        await interaction.deferReply();

        const targetUser = interaction.options.getString('user');
        const amount = interaction.options.getInteger('amount');
        const today = TODAY();
        const key = `${requester.id}_${today}`;
        const usedToday = dailyViews[key] || 0;
        const allowed = isSpecial ? amount : Math.min(amount, MAX_VIEWS_PER_USER_PER_DAY - usedToday);

        console.log(`[VIEWS] Target: ${targetUser}, Amount requested: ${amount}, Special: ${isSpecial}, Used today: ${usedToday}, Allowed: ${allowed}`);

        if (!isSpecial && usedToday >= MAX_VIEWS_PER_USER_PER_DAY) {
            console.log(`[VIEWS] User ${requester.tag} has no daily views left`);
            return interaction.editReply(`❌ You've used all ${MAX_VIEWS_PER_USER_PER_DAY} daily views. Try again tomorrow.`);
        }
        const viewsToDo = allowed > 0 ? Math.min(amount, allowed) : (isSpecial ? amount : 0);
        if (viewsToDo <= 0) {
            return interaction.editReply(`❌ No views to send (amount must be >0).`);
        }
        const targetUrl = `https://guns.lol/${targetUser}`;
        const logChannel = client.channels.cache.get(LOG_CHANNEL_ID);
        if (!logChannel) {
            console.error(`[FATAL] Log channel ${LOG_CHANNEL_ID} not found`);
            return interaction.editReply('❌ Log channel not found. Contact admin.');
        }

        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('🎯 guns.lol View Bot – Running')
            .setThumbnail(THUMBNAIL_URL)
            .addFields(
                { name: '👤 Target', value: `[${targetUser}](${targetUrl})`, inline: true },
                { name: '👥 Ran by', value: `${requester.tag} (${requester.id})`, inline: true },
                { name: '📊 Progress', value: `0/${viewsToDo}`, inline: false },
                { name: '✅ Successful', value: '0', inline: true },
                { name: '❌ Failed', value: '0', inline: true },
                { name: '⏱️ Status', value: '🎬 Starting...', inline: false },
            )
            .setFooter({ text: isSpecial ? '♾️ Unlimited user' : `Daily limit: ${MAX_VIEWS_PER_USER_PER_DAY} views/user` })
            .setTimestamp();

        const reply = await interaction.editReply({ embeds: [embed] });
        console.log(`[VIEWS] Initial embed sent, starting ${viewsToDo} views`);

        try {
            const headerEmbed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('🚀 View Bot – Started')
                .setDescription(`**Requested by:** ${requester.tag}\n**Target:** ${targetUrl}\n**Amount:** ${viewsToDo}\n**Working proxies:** ${workingProxies.length}/${proxyPool.length}\n**Special user:** ${isSpecial ? '✅' : '❌'}\n**Method:** Puppeteer (real browser, real click, filtered proxies)`)
                .setThumbnail(THUMBNAIL_URL)
                .setTimestamp();
            await logChannel.send({ embeds: [headerEmbed] });
            console.log(`[VIEWS] Header log sent`);
        } catch (e) {
            console.error(`[VIEWS] Failed to send header log: ${e.message}`);
        }

        let successful = 0;
        let failed = 0;
        let logBatches = [];

        try {
            for (let i = 0; i < viewsToDo; i++) {
                console.log(`[VIEWS] Starting view #${i + 1}/${viewsToDo}`);
                const result = await sendViewWithFallback(targetUrl, (logEntry) => {
                    const line = `\`${logEntry.timestamp}\` | **IP:** ${logEntry.ip} | **Type:** ${logEntry.type} | **Status:** ${logEntry.status} | **Success:** ${logEntry.success ? '✅' : '❌'}`;
                    logBatches.push(line);
                });

                if (result.success) {
                    successful++;
                    console.log(`[VIEWS] View #${i + 1} SUCCESS (IP: ${result.ip})`);
                } else {
                    failed++;
                    console.warn(`[VIEWS] View #${i + 1} FAILED (IP: ${result.ip})`);
                }

                // Track daily views only for non-special users
                if (!isSpecial) {
                    dailyViews[key] = (dailyViews[key] || 0) + 1;
                    saveDailyViews();
                }

                const statusText = result.success
                    ? `✅ View #${i + 1} complete (clicked centre)`
                    : `❌ View #${i + 1} failed`;

                try {
                    const updatedEmbed = EmbedBuilder.from(embed)
                        .setFields(
                            { name: '👤 Target', value: `[${targetUser}](${targetUrl})`, inline: true },
                            { name: '👥 Ran by', value: `${requester.tag} (${requester.id})`, inline: true },
                            { name: '📊 Progress', value: `${i + 1}/${viewsToDo}`, inline: false },
                            { name: '✅ Successful', value: `${successful}`, inline: true },
                            { name: '❌ Failed', value: `${failed}`, inline: true },
                            { name: '⏱️ Status', value: statusText, inline: false },
                        );
                    await reply.edit({ embeds: [updatedEmbed] });
                } catch (e) {
                    console.error(`[VIEWS] Failed to update embed: ${e.message}`);
                }

                if (logBatches.length >= 10) {
                    try {
                        const batch = logBatches.join('\n');
                        const logEmbed = new EmbedBuilder()
                            .setColor(0x3498DB)
                            .setDescription(batch.slice(0, 4000))
                            .setTimestamp();
                        await logChannel.send({ embeds: [logEmbed] });
                        console.log(`[VIEWS] Sent batch of ${logBatches.length} logs`);
                    } catch (e) {
                        console.error(`[VIEWS] Failed to send batch logs: ${e.message}`);
                    }
                    logBatches = [];
                }
            }
        } catch (e) {
            console.error(`[FATAL] Loop error: ${e.message}`);
            try { await reply.edit({ content: `❌ Fatal error: ${e.message}` }); } catch (_) {}
        }

        // Send remaining logs
        if (logBatches.length > 0) {
            try {
                const batch = logBatches.join('\n');
                const logEmbed = new EmbedBuilder()
                    .setColor(0x3498DB)
                    .setDescription(batch.slice(0, 4000))
                    .setTimestamp();
                await logChannel.send({ embeds: [logEmbed] });
                console.log(`[VIEWS] Sent final batch of ${logBatches.length} logs`);
            } catch (e) {
                console.error(`[VIEWS] Failed to send final logs: ${e.message}`);
            }
        }

        // Summary log - show user usage only for non-special
        let todayUsed = isSpecial ? '♾️ Unlimited' : `${dailyViews[key]}/${MAX_VIEWS_PER_USER_PER_DAY}`;
        try {
            const summaryEmbed = new EmbedBuilder()
                .setColor(successful > 0 ? 0x00FF00 : 0xFF0000)
                .setTitle('🏁 View Bot – Finished')
                .setThumbnail(THUMBNAIL_URL)
                .addFields(
                    { name: '✅ Successful', value: `${successful}`, inline: true },
                    { name: '❌ Failed', value: `${failed}`, inline: true },
                    { name: 'User Today', value: todayUsed, inline: true },
                    { name: 'Requested by', value: requester.tag, inline: false },
                )
                .setTimestamp();
            await logChannel.send({ embeds: [summaryEmbed] });
            console.log(`[VIEWS] Summary log sent`);
        } catch (e) {
            console.error(`[VIEWS] Failed to send summary log: ${e.message}`);
        }

        // Final public embed
        try {
            const finalEmbed = EmbedBuilder.from(embed)
                .setColor(successful > 0 ? 0x00FF00 : 0xFF0000)
                .setTitle('🏁 View Bot – Completed')
                .setFields(
                    { name: '👤 Target', value: `[${targetUser}](${targetUrl})`, inline: true },
                    { name: '👥 Ran by', value: `${requester.tag} (${requester.id})`, inline: true },
                    { name: '📊 Progress', value: `${successful}/${viewsToDo}`, inline: false },
                    { name: '✅ Successful', value: `${successful}`, inline: true },
                    { name: '❌ Failed', value: `${failed}`, inline: true },
                    { name: '⏱️ Status', value: '✅ Finished!', inline: false },
                );
            await reply.edit({ embeds: [finalEmbed] });
            console.log(`[VIEWS] Final public embed updated`);
        } catch (e) {
            console.error(`[VIEWS] Failed to update final embed: ${e.message}`);
        }
        console.log(`[VIEWS] Completed: ${successful} success, ${failed} failed`);
    }

    // ========== Other commands ==========
    else if (commandName === 'status') {
        const today = TODAY();
        const key = `${requester.id}_${today}`;
        const used = dailyViews[key] || 0;
        const remaining = isSpecial ? '♾️ Unlimited' : MAX_VIEWS_PER_USER_PER_DAY - used;
        console.log(`[STATUS] ${requester.tag} - Used: ${used}, Remaining: ${remaining}`);
        const embed = new EmbedBuilder()
            .setColor(0x3498DB)
            .setTitle('📊 Your Daily View Usage')
            .setThumbnail(THUMBNAIL_URL)
            .addFields(
                { name: 'Used Today', value: `${isSpecial ? '♾️' : used}`, inline: true },
                { name: 'Remaining', value: `${remaining}`, inline: true },
                { name: 'Daily Limit', value: isSpecial ? '♾️ Unlimited' : `${MAX_VIEWS_PER_USER_PER_DAY}`, inline: true }
            )
            .setTimestamp();
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    else if (commandName === 'proxycount') {
        const count = workingProxies.length;
        const total = proxyPool.length;
        console.log(`[PROXYCOUNT] Working: ${count}/${total}`);
        const embed = new EmbedBuilder()
            .setColor(0x9B59B6)
            .setTitle('🌐 Proxy Pool Info')
            .setThumbnail(THUMBNAIL_URL)
            .addFields(
                { name: 'Working Proxies', value: `${count}`, inline: true },
                { name: 'Total Loaded', value: `${total}`, inline: true },
                { name: 'Source File', value: PROXY_FILE, inline: false }
            )
            .setTimestamp();
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    else if (commandName === 'help') {
        console.log(`[HELP] Displayed help menu to ${requester.tag}`);
        const embed = new EmbedBuilder()
            .setColor(0x2ECC71)
            .setTitle('📚 Available Commands')
            .setThumbnail(THUMBNAIL_URL)
            .addFields(
                { name: '/views', value: 'Start view bot for a user.\n  `user` – username\n  `amount` – views (max 50/day, unlimited for special user)', inline: false },
                { name: '/status', value: 'Check your remaining daily views.', inline: false },
                { name: '/proxycount', value: 'Show working/total proxies.', inline: false },
                { name: '/reset', value: '(Admin) Reset daily counts.', inline: false },
                { name: '/help', value: 'Show this message.', inline: false }
            )
            .setTimestamp();
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    else if (commandName === 'reset') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator) && requester.id !== SPECIAL_USER_ID) {
            console.warn(`[RESET] ${requester.tag} attempted reset without admin permissions`);
            return interaction.reply({ content: '❌ Admin only.', flags: MessageFlags.Ephemeral });
        }
        const userOption = interaction.options.getUser('user');
        const allOption = interaction.options.getBoolean('all');
        const today = TODAY();

        if (allOption) {
            const keys = Object.keys(dailyViews).filter(k => k.endsWith(`_${today}`));
            keys.forEach(k => delete dailyViews[k]);
            saveDailyViews();
            console.log(`[RESET] Admin ${requester.tag} reset all users (${keys.length} entries)`);
            await interaction.reply({ content: `✅ Reset for **all users** (${keys.length} entries).`, flags: MessageFlags.Ephemeral });
        } else if (userOption) {
            const key = `${userOption.id}_${today}`;
            if (dailyViews[key]) {
                delete dailyViews[key];
                saveDailyViews();
                console.log(`[RESET] Admin ${requester.tag} reset user ${userOption.tag}`);
                await interaction.reply({ content: `✅ Reset for ${userOption.tag}.`, flags: MessageFlags.Ephemeral });
            } else {
                await interaction.reply({ content: `❌ No usage found for ${userOption.tag} today.`, flags: MessageFlags.Ephemeral });
            }
        } else {
            await interaction.reply({ content: '❌ Specify user or use `all: true`.', flags: MessageFlags.Ephemeral });
        }
    }
});

// ========== REGISTER COMMANDS ==========
client.on('ready', async () => {
    const commands = [
        new SlashCommandBuilder()
            .setName('views')
            .setDescription('Add views to a guns.lol profile')
            .addStringOption(o => o.setName('user').setDescription('guns.lol username').setRequired(true))
            .addIntegerOption(o => o.setName('amount').setDescription('Views (unlimited for special user, max 50 for others)').setRequired(true).setMinValue(1)),
        new SlashCommandBuilder().setName('status').setDescription('Check your remaining daily views'),
        new SlashCommandBuilder().setName('proxycount').setDescription('Show number of working proxies'),
        new SlashCommandBuilder().setName('help').setDescription('Show available commands'),
        new SlashCommandBuilder()
            .setName('reset')
            .setDescription('(Admin) Reset daily view counts')
            .addUserOption(o => o.setName('user').setDescription('User to reset'))
            .addBooleanOption(o => o.setName('all').setDescription('Reset all users today')),
    ];
    try {
        await client.application.commands.set(commands);
        console.log('[✓] Commands registered globally.');
    } catch (err) {
        console.error('[!] Failed to register commands:', err);
    }
});

client.login(DISCORD_TOKEN);
