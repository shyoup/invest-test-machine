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
  const defaultStructure = { KR: [], US: [] };
  try {
    if (!fs.existsSync(WATCHLIST_PATH)) return defaultStructure;

    const data = fs.readFileSync(WATCHLIST_PATH, 'utf8');

    // 파일 내용이 비어있는 경우 대응
    if (!data.trim()) return defaultStructure;

    const parsed = JSON.parse(data);

    // 데이터 구조가 올바른지 확인 (배열인지 체크)
    return {
      KR: Array.isArray(parsed.KR) ? parsed.KR : [],
      US: Array.isArray(parsed.US) ? parsed.US : []
    };
  } catch (e) {
    console.error('⚠️ watchlist.json 파싱 에러! 기본값으로 복구합니다.', e.message);
    // 에러 발생 시 기존 파일을 백업하고 기본값 반환
    if (fs.existsSync(WATCHLIST_PATH)) {
      fs.renameSync(WATCHLIST_PATH, `${WATCHLIST_PATH}.bak_${Date.now()}`);
    }
    return defaultStructure;
  }
};

// 유틸: 관심종목 파일 쓰기
const writeWatchlist = (list) => {
  fs.writeFileSync(WATCHLIST_PATH, JSON.stringify(list, null, 2), 'utf8');
};

// 명령어 1: /add [시장] [종목코드] (예: /add US TSLA)
bot.onText(/\/add (KR|US) (.+)/i, (msg, match) => {
  if (String(msg.chat.id) !== myChatId) return;

  const market = match[1].toUpperCase();
  const ticker = match[2].trim().toUpperCase();
  const listObj = readWatchlist();

  // 혹시 파일이 예전 배열 구조라면 초기화
  if (Array.isArray(listObj)) {
    listObj = { KR: [], US: [] };
  }

  if (listObj[market].includes(ticker)) {
    bot.sendMessage(myChatId, `⚠️ 이미 ${market} 시장에 등록된 종목입니다: ${ticker}`);
    return;
  }

  listObj[market].push(ticker);
  writeWatchlist(listObj);
  bot.sendMessage(myChatId, `✅ [${market}] 관심종목 추가 완료: ${ticker}`);
});

// 명령어 2: /del [시장] [종목코드]
bot.onText(/\/del (KR|US) (.+)/i, (msg, match) => {
  if (String(msg.chat.id) !== myChatId) return;

  const market = match[1].toUpperCase();
  const ticker = match[2].trim().toUpperCase();
  const listObj = readWatchlist();

  if (!listObj[market].includes(ticker)) {
    bot.sendMessage(myChatId, `⚠️ ${market} 리스트에 없는 종목입니다: ${ticker}`);
    return;
  }

  listObj[market] = listObj[market].filter((item) => item !== ticker);
  writeWatchlist(listObj);
  bot.sendMessage(myChatId, `🗑️ [${market}] 관심종목 삭제 완료: ${ticker}`);
});

// 명령어 3: /list
bot.onText(/\/list/, (msg) => {
  if (String(msg.chat.id) !== myChatId) return;

  const listObj = readWatchlist();
  const krList = listObj.KR ? listObj.KR.join(', ') : '없음';
  const usList = listObj.US ? listObj.US.join(', ') : '없음';

  bot.sendMessage(myChatId, `📋 [현재 감시 중인 종목]\n🇰🇷 국장: ${krList}\n🇺🇸 미장: ${usList}`);
});

// 명령어 4: /guide
bot.onText(/\/guide/, (msg) => {
  if (String(msg.chat.id) !== myChatId) return;

  const guideText = `
🤖 **글로벌 자동매매 봇 사용 가이드**

✅ **종목 추가**
- 국장: \`/add KR 종목코드\` (예: \`/add KR 005930\`)
- 미장: \`/add US 티커\` (예: \`/add US NVDA\`)

🗑️ **종목 삭제**
- 국장: \`/del KR 종목코드\`
- 미장: \`/del US 티커\`

📋 **리스트 확인**
- \`/list\` : 현재 감시 중인 모든 종목 출력

💡 **팁**
- 미장 티커는 대소문자를 구분하지 않습니다.
- 국장 스캐너는 평일 주간에, 미장 스캐너는 평일 야간에 자동 가동됩니다.
    `;

  bot.sendMessage(myChatId, guideText, { parse_mode: 'Markdown' });
});

module.exports = { sendMessage, readWatchlist };