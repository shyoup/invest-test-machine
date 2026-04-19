require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const token = process.env.TELEGRAM_TOKEN;
const myChatId = process.env.TELEGRAM_CHAT_ID;
const WATCHLIST_PATH = path.join(__dirname, '../../watchlist.json');

// 1. Polling을 true로 켜서 메시지 수신 대기 상태로 만듭니다.
let bot;
if (token) {
  bot = new TelegramBot(token, { polling: true });
  console.log('📡 텔레그램 Admin 수신 대기 중...');
}

// 기존의 알림 전송 함수 (유지)
const sendMessage = async (message) => {
  if (!bot || !myChatId) return;
  try {
    await bot.sendMessage(myChatId, message);
  } catch (error) {
    console.error('텔레그램 전송 실패:', error.message);
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

// 💡 명령어 1: /add [시장] [종목코드] [비중%] (예: /add KR 005930 10)
bot.onText(/\/add (KR|US) ([A-Za-z0-9]+) (\d+)/i, (msg, match) => {
  if (String(msg.chat.id) !== myChatId) return;

  const market = match[1].toUpperCase();
  const ticker = match[2].trim().toUpperCase();
  const weight = Number(match[3]); // 비중 추가

  const listObj = readWatchlist();

  // 비중이 1~100 사이인지 검증
  if (weight < 1 || weight > 100) {
    bot.sendMessage(myChatId, `⚠️ 비중은 1부터 100 사이의 숫자로 입력해 주세요.`);
    return;
  }

  // 객체 프로퍼티로 할당 (이미 있으면 비중 덮어쓰기)
  const isUpdate = listObj[market][ticker] !== undefined;
  listObj[market][ticker] = weight;

  writeWatchlist(listObj);
  const actionText = isUpdate ? '비중 수정' : '추가';
  bot.sendMessage(myChatId, `✅ [${market}] ${actionText} 완료: ${ticker} (목표비중: ${weight}%)`);
});

// 💡 명령어 2: /del [시장] [종목코드] (예: /del KR 005930)
bot.onText(/\/del (KR|US) ([A-Za-z0-9]+)/i, (msg, match) => {
  if (String(msg.chat.id) !== myChatId) return;

  const market = match[1].toUpperCase();
  const ticker = match[2].trim().toUpperCase();
  const listObj = readWatchlist();

  if (listObj[market][ticker] === undefined) {
    bot.sendMessage(myChatId, `⚠️ ${market} 리스트에 없는 종목입니다: ${ticker}`);
    return;
  }

  delete listObj[market][ticker]; // 객체에서 키 삭제
  writeWatchlist(listObj);
  bot.sendMessage(myChatId, `🗑️ [${market}] 삭제 완료: ${ticker}`);
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

// 명령어 4: /guide
bot.onText(/\/guide/, (msg) => {
  if (String(msg.chat.id) !== myChatId) return;

  const guideText = `
🤖 **글로벌 자동매매 봇 사용 가이드**

✅ **종목 추가 및 비중 설정**
- 국장: \`/add KR 종목코드 비중(%)\` (예: \`/add KR 005930 10\`)
- 미장: \`/add US 티커 비중(%)\` (예: \`/add US NVDA 15\`)
* 💡 이미 등록된 종목을 다시 입력하면 새로운 비중으로 덮어쓰기(수정) 됩니다.

🗑️ **종목 삭제**
- 국장: \`/del KR 종목코드\` (예: \`/del KR 005930\`)
- 미장: \`/del US 티커\` (예: \`/del US NVDA\`)

📋 **리스트 확인**
- \`/list\` : 현재 감시 중인 모든 종목과 설정 비중(%) 출력

💡 **팁**
- 비중은 1~100 사이의 정수로만 입력해 주세요.
- 미장 티커는 대소문자를 구분하지 않습니다.
- 국장 스캐너는 평일 주간에, 미장 스캐너는 평일 야간에 자동 가동됩니다.
  `;

  bot.sendMessage(myChatId, guideText, { parse_mode: 'Markdown' });
});

module.exports = { sendMessage, readWatchlist };