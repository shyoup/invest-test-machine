require('dotenv').config();
const cron = require('node-cron');
const { bot, myChatId, sendMessage, readWatchlist } = require('./src/utils/telegram');
const { getValidToken } = require('./src/api/tokenManager');
const { getCurrentPrice, getHistoricalData, getAvailableCash, executeOrder, getCurrentHoldings } = require('./src/api/kisApi');
const { analyzeSignal } = require('./src/strategy/algorithm');
const { analyzeVBSignal, clearDailyCache, readVBPositions, recordVBBuy, removeVBPosition } = require('./src/strategy/volatilityBreakout');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ─────────────────────────────────────────
// 미국 서머타임(DST) / 시장 개장 여부 판별
// Node.js 내장 Intl API 활용 — 외부 라이브러리 불필요
// DST 일정은 법으로 고정: 3월 두 번째 일요일 ~ 11월 첫 번째 일요일
// ─────────────────────────────────────────
const getETTimeParts = (date = new Date()) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZoneName: 'short',
  }).formatToParts(date);

// EDT = 서머타임 적용 중 / EST = 표준시
const isUSDST = () =>
  getETTimeParts().find(p => p.type === 'timeZoneName')?.value === 'EDT';

// NYSE/NASDAQ 정규장: ET 기준 09:30 ~ 16:00 (평일)
const isUSMarketOpen = () => {
  const parts = getETTimeParts();
  const get = (t) => parts.find(p => p.type === t)?.value;
  if (get('weekday') === 'Sat' || get('weekday') === 'Sun') return false;
  const totalMin = parseInt(get('hour') || '0', 10) * 60 + parseInt(get('minute') || '0', 10);
  return totalMin >= 9 * 60 + 30 && totalMin < 16 * 60;
};

// ─────────────────────────────────────────
// 공통 헬퍼: 매수 주문 실행
// ─────────────────────────────────────────
const executeBuy = async (ticker, weight, currentPrice, market, strategyTag) => {
  const currency = market === 'KR' ? '원' : '달러';
  const availableCash = await getAvailableCash(market);
  const targetAmount = Math.floor(availableCash * (weight / 100));
  let qty = Math.floor(targetAmount / currentPrice);

  if (qty === 0 && availableCash >= currentPrice) {
    qty = 1;
    await sendMessage(`ℹ️ <b>[비중 조정]</b> <code>${ticker}</code> — 비중(${weight}%) 적용금액 ${targetAmount.toLocaleString()}${currency}으로 1주 미만\n→ 최소 1주로 매수합니다.`);
  }

  if (qty <= 0) {
    await sendMessage(`⚠️ <b>[매수 보류]</b> <code>${ticker}</code> — 예수금 ${availableCash.toLocaleString()}${currency}으로 1주(${currentPrice.toLocaleString()}${currency}) 매수 불가`);
    return 0;
  }

  try {
    await executeOrder(ticker, qty, currentPrice, market, 'BUY');
    await sendMessage(`✅ <b>[${strategyTag} 매수 완료]</b>\n- 종목: <code>${ticker}</code>\n- 수량: ${qty}주\n- 비중: ${weight}%`);
    return qty;
  } catch (err) {
    await sendMessage(`❌ <b>[${strategyTag} 매수 실패]</b>\n- 종목: <code>${ticker}</code>\n- 사유: <code>${err.message}</code>`);
    return 0;
  }
};

// ─────────────────────────────────────────
// VB 전략 전용: 아침 청산 (매일 09:01 KST)
// ─────────────────────────────────────────
const sellVBPositions = async () => {
  console.log('\n🌅 [VB 아침 청산] 시작...');
  const positions = readVBPositions();
  const tickers = Object.keys(positions);

  if (tickers.length === 0) {
    console.log('📋 [VB 아침 청산] 보유 VB 종목 없음');
    return;
  }

  await getValidToken();
  await sendMessage(`🌅 <b>[VB 전략 아침 청산]</b> ${tickers.length}개 종목 청산 시작`);

  const holdingsMap = await getCurrentHoldings('KR');

  for (const ticker of tickers) {
    const holdingQty = holdingsMap[ticker];
    if (!holdingQty) {
      console.log(`[VB 청산] ${ticker} — 이미 보유 없음, 기록만 삭제`);
      removeVBPosition(ticker);
      continue;
    }

    try {
      await executeOrder(ticker, holdingQty, 0, 'KR', 'SELL');
      await sendMessage(`✅ <b>[VB 청산 완료]</b> <code>${ticker}</code> ${holdingQty}주 전량 매도`);
    } catch (err) {
      await sendMessage(`❌ <b>[VB 청산 실패]</b> <code>${ticker}</code> — <code>${err.message}</code>`);
    }
    removeVBPosition(ticker);
    await sleep(1000);
  }
};

// ─────────────────────────────────────────
// 메인 스캐너
// ─────────────────────────────────────────
const runScanner = async (market) => {
  console.log(`\n🤖 [${market} 스캐너 가동] ${new Date().toLocaleString()} 분석 시작...`);

  // 미장은 개장 시간 외 스캔 방지
  if (market === 'US' && !isUSMarketOpen()) {
    console.log(`🇺🇸 미국 시장 미개장 시간 — 스캔 건너뜀 (DST: ${isUSDST() ? 'ON(EDT)' : 'OFF(EST)'})`);
    return;
  }

  try {
    await getValidToken();

    const watchlistObj = readWatchlist();
    const marketWatchlist = watchlistObj[market] || {};

    if (Object.keys(marketWatchlist).length === 0) {
      console.log(`📋 ${market} 감시 종목이 없습니다.`);
      return;
    }

    const holdingsMap = await getCurrentHoldings(market);
    console.log(`💼 현재 [${market}] 보유 종목 수: ${Object.keys(holdingsMap).length}개`);

    const foundSignals = [];

    for (const [ticker, weight] of Object.entries(marketWatchlist)) {
      try {
        const ohlcvData = await getHistoricalData(ticker, market);

        // ══════════════════════════════════════
        // 전략 1: 일목균형표
        // ══════════════════════════════════════
        const ichimokuSignal = analyzeSignal(ohlcvData, ticker);

        if (ichimokuSignal.state === 'BUY') {
          const currentPrice = await getCurrentPrice(ticker, market);
          const currency = market === 'KR' ? '원' : '달러';
          foundSignals.push(`🟢 일목매수 <code>${ticker}</code>`);
          await sendMessage(`🔍 <b>[일목균형표 매수 시그널]</b>\n- 종목: <code>${ticker}</code>\n- 현재가: ${currentPrice.toLocaleString()}${currency}`);

          if (holdingsMap[ticker]) {
            await sendMessage(`🛡️ <b>[매수 보류]</b> <code>${ticker}</code> — 이미 보유 중`);
          } else {
            await executeBuy(ticker, weight, currentPrice, market, '일목');
          }

        } else if (ichimokuSignal.state === 'SELL') {
          const currentPrice = await getCurrentPrice(ticker, market);
          const currency = market === 'KR' ? '원' : '달러';
          const holdingQty = holdingsMap[ticker];
          foundSignals.push(`🔴 일목매도 <code>${ticker}</code>`);
          await sendMessage(`🔍 <b>[일목균형표 매도 시그널]</b>\n- 종목: <code>${ticker}</code>\n- 현재가: ${currentPrice.toLocaleString()}${currency}`);

          if (!holdingQty) {
            await sendMessage(`🛡️ <b>[매도 보류]</b> <code>${ticker}</code> — 보유 수량 없음`);
          } else {
            try {
              await executeOrder(ticker, holdingQty, currentPrice, market, 'SELL');
              removeVBPosition(ticker); // VB 포지션 기록도 함께 정리
              await sendMessage(`✅ <b>[일목 매도 완료]</b>\n- 종목: <code>${ticker}</code>\n- 수량: ${holdingQty}주 전량`);
            } catch (err) {
              await sendMessage(`❌ <b>[일목 매도 실패]</b>\n- 종목: <code>${ticker}</code>\n- 사유: <code>${err.message}</code>`);
            }
          }

        } else {
          // HOLD — 디버그 로그는 analyzeSignal 내부에서 출력됨

          // ══════════════════════════════════════
          // 전략 2: 변동성 돌파 (KR 전용, 미보유 종목만)
          // ══════════════════════════════════════
          if (market === 'KR' && !holdingsMap[ticker]) {
            const currentPrice = await getCurrentPrice(ticker, market);
            const vbSignal = analyzeVBSignal(ticker, ohlcvData, currentPrice);

            if (vbSignal.state === 'BUY') {
              foundSignals.push(`🟡 VB매수 <code>${ticker}</code>`);
              await sendMessage(`🔍 <b>[변동성 돌파 매수 시그널]</b>\n- 종목: <code>${ticker}</code>\n- ${vbSignal.info}`);
              const qty = await executeBuy(ticker, weight, currentPrice, market, 'VB');
              if (qty > 0) recordVBBuy(ticker, qty);
            }
          }
        }

      } catch (error) {
        console.error(`❌ [${ticker}] 분석 중 에러:`, error.message);
      }

      await sleep(1000);
    }

    if (foundSignals.length > 0) {
      await sendMessage(`🕒 <b>[${market}] 스캔 요약</b>\n\n${foundSignals.join('\n')}\n\n자동 대응 완료`);
    }

  } catch (error) {
    console.error(`🚨 ${market} 스캐너 치명적 에러:`, error.message);
  }
};

// ─────────────────────────────────────────
// 수동 스캔 명령어 (/scan)
// ─────────────────────────────────────────
bot.onText(/\/scan/i, async (msg) => {
  if (String(msg.chat.id) !== myChatId) return;
  await sendMessage('🚀 <b>수동 스캔 요청 포착!</b>\n전체 종목 분석을 즉시 시작합니다.');
  await runScanner('KR');
  await runScanner('US');
  await sendMessage('🏁 <b>수동 스캔 및 매매 처리가 완료되었습니다.</b>');
});

// ─────────────────────────────────────────
// 크론 스케줄
// ─────────────────────────────────────────
console.log('🤖 자동매매 봇 서버가 시작되었습니다.');
console.log(`🕐 현재 미국 시간대: ${isUSDST() ? 'EDT (서머타임 적용 중)' : 'EST (표준시)'} | 시장 개장: ${isUSMarketOpen() ? '✅ 개장 중' : '❌ 미개장'}`);

// 🇰🇷 VB 전략 준비: 08:55 캐시 초기화 → 09:01 VB 포지션 아침 청산
cron.schedule('55 8 * * 1-5', () => clearDailyCache(), { timezone: 'Asia/Seoul' });
cron.schedule('1 9 * * 1-5', () => sellVBPositions(), { timezone: 'Asia/Seoul' });

// 🇰🇷 한국 시장 (평일 09:05 ~ 15:15) — 30분 단위
cron.schedule('5,35 9-14 * * 1-5', () => runScanner('KR'), { timezone: 'Asia/Seoul' });
cron.schedule('15 15 * * 1-5', () => runScanner('KR'), { timezone: 'Asia/Seoul' });

// 🇺🇸 미국 시장 — 서머타임(22:30 KST 개장)·표준시(23:30 KST 개장) 모두 커버
// isUSMarketOpen() 체크로 미개장 시간 자동 필터링되므로 크론은 넓게 설정
cron.schedule('35 22,23,0-6 * * 1-5', () => runScanner('US'), { timezone: 'Asia/Seoul' });
