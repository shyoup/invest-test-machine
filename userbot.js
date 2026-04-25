require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const fs = require('fs');

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionString = new StringSession(process.env.TELEGRAM_SESSION);

// 🎯 테스트 모드 스위치 (true: 가상매매, false: 실전매매)
const IS_TEST_MODE = true;

// ==========================================
// 📋 감시 채팅방 설정
// - chatId    : node getChats.js 로 확인한 채팅방 ID (문자열)
// - name      : 로그 구분용 이름
// - senderIds : 허용할 발신자 ID 배열. 빈 배열이면 모든 발신자 허용
// - filterRegex : 이 정규식에 매칭되는 메시지만 처리
// - ticker    : CSV/알림에 기록할 종목명
// ==========================================
const CHAT_CONFIGS = [
  {
    chatId: '-1003129260268',
    name: '나스닥 리딩방',
    senderIds: [],                      // 빈 배열 = 모든 사람 허용
    filterRegex: /NQM26/,
    ticker: 'NQM26',
  },
  // 아래처럼 방을 추가할 수 있습니다.
  {
    chatId: '-1002629582308',
    name: '[불장주식뉴스]',
    senderIds: [], // 이 ID를 가진 사람의 메시지만 처리
    filterRegex: /삼성전자|하이닉스/,
    ticker: 'KR_SIGNAL',
  },
  {
    chatId: '-1003634606282',
    name: '[미경정의 종목토론방]',
    senderIds: [], // 이 ID를 가진 사람의 메시지만 처리
    filterRegex: /삼성전자|하이닉스/,
    ticker: 'KR_SIGNAL',
  },
  {
    chatId: '8694296658',
    name: '[SH]',
    senderIds: [], // 이 ID를 가진 사람의 메시지만 처리
    filterRegex: /삼성전자|하이닉스/,
    ticker: 'KR_SIGNAL',
  },
];

// 💾 CSV 파일 초기 셋업
const HISTORY_FILE = 'trade_history.csv';
if (!fs.existsSync(HISTORY_FILE)) {
  fs.writeFileSync(HISTORY_FILE, '﻿시간,종목,방이름,포지션,계약수\n', 'utf8');
}

// 시그널 파싱 (시장가 매수 / 매도 / 청산, 계약수 추출)
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
  console.log(`📋 감시 채팅방 ${CHAT_CONFIGS.length}개 등록됨:`);
  CHAT_CONFIGS.forEach(c => console.log(`  - [${c.name}] chatId: ${c.chatId}`));

  const client = new TelegramClient(sessionString, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.connect();
  console.log(`\n✅ 연결 성공! [테스트 모드: ${IS_TEST_MODE ? 'ON (가상)' : 'OFF (실전)'}]\n`);

  client.addEventHandler(async (event) => {
    try {
      if (!event.message) return;

      const msg = event.message;
      const text = msg.message || msg.text || '';

      // peerId로 chatId 추출 (고수준 chatId는 채널에서 -100 prefix가 빠지는 버그 있음)
      let chatId = '';
      if (msg.peerId) {
        if (msg.peerId.channelId != null) {
          chatId = `-100${msg.peerId.channelId.toString()}`;
        } else if (msg.peerId.chatId != null) {
          chatId = `-${msg.peerId.chatId.toString()}`;
        } else if (msg.peerId.userId != null) {
          chatId = msg.peerId.userId.toString();
        }
      }
      if (!chatId) chatId = msg.chatId?.toString() || '';

      // senderId: fromId(그룹) 또는 senderId(DM) 모두 커버
      const senderId = msg.fromId?.userId?.toString() || msg.senderId?.toString() || '';

      // 전체 수신 로그 (디버깅용 — 정상 작동 확인 후 주석 처리 가능)
      console.log(`[수신] 채팅: ${chatId} | 발신자: ${senderId} | 내용: ${text.slice(0, 60)}`);

      // 등록된 채팅방 설정 탐색
      const config = CHAT_CONFIGS.find(c => c.chatId === chatId);
      if (!config) return;

      // 발신자 필터 (senderIds가 비어있으면 모두 허용)
      if (config.senderIds.length > 0 && !config.senderIds.includes(senderId)) return;

      // 커스텀 정규식 필터
      if (!config.filterRegex.test(text)) return;

      const { signal, quantity } = parseSignal(text);
      if (signal === 'NONE') return;

      const nowTime = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
      const orderQty = quantity > 0 ? quantity : 1;

      console.log('\n======================================');
      console.log(`🚨 [${config.name}] 시그널 포착: ${signal} | ${orderQty}계약`);

      if (signal === 'BUY' || signal === 'SELL') {
        if (IS_TEST_MODE) {
          console.log(`🧪 [가상매매] ${signal} 체결 기록 중...`);
          const csvLine = `${nowTime},${config.ticker},${config.name},${signal},${orderQty}\n`;
          fs.appendFileSync(HISTORY_FILE, csvLine, 'utf8');
          await client.sendMessage('me', {
            message: `🤖 [가상 진입 완료]\n- 시간: ${nowTime}\n- 방: ${config.name}\n- 종목: ${config.ticker}\n- 포지션: ${signal}\n- 수량: ${orderQty}계약`,
          });
        } else {
          console.log(`🚀 [실전매매] 실제 주문 실행 (추후 연동)`);
        }
      } else if (signal === 'EXIT') {
        console.log(`⚠️ [청산 시그널] 보유 포지션 종료`);
        if (IS_TEST_MODE) {
          fs.appendFileSync(HISTORY_FILE, `${nowTime},${config.ticker},${config.name},EXIT,ALL\n`, 'utf8');
          await client.sendMessage('me', {
            message: `🤖 [가상 청산 완료]\n- 시간: ${nowTime}\n- 방: ${config.name}\n- ${config.ticker} 모든 포지션 청산`,
          });
        }
      }

      console.log('======================================\n');

    } catch (err) {
      console.error(`[유저봇 에러] ${err.message}`);
    }
  }, new NewMessage({}));
})();
