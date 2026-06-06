const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const path = require('path');

// ========== CONFIG ==========
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'YOUR_BOT_TOKEN';
const ALLOWED_CHANNEL_ID = '1512808669522165832';
const LOG_CHANNEL_ID = '1512806516145520670';
const MAX_VIEWS_PER_USER_PER_DAY = 50;
const DELAY_BETWEEN_VIEWS = 1000; // 1 second
const RETRIES = 3;
const PROXY_FILE = 'http.txt';
const THUMBNAIL_URL = 'https://cdn.discordapp.com/attachments/1502245820114669579/1512809050394464397/download_2.jpg?ex=6a2570b8&is=6a241f38&hm=cd678daa95c326ff11313e17167ee91d5caeafbf1329e1fce1d0da954c3d9f14&';

// ========== STATE ==========
let proxyPool = [];
let dailyViews = {};
const TODAY = () => new Date().toISOString().slice(0, 10);
const DATA_FILE = path.join(__dirname, 'dailyViews.json');

function loadDailyViews() {
    try {
        if (fs.existsSync(DATA_FILE)) dailyViews = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) { /* ignore */ }
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

// ========== VIEW REQUEST WITH TIMEOUT ==========
async function sendView(targetUrl, onLog) {
    const proxy = proxyPool.length > 0 ? proxyPool[Math.floor(Math.random() * proxyPool.length)] : null;
    const ip = proxy ? proxy.split('://')[1].split(':')[0] : 'direct';

    let proxyAgent = null;
    if (proxy) {
        const url = new URL(proxy);
        if (url.protocol === 'http:') proxyAgent = new HttpProxyAgent(proxy);
        else if (url.protocol === 'https:') proxyAgent = new HttpsProxyAgent(proxy);
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
        },
        httpAgent: proxyAgent,
        httpsAgent: proxyAgent,
        timeout: 15000, // 15s per request
    };

    for (let attempt = 0; attempt < RETRIES; attempt++) {
        try {
            const resp = await axios.get(targetUrl, config);
            const status = resp.status;
            const success = status === 200;
            const log = {
                proxy: proxy || 'none', ip, status, success,
                attempt: attempt + 1, timestamp: new Date().toISOString(), userAgent: userAgent.slice(0, 50),
            };
            if (onLog) onLog(log);
            if (success) return { success: true, ip, proxy, status };
            if (status === 429) {
                const wait = Math.min((2 ** attempt + Math.random()) * 1000, 10000);
                await sleep(wait);
                continue;
            }
            return { success: false, ip, proxy, status };
        } catch (err) {
            // If error, log failure and retry
            const log = {
                proxy: proxy || 'none', ip, status: 'error', success: false,
                attempt: attempt + 1, timestamp: new Date().toISOString(), userAgent: 'error',
            };
            if (onLog) onLog(log);
            if (attempt < RETRIES - 1) {
                const wait = 2000; // 2s between retries
                await sleep(wait);
            }
        }
    }
    return { success: false, ip, proxy, status: 'error' };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== DISCORD BOT ==========
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once('ready', () => {
    console.log(`[✓] Logged in as ${client.user.tag}`);
    loadDailyViews();
    proxyPool = loadProxiesFromFile();
    if (proxyPool.length === 0) console.warn('[!] No proxies loaded.');
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // Channel restriction
    if (interaction.channelId !== ALLOWED_CHANNEL_ID) {
        return interaction.reply({
            content: `❌ Commands can only be used in <#${ALLOWED_CHANNEL_ID}>.`,
            ephemeral: true,
        });
    }

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
            return interaction.editReply(`❌ You've used all ${MAX_VIEWS_PER_USER_PER_DAY} daily views. Try again tomorrow.`);
        }
        const viewsToDo = Math.min(amount, allowed);
        const targetUrl = `https://guns.lol/${targetUser}`;
        const logChannel = client.channels.cache.get(LOG_CHANNEL_ID);
        if (!logChannel) {
            return interaction.editReply('❌ Log channel not found. Contact admin.');
        }

        // Initial embed
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

        // Header log
        const headerEmbed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('🚀 View Bot – Started')
            .setDescription(`**Requested by:** ${requester.tag}\n**Target:** ${targetUrl}\n**Amount:** ${viewsToDo}\n**Proxies loaded:** ${proxyPool.length}`)
            .setThumbnail(THUMBNAIL_URL)
            .setTimestamp();
        await logChannel.send({ embeds: [headerEmbed] });

        let successful = 0;
        let failed = 0;
        let logBatches = [];

        for (let i = 0; i < viewsToDo; i++) {
            const result = await sendView(targetUrl, (logEntry) => {
                const line = `\`${logEntry.timestamp}\` | **IP:** ${logEntry.ip} | **Proxy:** \`${logEntry.proxy}\` | **Status:** ${logEntry.status} | **Success:** ${logEntry.success ? '✅' : '❌'} | **Attempt:** ${logEntry.attempt}`;
                logBatches.push(line);
            });

            if (result.success) successful++;
            else failed++;

            dailyViews[key] = (dailyViews[key] || 0) + 1;
            saveDailyViews();

            // Update embed after each attempt
            const statusText = result.success
                ? `✅ View #${i + 1} added (IP: ${result.ip})`
                : `❌ Failed (IP: ${result.ip}, status: ${result.status})`;

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

            // Batch logs every 10 entries
            if (logBatches.length >= 10) {
                const batch = logBatches.join('\n');
                const logEmbed = new EmbedBuilder()
                    .setColor(0x3498DB)
                    .setDescription(batch.slice(0, 4000))
                    .setTimestamp();
                await logChannel.send({ embeds: [logEmbed] });
                logBatches = [];
            }

            if (i < viewsToDo - 1) await sleep(DELAY_BETWEEN_VIEWS);
        }

        // Send remaining logs
        if (logBatches.length > 0) {
            const batch = logBatches.join('\n');
            const logEmbed = new EmbedBuilder()
                .setColor(0x3498DB)
                .setDescription(batch.slice(0, 4000))
                .setTimestamp();
            await logChannel.send({ embeds: [logEmbed] });
        }

        // Final log summary
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

        // Final embed update
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
    }

    // ========== Other commands (status, proxycount, help, reset) ==========
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
        await interaction.reply({ embeds: [embed], ephemeral: true });
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
        await interaction.reply({ embeds: [embed], ephemeral: true });
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
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    else if (commandName === 'reset') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
        }
        const userOption = interaction.options.getUser('user');
        const allOption = interaction.options.getBoolean('all');
        const today = TODAY();

        if (allOption) {
            const keys = Object.keys(dailyViews).filter(k => k.endsWith(`_${today}`));
            keys.forEach(k => delete dailyViews[k]);
            saveDailyViews();
            await interaction.reply({ content: `✅ Reset for **all users** (${keys.length} entries).`, ephemeral: true });
        } else if (userOption) {
            const key = `${userOption.id}_${today}`;
            if (dailyViews[key]) {
                delete dailyViews[key];
                saveDailyViews();
                await interaction.reply({ content: `✅ Reset for ${userOption.tag}.`, ephemeral: true });
            } else {
                await interaction.reply({ content: `❌ No usage found for ${userOption.tag} today.`, ephemeral: true });
            }
        } else {
            await interaction.reply({ content: '❌ Specify user or use `all: true`.', ephemeral: true });
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
