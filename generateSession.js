// generateSession.js
require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

// 빈 세션으로 시작
const stringSession = new StringSession('');

(async () => {
  console.log('텔레그램 유저봇 세션 발급을 시작합니다...');

  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text('📱 휴대폰 번호를 입력하세요 (+8210...): '),
    password: async () => await input.text('🔒 2단계 인증 비밀번호가 있다면 입력 (없으면 엔터): '),
    phoneCode: async () => await input.text('📩 텔레그램으로 온 인증 코드를 입력하세요: '),
    onError: (err) => console.log(err),
  });

  console.log('\n✅ 로그인 성공!');
  console.log('👇 아래의 세션 스트링을 복사해서 .env 파일의 TELEGRAM_SESSION 항목에 넣으세요 👇\n');

  const sessionString = client.session.save();
  console.log(sessionString);

  await client.disconnect();
  process.exit(0);
})();