require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const fs = require('fs'); // 파일 저장을 위한 모듈

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionString = new StringSession(process.env.TELEGRAM_SESSION);

// 💡 리딩방의 고유 ID (어제 추출한 ID로 반드시 변경하세요!)
const TARGET_CHAT_ID = '-1001234567890';

// 🎯 테스트 모드 스위치 (true: 가상매매, false: 실전매매)
const IS_TEST_MODE = true;

// 💾 CSV 파일 초기 셋업 (파일이 없으면 생성)
const HISTORY_FILE = 'trade_history.csv';
if (!fs.existsSync(HISTORY_FILE)) {
  fs.writeFileSync(HISTORY_FILE, '\uFEFF시간,종목,포지션,계약수\n', 'utf8');
}

// 텍스트 파싱 로직
const parseSignal = (text) => {
  let signal = 'NONE';
  if (/시장가\s*매수/.test(text)) signal = 'BUY';
  else if (/시장가\s*매도/.test(text)) signal = 'SELL';
  else if (/시장가\s*청산/.test(text)) signal = 'EXIT';

  let quantity = 0;
  const qtyMatch = text.match(/(\d+)(?:~|-)?(?:\d+)?계약/);
  if (qtyMatch) quantity = Number(qtyMatch[1]);

  return { signal, quantity };
};

(async () => {
  console.log('🚀 텔레그램 유저봇 레이더 가동 준비 중...');

  const client = new TelegramClient(sessionString, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.connect();
  console.log(`✅ 연결 성공! [테스트 모드: ${IS_TEST_MODE ? 'ON (가상)' : 'OFF (실전)'}]`);

  // 새 메시지 감지 이벤트
  client.addEventHandler(async (event) => {
    const text = event.message.text || '';

    // "NQM26" 키워드가 없으면 무시
    if (!text.includes('NQM26')) return;

    const { signal, quantity } = parseSignal(text);
    if (signal === 'NONE') return; // 관련 없는 대화 무시

    const nowTime = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const orderQty = quantity > 0 ? quantity : 1;

    console.log('\n======================================');
    console.log(`🚨 [시그널 포착] ${signal} | ${orderQty}계약`);

    // 1. 진입 (BUY / SELL)
    if (signal === 'BUY' || signal === 'SELL') {
      if (IS_TEST_MODE) {
        console.log(`🧪 [가상매매] ${signal} 체결 기록 중...`);

        // CSV에 한 줄 쓰기
        const csvLine = `${nowTime},NQM26,${signal},${orderQty}\n`;
        fs.appendFileSync(HISTORY_FILE, csvLine, 'utf8');

        // 내 텔레그램 개인 톡방('me')으로 알림 전송
        await client.sendMessage('me', {
          message: `🤖 [가상 진입 완료]\n- 시간: ${nowTime}\n- 종목: NQM26\n- 포지션: ${signal}\n- 수량: ${orderQty}계약`
        });
      } else {
        // ⚠️ IS_TEST_MODE가 false일 때 진짜 KIS API 호출 (추후 연동)
        console.log(`🚀 [실전매매] 실제 돈으로 주문을 쏩니다! (현재는 로직 비워둠)`);
      }
    }
    // 2. 청산 (EXIT)
    else if (signal === 'EXIT') {
      console.log(`⚠️ [청산 시그널] 보유 포지션 종료`);
      if (IS_TEST_MODE) {
        fs.appendFileSync(HISTORY_FILE, `${nowTime},NQM26,EXIT,ALL\n`, 'utf8');
        await client.sendMessage('me', { message: `🤖 [가상 청산 완료]\n- 시간: ${nowTime}\n- NQM26 모든 포지션 청산` });
      }
    }

    console.log('======================================\n');

  }, new NewMessage({ chats: [TARGET_CHAT_ID] }));
})();