const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const path = require('path');

// ========== CONFIG ==========
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'YOUR_BOT_TOKEN';
const LOG_CHANNEL_ID = '1512806516145520670';
const MAX_VIEWS_PER_USER_PER_DAY = 50;
const DELAY_BETWEEN_VIEWS = 1000; // 1 second
const RETRIES = 3;
const PROXY_FILE = 'http.txt';

// ========== STATE ==========
let proxyPool = [];
let dailyViews = {};  // { "userId_date": count }
const TODAY = () => new Date().toISOString().slice(0, 10);
const DATA_FILE = path.join(__dirname, 'dailyViews.json');

// ========== PERSISTENCE ==========
function loadDailyViews() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            dailyViews = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }
    } catch (e) { /* ignore */ }
}
function saveDailyViews() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(dailyViews, null, 2));
    } catch (e) { /* ignore */ }
}

// ========== PROXY LOADING ==========
function loadProxiesFromFile() {
    try {
        const content = fs.readFileSync(PROXY_FILE, 'utf8');
        const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
        const proxies = lines
            .map(line => line.trim())
            .filter(line => line.includes(':'))
            .map(line => `http://${line}`);
        const unique = [...new Set(proxies)];
        console.log(`[i] Loaded ${unique.length} HTTP proxies from ${PROXY_FILE}`);
        return unique;
    } catch (err) {
        console.error(`[!] Failed to read ${PROXY_FILE}: ${err.message}`);
        return [];
    }
}

// ========== SINGLE VIEW REQUEST ==========
async function sendView(targetUrl, onLog) {
    const proxy = proxyPool.length > 0
        ? proxyPool[Math.floor(Math.random() * proxyPool.length)]
        : null;

    const ip = proxy ? proxy.split('://')[1].split(':')[0] : 'direct';

    let proxyAgent = null;
    if (proxy) {
        const proxyUrl = new URL(proxy);
        if (proxyUrl.protocol === 'http:') {
            proxyAgent = new HttpProxyAgent(proxy);
        } else if (proxyUrl.protocol === 'https:') {
            proxyAgent = new HttpsProxyAgent(proxy);
        }
    }

    const userAgent = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    ][Math.floor(Math.random() * 3)];

    const config = {
        headers: {
            'User-Agent': userAgent,
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
            const resp = await axios.get(targetUrl, config);
            const logEntry = {
                proxy: proxy || 'none',
                ip,
                status: resp.status,
                success: resp.status === 200,
                attempt: attempt + 1,
                timestamp: new Date().toISOString(),
                userAgent: userAgent.slice(0, 50)
            };
            if (onLog) onLog(logEntry);
            if (resp.status === 200) {
                return { success: true, ip, proxy };
            } else if (resp.status === 429) {
                const wait = Math.min(Math.pow(2, attempt) + Math.random(), 10) * 1000;
                console.log(`   ⏳ 429 – waiting ${wait/1000}s`);
                await sleep(wait);
                continue;
            } else {
                return { success: false, ip, proxy, status: resp.status };
            }
        } catch (err) {
            await sleep(1000);
        }
    }
    const logEntry = {
        proxy: proxy || 'none',
        ip,
        status: 'error',
        success: false,
        attempt: RETRIES,
        timestamp: new Date().toISOString(),
        userAgent: 'error'
    };
    if (onLog) onLog(logEntry);
    return { success: false, ip, proxy, status: 'error' };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== DISCORD BOT ==========
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

client.once('ready', () => {
    console.log(`[✓] Bot logged in as ${client.user.tag}`);
    loadDailyViews();
    proxyPool = loadProxiesFromFile();
    if (proxyPool.length === 0) {
        console.warn('[!] No proxies loaded. Views may fail.');
    }
});

// ========== COMMAND HANDLER ==========
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const commandName = interaction.commandName;
    const requester = interaction.user;

    // ========== /views ==========
    if (commandName === 'views') {
        await interaction.deferReply({ ephemeral: false });

        const targetUser = interaction.options.getString('user');
        const amount = interaction.options.getInteger('amount');
        const today = TODAY();
        const key = `${requester.id}_${today}`;

        const usedToday = dailyViews[key] || 0;
        const allowed = MAX_VIEWS_PER_USER_PER_DAY - usedToday;
        if (allowed <= 0) {
            await interaction.editReply(`❌ You have reached your daily limit of ${MAX_VIEWS_PER_USER_PER_DAY} views. Try again tomorrow.`);
            return;
        }
        const viewsToDo = Math.min(amount, allowed);

        const targetUrl = `https://guns.lol/${targetUser}`;
        const logChannel = client.channels.cache.get(LOG_CHANNEL_ID);
        if (!logChannel) {
            await interaction.editReply('❌ Log channel not found. Contact admin.');
            return;
        }

        await interaction.editReply(`🎯 Starting views for **${targetUser}** – ${viewsToDo} views (1s delay). Daily limit: ${MAX_VIEWS_PER_USER_PER_DAY} (used: ${usedToday}). Logging to <#${LOG_CHANNEL_ID}>.`);

        // Header log
        const headerEmbed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle(`🚀 View Bot – ${targetUser}`)
            .setDescription(`**Requested by:** ${requester.tag}\n**Target:** ${targetUrl}\n**Amount:** ${viewsToDo}\n**Date:** ${today}\n**Proxy Pool:** ${proxyPool.length}`)
            .setTimestamp();
        await logChannel.send({ embeds: [headerEmbed] });

        let successful = 0;
        let failed = 0;
        let logMessages = [];

        for (let i = 0; i < viewsToDo; i++) {
            const { success, ip, proxy, status } = await sendView(targetUrl, (logEntry) => {
                const line = `\`${logEntry.timestamp}\` | **IP:** ${logEntry.ip} | **Proxy:** ${logEntry.proxy} | **Status:** ${logEntry.status} | **Success:** ${logEntry.success ? '✅' : '❌'} | **Attempt:** ${logEntry.attempt}`;
                logMessages.push(line);
            });

            if (success) successful++;
            else failed++;

            dailyViews[key] = (dailyViews[key] || 0) + 1;
            saveDailyViews();

            if (logMessages.length >= 10) {
                const batch = logMessages.join('\n');
                const embed = new EmbedBuilder()
                    .setColor(0x3498DB)
                    .setDescription(batch.slice(0, 4000))
                    .setTimestamp();
                await logChannel.send({ embeds: [embed] });
                logMessages = [];
            }

            await sleep(DELAY_BETWEEN_VIEWS);
        }

        // Remaining logs
        if (logMessages.length > 0) {
            const batch = logMessages.join('\n');
            const embed = new EmbedBuilder()
                .setColor(0x3498DB)
                .setDescription(batch.slice(0, 4000))
                .setTimestamp();
            await logChannel.send({ embeds: [embed] });
        }

        // Final summary
        const summaryEmbed = new EmbedBuilder()
            .setColor(successful > 0 ? 0x00FF00 : 0xFF0000)
            .setTitle('🏁 View Bot Finished')
            .addFields(
                { name: '✅ Successful', value: `${successful}`, inline: true },
                { name: '❌ Failed', value: `${failed}`, inline: true },
                { name: 'Total Today (User)', value: `${dailyViews[key]} / ${MAX_VIEWS_PER_USER_PER_DAY}`, inline: true }
            )
            .setTimestamp();
        await logChannel.send({ embeds: [summaryEmbed] });

        await interaction.followUp(`✅ **View bot finished!** Successful: ${successful}, Failed: ${failed}. Check <#${LOG_CHANNEL_ID}> for full logs.`);
    }

    // ========== /status ==========
    else if (commandName === 'status') {
        const today = TODAY();
        const key = `${requester.id}_${today}`;
        const used = dailyViews[key] || 0;
        const remaining = MAX_VIEWS_PER_USER_PER_DAY - used;

        const embed = new EmbedBuilder()
            .setColor(0x3498DB)
            .setTitle('📊 Your Daily View Usage')
            .addFields(
                { name: 'Used Today', value: `${used}`, inline: true },
                { name: 'Remaining', value: `${remaining}`, inline: true },
                { name: 'Daily Limit', value: `${MAX_VIEWS_PER_USER_PER_DAY}`, inline: true }
            )
            .setTimestamp();
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ========== /proxycount ==========
    else if (commandName === 'proxycount') {
        const count = proxyPool.length;
        const embed = new EmbedBuilder()
            .setColor(0x9B59B6)
            .setTitle('🌐 Proxy Pool Info')
            .addFields(
                { name: 'Loaded Proxies', value: `${count}`, inline: true },
                { name: 'Source File', value: PROXY_FILE, inline: true }
            )
            .setTimestamp();
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ========== /help ==========
    else if (commandName === 'help') {
        const embed = new EmbedBuilder()
            .setColor(0x2ECC71)
            .setTitle('📚 Available Commands')
            .addFields(
                { name: '/views', value: 'Start view bot for a user.\n  `user` – guns.lol username\n  `amount` – views (max 50/day)', inline: false },
                { name: '/status', value: 'Show your remaining daily views.', inline: false },
                { name: '/proxycount', value: 'Show number of loaded proxies.', inline: false },
                { name: '/reset', value: '(Admin only) Reset daily counts for a user or all.', inline: false },
                { name: '/help', value: 'Show this message.', inline: false }
            )
            .setTimestamp();
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ========== /reset (admin only) ==========
    else if (commandName === 'reset') {
        // Only allow members with ADMINISTRATOR permission
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            await interaction.reply({ content: '❌ You need Administrator permission to use this command.', ephemeral: true });
            return;
        }

        const userOption = interaction.options.getUser('user');
        const allOption = interaction.options.getBoolean('all');
        const today = TODAY();

        if (allOption) {
            // Reset all users for today
            const keysToDelete = Object.keys(dailyViews).filter(k => k.endsWith(`_${today}`));
            keysToDelete.forEach(k => delete dailyViews[k]);
            saveDailyViews();
            await interaction.reply({ content: `✅ Reset daily counts for **all users** (${keysToDelete.length} entries) for today.`, ephemeral: true });
        } else if (userOption) {
            const resetKey = `${userOption.id}_${today}`;
            if (dailyViews[resetKey]) {
                delete dailyViews[resetKey];
                saveDailyViews();
                await interaction.reply({ content: `✅ Reset daily count for ${userOption.tag}.`, ephemeral: true });
            } else {
                await interaction.reply({ content: `❌ No daily count found for ${userOption.tag} today.`, ephemeral: true });
            }
        } else {
            await interaction.reply({ content: '❌ Please specify a user or use `all: true`.', ephemeral: true });
        }
    }
});

// ========== REGISTER SLASH COMMANDS ==========
client.on('ready', async () => {
    const commands = [
        new SlashCommandBuilder()
            .setName('views')
            .setDescription('Add views to a guns.lol profile')
            .addStringOption(option =>
                option.setName('user')
                    .setDescription('guns.lol username (e.g., f7tv)')
                    .setRequired(true))
            .addIntegerOption(option =>
                option.setName('amount')
                    .setDescription('Number of views (max ' + MAX_VIEWS_PER_USER_PER_DAY + ' per day)')
                    .setRequired(true)
                    .setMinValue(1)
                    .setMaxValue(MAX_VIEWS_PER_USER_PER_DAY)),
        new SlashCommandBuilder()
            .setName('status')
            .setDescription('Check your remaining daily views'),
        new SlashCommandBuilder()
            .setName('proxycount')
            .setDescription('Show number of loaded proxies'),
        new SlashCommandBuilder()
            .setName('help')
            .setDescription('Show available commands'),
        new SlashCommandBuilder()
            .setName('reset')
            .setDescription('(Admin) Reset daily view counts')
            .addUserOption(option =>
                option.setName('user')
                    .setDescription('User to reset (leave blank with --all)'))
            .addBooleanOption(option =>
                option.setName('all')
                    .setDescription('Set to true to reset all users for today'))
    ];

    try {
        await client.application.commands.set(commands);
        console.log('[✓] Slash commands registered.');
    } catch (err) {
        console.error('[!] Failed to register commands:', err);
    }
});

client.login(DISCORD_TOKEN);
