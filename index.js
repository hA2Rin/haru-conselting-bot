const { Client, GatewayIntentBits, PermissionFlagsBits, SlashCommandBuilder, Routes, ChannelType, REST, MessageFlags } = require('discord.js');
const express = require('express');
const config = require('./config.json');

const app = express();
app.get('/', (req, res) => res.send('하루의 고민상담소 시스템 가동 중 🎙️'));
app.listen(7860);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers
    ],
});

let waitingQueue = [];

function isCounselingRoom(channelName) {
    return channelName.startsWith('-하루의 고민상담소-');
}

client.on('clientReady', async () => {
    const commands = [
        new SlashCommandBuilder()
            .setName('상담')
            .setDescription('상담 신청 또는 상담자 설정')
            .addStringOption(option => 
                option.setName('type').setDescription('선택하세요.').setRequired(true)
                .addChoices({ name: '상담신청', value: 'apply' }, { name: '상담자', value: 'counselor' })),
        new SlashCommandBuilder().setName('대기열').setDescription('현재 대기 현황 확인'),
        new SlashCommandBuilder().setName('상담시작').setDescription('대기열의 첫 유저와 상담 시작'),
        new SlashCommandBuilder().setName('상담중지').setDescription('현재 상담방을 삭제하고 유저를 대기열 맨 앞으로 보냅니다.'),
        new SlashCommandBuilder().setName('상담재개').setDescription('대기열의 유저를 다시 호출하여 상담을 재개합니다.'),
        new SlashCommandBuilder().setName('상담종료').setDescription('모든 대기열 초기화 및 업무 종료'),
        new SlashCommandBuilder()
            .setName('세팅')
            .setDescription('카테고리 지정')
            .addChannelOption(option => option.setName('카테고리').setDescription('선택하세요').addChannelTypes(ChannelType.GuildCategory).setRequired(true)),
        new SlashCommandBuilder()
            .setName('설명')
            .setDescription('사용법 확인')
            .addStringOption(option => option.setName('type').setDescription('선택').addChoices({ name: '일반', value: 'user' }, { name: '관리자', value: 'admin' }))
    ].map(command => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('상담소 시스템 가동! 🎙️');
    } catch (e) { console.error(e); }
});

// --- [방 생성 함수 동일] ---
async function startPrivateCounseling(guild, counselor, targetMember) {
    try {
        const parentId = config.COUNSELING_CATEGORY_ID || null;
        const overwrites = [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: targetMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.SendMessages] },
            { id: config.COUNSELOR_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.SendMessages] },
            { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels] }
        ];
        const vChannel = await guild.channels.create({ 
            name: `-하루의 고민상담소-${targetMember.user.username}-`, 
            type: ChannelType.GuildVoice, parent: parentId, permissionOverwrites: overwrites 
        });
        await targetMember.voice.setChannel(vChannel).catch(() => {});
        if (counselor.voice.channel) await counselor.voice.setChannel(vChannel).catch(() => {});
        return vChannel;
    } catch (e) { return null; }
}

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { guild, user, member, commandName, options } = interaction;
    const isAuthorized = member.roles.cache.has(config.COUNSELOR_ROLE_ID) || member.permissions.has(PermissionFlagsBits.Administrator);

    try {
        // --- [설명 명령어: 대폭 보강] ---
        if (commandName === '설명') {
            const type = options.getString('type') || 'user';
            const essentialWarning = "⚠️ **중요: 꼭 대기실(<#" + config.WAITING_ROOM_ID + ">)에 입장한 상태에서 `/상담 type:상담신청`을 사용해야 합니다!**\n\n";

            if (type === 'admin') {
                if (!isAuthorized) return interaction.reply({ content: '❌ 관리자 전용 명령어입니다.', flags: MessageFlags.Ephemeral });
                
                const adminHelp = `
${essentialWarning}🛡️ **상담사(관리자) 가이드**
---
* **출근하기** : \`/상담 type:상담자\`
  > 상담 업무를 보기 위한 역할을 자신에게 부여합니다.
* **상담 시작** : \`/상담시작\` (또는 \`/상담재개\`)
  > 대기실에서 기다리는 1순위 유저를 위해 전용 방을 만들고 상담사와 유저를 동시에 이동시킵니다.
* **잠시 휴식** : \`/상담중지\`
  > 현재 상담 중인 방을 닫고, 유저를 대기실로 돌려보냅니다. (해당 유저는 대기 순위 1위를 유지합니다.)
* **업무 종료** : \`/상담종료\`
  > 모든 대기 명단을 초기화하고 상담 업무를 마칩니다.
* **환경 설정** : \`/세팅\`
  > 상담방이 생성될 카테고리를 지정합니다. (관리자 권한 필수)
                `;
                return interaction.reply({ content: adminHelp });
            } else {
                const userHelp = `
${essentialWarning}🎙️ **하루의 고민상담소 이용 방법**
---
1️⃣ **대기실 입장** : <#${config.WAITING_ROOM_ID}> 음성 채널에 먼저 들어가주세요.
2️⃣ **상담 신청** : \`/상담 type:상담신청\` 명령어를 입력합니다.
3️⃣ **순서 대기** : \`/대기열\` 명령어로 자신의 차례를 확인할 수 있습니다.
4️⃣ **자동 이동** : 상담사님이 호출하면 **전용 상담실로 자동 이동**됩니다. 
   *(방이 생길 때까지 대기실에서 대화하며 기다려주세요!)*
                `;
                return interaction.reply({ content: userHelp });
            }
        }

        // --- [나머지 명령어 로직 유지] ---
        if (commandName === '상담') {
            const subType = options.getString('type');
            if (subType === 'apply') {
                if (member.voice.channelId !== config.WAITING_ROOM_ID) {
                    return interaction.reply({ content: `❌ 먼저 <#${config.WAITING_ROOM_ID}> 채널에 입장해주세요!`, flags: MessageFlags.Ephemeral });
                }
                if (waitingQueue.some(q => q.userId === user.id)) return interaction.reply({ content: '이미 대기 중입니다.', flags: MessageFlags.Ephemeral });
                waitingQueue.push({ userId: user.id, userName: user.username });
                return interaction.reply({ content: `✅ 대기열 등록 완료 (순서: **${waitingQueue.length}번**)`, flags: MessageFlags.Ephemeral });
            }
            if (subType === 'counselor') {
                if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: '❌ 권한 없음', flags: MessageFlags.Ephemeral });
                await member.roles.add(config.COUNSELOR_ROLE_ID).catch(() => {});
                return interaction.reply({ content: '✅ 상담자 역할 부여 완료.', flags: MessageFlags.Ephemeral });
            }
        }

        if (commandName === '상담시작' || commandName === '상담재개') {
            if (!isAuthorized) return interaction.reply({ content: '❌ 권한 없음.', flags: MessageFlags.Ephemeral });
            if (waitingQueue.length === 0) return interaction.reply({ content: '대기자가 없습니다.', flags: MessageFlags.Ephemeral });
            if (!member.voice.channel) return interaction.reply({ content: '❌ 상담사님도 음성 채널에 먼저 접속하세요.', flags: MessageFlags.Ephemeral });
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const next = waitingQueue.shift();
            const targetMember = await guild.members.fetch(next.userId).catch(() => null);
            if (!targetMember || targetMember.voice.channelId !== config.WAITING_ROOM_ID) {
                return interaction.editReply({ content: `❌ **${next.userName}** 님이 대기실에 없습니다.` });
            }
            const room = await startPrivateCounseling(guild, member, targetMember);
            return interaction.editReply({ content: room ? `✅ **${targetMember.user.username}** 님과 상담을 시작합니다.` : '❌ 방 생성 실패.' });
        }

        if (commandName === '상담중지') {
            if (!isAuthorized) return interaction.reply({ content: '❌ 권한 없음.', flags: MessageFlags.Ephemeral });
            const currentCh = member.voice.channel;
            if (currentCh && isCounselingRoom(currentCh.name)) {
                const target = currentCh.members.find(m => !m.user.bot && !m.roles.cache.has(config.COUNSELOR_ROLE_ID));
                if (target) {
                    waitingQueue.unshift({ userId: target.id, userName: target.user.username });
                    await target.voice.setChannel(config.WAITING_ROOM_ID).catch(() => {});
                }
                await currentCh.delete().catch(() => {});
                return interaction.reply({ content: '⚠️ 상담 중지: 유저를 대기열 1순위로 복귀시켰습니다.', flags: MessageFlags.Ephemeral });
            }
            return interaction.reply({ content: '❌ 상담 중인 방이 아닙니다.', flags: MessageFlags.Ephemeral });
        }

        if (commandName === '대기열') {
            if (waitingQueue.length === 0) return interaction.reply({ content: '대기 인원이 없습니다.', flags: MessageFlags.Ephemeral });
            const list = waitingQueue.map((q, i) => `${i + 1}. **${q.userName}**`).join('\n');
            return interaction.reply({ content: `📋 **현재 대기 명단**\n${list}`, flags: MessageFlags.Ephemeral });
        }

        if (commandName === '상담종료') {
            if (!isAuthorized) return interaction.reply({ content: '❌ 권한 부족.', flags: MessageFlags.Ephemeral });
            waitingQueue = [];
            return interaction.reply({ content: '🛑 대기열을 초기화했습니다.' });
        }

        if (commandName === '세팅') {
            if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: '❌ 권한 부족.', flags: MessageFlags.Ephemeral });
            const category = options.getChannel('카테고리');
            config.COUNSELING_CATEGORY_ID = category.id;
            return interaction.reply({ content: `✅ 설정 완료: **${category.name}**`, flags: MessageFlags.Ephemeral });
        }
    } catch (e) { console.error(e); }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
        const oldCh = oldState.channel;
        if (oldCh && isCounselingRoom(oldCh.name) && oldCh.members.size === 0) {
            setTimeout(async () => {
                const checkCh = oldState.guild.channels.cache.get(oldCh.id);
                if (checkCh && checkCh.members.size === 0) await checkCh.delete().catch(() => {});
            }, 3000);
        }
        if (oldState.channelId === config.WAITING_ROOM_ID && newState.channelId !== config.WAITING_ROOM_ID) {
            waitingQueue = waitingQueue.filter(q => q.userId !== oldState.member.id);
        }
    } catch (e) {}
});

client.login(process.env.TOKEN);
