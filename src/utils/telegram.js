require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const { bot, myChatId } = require('./src/utils/telegram'); // bot 객체 불러오기

const token = process.env.TELEGRAM_TOKEN;
const myChatId = process.env.TELEGRAM_CHAT_ID;
const WATCHLIST_PATH = path.join(__dirname, '../../watchlist.json');
const SETTINGS_FILE = 'settings.json';

// 1. Polling을 true로 켜서 메시지 수신 대기 상태로 만듭니다.
let bot;
if (token) {
  bot = new TelegramBot(token, { polling: true });
  console.log('📡 텔레그램 Admin 수신 대기 중...');
}

// 설정 읽기
const readSettings = () => {
  if (!fs.existsSync(SETTINGS_FILE)) return { isNotiOn: true };
  return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
};

// 설정 쓰기
const writeSettings = (settings) => {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
};

// 💡 알림 전송 함수 업그레이드
const sendMessage = async (text) => {
  const settings = readSettings();
  const now = new Date();
  const hour = now.getHours(); // 0~23

  // 1. 알림이 꺼져있으면 전송 안 함
  if (!settings.isNotiOn) return;

  // 2. 새벽 00시 ~ 아침 08시 사이면 전송 안 함
  if (hour >= 0 && hour < 8) {
    console.log(`[에티켓 모드] ${hour}시이므로 텔레그램 전송을 건너뜁니다.`);
    return;
  }

  try {
    await bot.sendMessage(myChatId, text, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('텔레그램 전송 실패:', err.message);
  }
};
// ==========================================
// 💡 Admin 명령어 처리 로직 (양방향)
// ==========================================

// 유틸: 관심종목 파일 읽기 (구조 변경 대응)
const readWatchlist = () => {
  const defaultStructure = { KR: {}, US: {} }; // 배열([])에서 객체({})로 변경
  try {
    if (!fs.existsSync(WATCHLIST_PATH)) return defaultStructure;
    const data = fs.readFileSync(WATCHLIST_PATH, 'utf8');
    if (!data.trim()) return defaultStructure;

    const parsed = JSON.parse(data);

    // 마이그레이션 방어 로직: 기존에 배열로 저장되어 있었다면 객체로 초기화
    return {
      KR: Array.isArray(parsed.KR) ? {} : (parsed.KR || {}),
      US: Array.isArray(parsed.US) ? {} : (parsed.US || {})
    };
  } catch (e) {
    console.error('⚠️ 파싱 에러. 기본값 복구:', e.message);
    return defaultStructure;
  }
};

// 유틸: 관심종목 파일 쓰기
const writeWatchlist = (list) => {
  fs.writeFileSync(WATCHLIST_PATH, JSON.stringify(list, null, 2), 'utf8');
};

// 💡 명령어 1: 스마트 다중 추가 (/add 종목코드 [비중], 종목코드 [비중] ...)
bot.onText(/\/add\s+(.+)/i, (msg, match) => {
  if (String(msg.chat.id) !== myChatId) return;

  const inputString = match[1].trim();
  const items = inputString.split(','); // 콤마로 그룹 분리
  const listObj = readWatchlist();

  let successMsgs = [];
  let errorMsgs = [];

  items.forEach(item => {
    // 공백을 기준으로 티커와 비중 분리
    const parts = item.trim().split(/\s+/);
    if (parts.length === 0 || parts[0] === '') return;

    const rawTicker = parts[0];
    const weight = parts[1] ? Number(parts[1]) : 5; // 입력 없으면 디폴트 5%

    // 🧠 시장 자동 분류
    const market = /^\d+$/.test(rawTicker) ? 'KR' : 'US';
    const ticker = market === 'US' ? rawTicker.toUpperCase() : rawTicker;

    if (isNaN(weight) || weight < 1 || weight > 100) {
      errorMsgs.push(`⚠️ <code>${ticker}</code>: 비중 오류 (1~100 입력)`);
      return; // 에러 난 종목만 건너뛰고 나머지는 계속 진행
    }

    listObj[market][ticker] = weight;
    successMsgs.push(`- [${market}] <code>${ticker}</code> (${weight}%)`);
  });

  writeWatchlist(listObj);

  let replyMsg = '';
  if (successMsgs.length > 0) {
    replyMsg += `✅ <b>스마트 다중 추가 완료</b>\n${successMsgs.join('\n')}\n`;
  }
  if (errorMsgs.length > 0) {
    replyMsg += `\n${errorMsgs.join('\n')}`;
  }

  bot.sendMessage(myChatId, replyMsg.trim(), { parse_mode: 'HTML' });
});

// 💡 명령어 2: 스마트 다중 삭제 (/del 종목코드, 종목코드 ...)
bot.onText(/\/del\s+(.+)/i, (msg, match) => {
  if (String(msg.chat.id) !== myChatId) return;

  const inputString = match[1].trim();
  const items = inputString.split(',');
  const listObj = readWatchlist();

  let successMsgs = [];
  let errorMsgs = [];

  items.forEach(item => {
    const rawTicker = item.trim();
    if (!rawTicker) return;

    const market = /^\d+$/.test(rawTicker) ? 'KR' : 'US';
    const ticker = market === 'US' ? rawTicker.toUpperCase() : rawTicker;

    if (listObj[market][ticker] !== undefined) {
      delete listObj[market][ticker];
      successMsgs.push(`<code>${ticker}</code>`);
    } else {
      errorMsgs.push(`⚠️ <code>${ticker}</code>: 리스트에 없음`);
    }
  });

  writeWatchlist(listObj);

  let replyMsg = '';
  if (successMsgs.length > 0) {
    replyMsg += `🗑️ <b>다중 삭제 완료</b>\n- [${successMsgs.join(', ')}]\n`;
  }
  if (errorMsgs.length > 0) {
    replyMsg += `\n${errorMsgs.join('\n')}`;
  }

  bot.sendMessage(myChatId, replyMsg.trim(), { parse_mode: 'HTML' });
});

// 💡 명령어 3: /list
bot.onText(/\/list/, (msg) => {
  if (String(msg.chat.id) !== myChatId) return;

  const listObj = readWatchlist();

  // 객체를 보기 좋은 문자열로 변환 (예: 005930(10%), 042700(20%))
  const formatList = (marketObj) => {
    const entries = Object.entries(marketObj);
    if (entries.length === 0) return '없음';
    return entries.map(([ticker, weight]) => `${ticker}(${weight}%)`).join(', ');
  };

  const krList = formatList(listObj.KR);
  const usList = formatList(listObj.US);

  bot.sendMessage(myChatId, `📋 [현재 감시 종목 및 비중]\n🇰🇷 국장: ${krList}\n🇺🇸 미장: ${usList}`);
});

// 💡 명령어 4: 가이드 (다중 입력 안내 추가)
bot.onText(/\/guide/, (msg) => {
  if (String(msg.chat.id) !== myChatId) return;

  const guideText = `
🤖 <b>글로벌 자동매매 봇 사용 가이드 (Ver 2.0)</b>

✅ <b>종목 추가 및 비중 설정</b>
- 사용법: <code>/add 종목코드 [비중], 종목코드 [비중]...</code>
- 예시 1: <code>/add 005930 10</code> (삼성전자 10%)
- 예시 2: <code>/add AAPL 10, TSLA, NVDA 20</code> (테슬라는 기본 5% 적용)
💡 <i>비중 생략 시 기본 <b>5%</b> 세팅, 숫자만 입력하면 국장(KR)으로 자동 인식합니다.</i>

🗑️ <b>종목 삭제 (다중 입력 지원)</b>
- 사용법: <code>/del 종목코드, 종목코드...</code>
- 예시: <code>/del 005930, AAPL, TSLA</code>

📋 <b>리스트 확인</b>
- <code>/list</code> : 현재 감시 중인 모든 종목과 비중 출력
- <code>/scan</code> : <b>즉시 모든 종목 스캔 및 매매 실행</b>

🔔 <b>알림 제어</b>
- <code>/noti on</code> : 모든 알림 켜기
- <code>/noti off</code> : 모든 알림 끄기
- 💡 <b>에티켓 모드:</b> 설정과 관계없이 새벽 00시~08시 사이에는 알림이 발송되지 않습니다.

💡 <b>기타 팁</b>
- 대소문자 구분 없이 찰떡같이 인식합니다.
  `;

  bot.sendMessage(myChatId, guideText, { parse_mode: 'HTML' });
});

// 💡 명령어 추가: /noti on 또는 /noti off
bot.onText(/\/noti\s+(on|off)/i, (msg, match) => {
  if (String(msg.chat.id) !== myChatId) return;
  const status = match[1].toLowerCase() === 'on';
  writeSettings({ isNotiOn: status });

  const statusTxt = status ? '✅ 켜짐' : '📴 꺼짐 (에티켓 시간 포함)';
  bot.sendMessage(myChatId, `🔔 <b>알림 설정 변경</b>: ${statusTxt}`, { parse_mode: 'HTML' });
});

/**
 * 💡 수동 스캔 명령어 (/scan)
 */
bot.onText(/\/scan/i, async (msg) => {
  if (String(msg.chat.id) !== myChatId) return;

  await sendMessage("🚀 <b>수동 스캔 요청을 확인했습니다.</b>\n국장과 미장 순차 분석을 시작합니다.");

  // 국장 스캔 실행
  await runScanner('KR');
  // 미장 스캔 실행
  await runScanner('US');

  await sendMessage("🏁 <b>수동 스캔이 완료되었습니다.</b>");
});

module.exports = { sendMessage, readWatchlist };