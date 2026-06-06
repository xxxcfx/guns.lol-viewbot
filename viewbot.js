const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');
const path = require('path');

// ========== CONFIG ==========
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'YOUR_BOT_TOKEN';
const ALLOWED_CHANNEL_ID = '1512808669522165832';
const LOG_CHANNEL_ID = '1512806516145520670';
const MAX_VIEWS_PER_USER_PER_DAY = 50;
const PROXY_FILE = 'http.txt';
const THUMBNAIL_URL = 'https://cdn.discordapp.com/attachments/1502245820114669579/1512809050394464397/download_2.jpg?ex=6a2570b8&is=6a241f38&hm=cd678daa95c326ff11313e17167ee91d5caeafbf1329e1fce1d0da954c3d9f14&';
const BROWSER_TIMEOUT = 30000;

// ========== STATE ==========
let proxyPool = [];
let dailyViews = {};
const TODAY = () => new Date().toISOString().slice(0, 10);
const DATA_FILE = path.join(__dirname, 'dailyViews.json');

function loadDailyViews() {
    try { if (fs.existsSync(DATA_FILE)) dailyViews = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
}
function saveDailyViews() {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(dailyViews, null, 2)); } catch (e) {}
}

function loadProxiesFromFile() {
    try {
        const content = fs.readFileSync(PROXY_FILE, 'utf8');
        const lines = content.split(/\r?\n/).filter(l => l.trim());
        const proxies = lines.map(l => l.trim()).filter(l => l.includes(':')).map(l => `http://${l}`);
        const unique = [...new Set(proxies)];
        console.log(`[i] Loaded ${unique.length} proxies from ${PROXY_FILE}`);
        return unique;
    } catch (err) {
        console.error(`[!] Failed to read ${PROXY_FILE}: ${err.message}`);
        return [];
    }
}

// ========== REAL CLICK USING PUPPETEER ==========
async function sendRealView(targetUrl, onLog, forceDirect = false) {
    const useProxy = !forceDirect && proxyPool.length > 0;
    const proxy = useProxy ? proxyPool[Math.floor(Math.random() * proxyPool.length)] : null;
    const ip = proxy ? proxy.split('://')[1].split(':')[0] : 'direct';

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

        browser = await puppeteer.launch({
            headless: true,
            args,
            timeout: BROWSER_TIMEOUT,
        });

        const page = await browser.newPage();
        const userAgent = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        ][Math.floor(Math.random() * 3)];
        await page.setUserAgent(userAgent);
        await page.setViewport({ width: 1280, height: 720 });

        // Step 1: Load page
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        const log1 = {
            proxy: proxy || 'none', ip, status: 'loaded', success: true,
            timestamp: new Date().toISOString(), type: 'load',
        };
        if (onLog) onLog(log1);

        // Wait 3 seconds (reading)
        await page.waitForTimeout(3000);

        // Step 2: Click centre of screen
        const viewport = page.viewport();
        await page.mouse.click(viewport.width / 2, viewport.height / 2);

        const log2 = {
            proxy: proxy || 'none', ip, status: 'clicked', success: true,
            timestamp: new Date().toISOString(), type: 'click',
        };
        if (onLog) onLog(log2);

        // Wait 2 seconds (lingering)
        await page.waitForTimeout(2000);

        await browser.close();
        return { success: true, ip, proxy, status: 200 };
    } catch (err) {
        console.error(`   [Puppeteer] Error: ${err.message}`);
        if (browser) await browser.close().catch(() => {});
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
    // Attempt with proxy if available
    if (proxyPool.length > 0) {
        const result = await sendRealView(targetUrl, onLog, false);
        if (result.success) return result;
        // If proxy failed, try direct
        console.log('   [fallback] Proxy failed, trying direct...');
    }
    // Direct (no proxy)
    const result = await sendRealView(targetUrl, onLog, true);
    return result;
}

// ========== DISCORD BOT ==========
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once('ready', () => {
    console.log(`[✓] Logged in as ${client.user.tag}`);
    loadDailyViews();
    proxyPool = loadProxiesFromFile();
    if (proxyPool.length === 0) console.warn('[!] No proxies loaded – will use direct connection only.');
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.channelId !== ALLOWED_CHANNEL_ID) {
        return interaction.reply({
            content: `❌ Commands can only be used in <#${ALLOWED_CHANNEL_ID}>.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    const commandName = interaction.commandName;
    const requester = interaction.user;

    // ========== /views ==========
    if (commandName === 'views') {
        await interaction.deferReply();

        const targetUser = interaction.options.getString('user');
        const amount = interaction.options.getInteger('amount');
        const today = TODAY();
        const key = `${requester.id}_${today}`;
        const usedToday = dailyViews[key] || 0;
        const allowed = MAX_VIEWS_PER_USER_PER_DAY - usedToday;

        if (allowed <= 0) {
            return interaction.editReply(`❌ You've used all ${MAX_VIEWS_PER_USER_PER_DAY} daily views. Try again tomorrow.`);
        }
        const viewsToDo = Math.min(amount, allowed);
        const targetUrl = `https://guns.lol/${targetUser}`;
        const logChannel = client.channels.cache.get(LOG_CHANNEL_ID);
        if (!logChannel) {
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
            .setFooter({ text: `Daily limit: ${MAX_VIEWS_PER_USER_PER_DAY} views/user` })
            .setTimestamp();

        const reply = await interaction.editReply({ embeds: [embed] });

        try {
            const headerEmbed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('🚀 View Bot – Started')
                .setDescription(`**Requested by:** ${requester.tag}\n**Target:** ${targetUrl}\n**Amount:** ${viewsToDo}\n**Proxies loaded:** ${proxyPool.length}\n**Method:** Puppeteer (real browser, real click)`)
                .setThumbnail(THUMBNAIL_URL)
                .setTimestamp();
            await logChannel.send({ embeds: [headerEmbed] });
        } catch (e) {}

        let successful = 0;
        let failed = 0;
        let logBatches = [];

        try {
            for (let i = 0; i < viewsToDo; i++) {
                const result = await sendViewWithFallback(targetUrl, (logEntry) => {
                    const line = `\`${logEntry.timestamp}\` | **IP:** ${logEntry.ip} | **Type:** ${logEntry.type} | **Status:** ${logEntry.status} | **Success:** ${logEntry.success ? '✅' : '❌'}`;
                    logBatches.push(line);
                });

                if (result.success) successful++;
                else failed++;

                dailyViews[key] = (dailyViews[key] || 0) + 1;
                saveDailyViews();

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
                } catch (e) {}

                if (logBatches.length >= 10) {
                    try {
                        const batch = logBatches.join('\n');
                        const logEmbed = new EmbedBuilder()
                            .setColor(0x3498DB)
                            .setDescription(batch.slice(0, 4000))
                            .setTimestamp();
                        await logChannel.send({ embeds: [logEmbed] });
                    } catch (e) {}
                    logBatches = [];
                }
            }
        } catch (e) {
            console.error('[FATAL] Loop error:', e);
            try { await reply.edit({ content: `❌ Fatal error: ${e.message}` }); } catch (_) {}
        }

        if (logBatches.length > 0) {
            try {
                const batch = logBatches.join('\n');
                const logEmbed = new EmbedBuilder()
                    .setColor(0x3498DB)
                    .setDescription(batch.slice(0, 4000))
                    .setTimestamp();
                await logChannel.send({ embeds: [logEmbed] });
            } catch (e) {}
        }

        try {
            const summaryEmbed = new EmbedBuilder()
                .setColor(successful > 0 ? 0x00FF00 : 0xFF0000)
                .setTitle('🏁 View Bot – Finished')
                .setThumbnail(THUMBNAIL_URL)
                .addFields(
                    { name: '✅ Successful', value: `${successful}`, inline: true },
                    { name: '❌ Failed', value: `${failed}`, inline: true },
                    { name: 'User Today', value: `${dailyViews[key]}/${MAX_VIEWS_PER_USER_PER_DAY}`, inline: true },
                    { name: 'Requested by', value: requester.tag, inline: false },
                )
                .setTimestamp();
            await logChannel.send({ embeds: [summaryEmbed] });
        } catch (e) {}

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
        } catch (e) {}
    }

    // ========== Other commands (unchanged) ==========
    else if (commandName === 'status') {
        const today = TODAY();
        const key = `${requester.id}_${today}`;
        const used = dailyViews[key] || 0;
        const remaining = MAX_VIEWS_PER_USER_PER_DAY - used;
        const embed = new EmbedBuilder()
            .setColor(0x3498DB)
            .setTitle('📊 Your Daily View Usage')
            .setThumbnail(THUMBNAIL_URL)
            .addFields(
                { name: 'Used Today', value: `${used}`, inline: true },
                { name: 'Remaining', value: `${remaining}`, inline: true },
                { name: 'Daily Limit', value: `${MAX_VIEWS_PER_USER_PER_DAY}`, inline: true }
            )
            .setTimestamp();
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    else if (commandName === 'proxycount') {
        const count = proxyPool.length;
        const embed = new EmbedBuilder()
            .setColor(0x9B59B6)
            .setTitle('🌐 Proxy Pool Info')
            .setThumbnail(THUMBNAIL_URL)
            .addFields(
                { name: 'Loaded Proxies', value: `${count}`, inline: true },
                { name: 'Source File', value: PROXY_FILE, inline: true }
            )
            .setTimestamp();
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    else if (commandName === 'help') {
        const embed = new EmbedBuilder()
            .setColor(0x2ECC71)
            .setTitle('📚 Available Commands')
            .setThumbnail(THUMBNAIL_URL)
            .addFields(
                { name: '/views', value: 'Start view bot for a user.\n  `user` – username\n  `amount` – views (max 50/day)', inline: false },
                { name: '/status', value: 'Check your remaining daily views.', inline: false },
                { name: '/proxycount', value: 'Show number of loaded proxies.', inline: false },
                { name: '/reset', value: '(Admin) Reset daily counts.', inline: false },
                { name: '/help', value: 'Show this message.', inline: false }
            )
            .setTimestamp();
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    else if (commandName === 'reset') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '❌ Admin only.', flags: MessageFlags.Ephemeral });
        }
        const userOption = interaction.options.getUser('user');
        const allOption = interaction.options.getBoolean('all');
        const today = TODAY();

        if (allOption) {
            const keys = Object.keys(dailyViews).filter(k => k.endsWith(`_${today}`));
            keys.forEach(k => delete dailyViews[k]);
            saveDailyViews();
            await interaction.reply({ content: `✅ Reset for **all users** (${keys.length} entries).`, flags: MessageFlags.Ephemeral });
        } else if (userOption) {
            const key = `${userOption.id}_${today}`;
            if (dailyViews[key]) {
                delete dailyViews[key];
                saveDailyViews();
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
            .addIntegerOption(o => o.setName('amount').setDescription('Views (max 50/day)').setRequired(true).setMinValue(1).setMaxValue(MAX_VIEWS_PER_USER_PER_DAY)),
        new SlashCommandBuilder().setName('status').setDescription('Check your remaining daily views'),
        new SlashCommandBuilder().setName('proxycount').setDescription('Show number of loaded proxies'),
        new SlashCommandBuilder().setName('help').setDescription('Show available commands'),
        new SlashCommandBuilder()
            .setName('reset')
            .setDescription('(Admin) Reset daily view counts')
            .addUserOption(o => o.setName('user').setDescription('User to reset'))
            .addBooleanOption(o => o.setName('all').setDescription('Reset all users today')),
    ];
    try {
        await client.application.commands.set(commands);
        console.log('[✓] Commands registered.');
    } catch (err) {
        console.error('[!] Failed to register commands:', err);
    }
});

client.login(DISCORD_TOKEN);
