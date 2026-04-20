require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionString = new StringSession(process.env.TELEGRAM_SESSION);

(async () => {
  const client = new TelegramClient(sessionString, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.connect();
  console.log('✅ 유저봇 연결 성공! 최근 대화방 목록을 불러옵니다...\n');

  // 최근 20개의 대화방(채널, 그룹, 개인톡 포함) 목록을 가져옵니다.
  const dialogs = await client.getDialogs({ limit: 20 });

  for (const dialog of dialogs) {
    // 그룹이나 채널은 보통 ID가 음수(-)로 시작합니다.
    console.log(`[${dialog.title}] -> ID: ${dialog.id.toString()}`);
  }

  await client.disconnect();
  process.exit(0);
})();