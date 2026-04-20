require('dotenv').config();
const cron = require('node-cron');
const { bot, myChatId, sendMessage, readWatchlist } = require('./src/utils/telegram');
const { getValidToken } = require('./src/api/tokenManager');
const { getCurrentPrice, getHistoricalData, getAvailableCash, executeOrder, getCurrentHoldings } = require('./src/api/kisApi');
const { analyzeSignal } = require('./src/strategy/algorithm');

// KIS API 속도 제한 방지를 위한 딜레이 함수
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 관심종목 전체를 스캔하는 메인 함수
 */
const runScanner = async (market) => {
  console.log(`\n🤖 [${market} 스캐너 가동] ${new Date().toLocaleString()} 분석 시작...`);

  try {
    // 1. 토큰 유효성 체크 및 갱신
    await getValidToken();

    const watchlistObj = readWatchlist();
    const marketWatchlist = watchlistObj[market] || {};

    if (Object.keys(marketWatchlist).length === 0) {
      console.log(`📋 ${market} 감시 종목이 없습니다.`);
      return;
    }

    // 2. 현재 계좌 잔고 및 보유 종목 수량 가져오기
    const holdingsMap = await getCurrentHoldings(market);
    console.log(`💼 현재 [${market}] 보유 종목 수: ${Object.keys(holdingsMap).length}개`);

    const foundSignals = []; // 회차 요약 보고용 배열

    for (const [ticker, weight] of Object.entries(marketWatchlist)) {
      try {
        // 3. 데이터 분석 및 시그널 확인
        const ohlcvData = await getHistoricalData(ticker, market);
        const signal = analyzeSignal(ohlcvData);

        if (signal !== 'HOLD') {
          const currentPrice = await getCurrentPrice(ticker, market);
          const currency = market === 'KR' ? '원' : '달러';
          const priceStr = currentPrice.toLocaleString() + currency;
          const directionTxt = signal === 'BUY' ? '🟢 매수' : '🔴 매도';

          // 📢 [알림 1] 시그널 포착 보고 (요약용 배열에도 저장)
          foundSignals.push(`${directionTxt} <code>${ticker}</code>`);
          await sendMessage(`🔍 <b>[시그널 포착]</b>\n- 종목: <code>${ticker}</code>\n- 방향: ${directionTxt}\n- 현재가: ${priceStr}`);

          // 🛒 매수 프로세스
          if (signal === 'BUY') {
            if (holdingsMap[ticker]) {
              await sendMessage(`🛡️ <b>[매수 보류]</b> <code>${ticker}</code> - 이미 보유 중입니다.`);
              continue;
            }

            const availableCash = await getAvailableCash(market);
            const targetAmount = Math.floor(availableCash * (weight / 100));
            const targetQuantity = Math.floor(targetAmount / currentPrice);

            if (targetQuantity > 0) {
              try {
                await executeOrder(ticker, targetQuantity, currentPrice, market, 'BUY');
                // 📢 [알림 2] 매수 성공 보고
                await sendMessage(`✅ <b>[매수 체결 완료]</b>\n- 종목: <code>${ticker}</code>\n- 수량: ${targetQuantity}주\n- 비중: ${weight}%`);
              } catch (err) {
                // 📢 [알림 2] 매수 실패 보고
                await sendMessage(`❌ <b>[매수 주문 실패]</b>\n- 종목: <code>${ticker}</code>\n- 사유: <code>${err.message}</code>`);
              }
            } else {
              await sendMessage(`⚠️ <b>[매수 보류]</b> 예수금 부족 (목표: ${targetAmount.toLocaleString()}${currency})`);
            }
          }

          // 🛒 매도 프로세스
          else if (signal === 'SELL') {
            const holdingQty = holdingsMap[ticker];

            if (!holdingQty) {
              await sendMessage(`🛡️ <b>[매도 보류]</b> <code>${ticker}</code> - 보유 수량 없음`);
              continue;
            }

            try {
              await executeOrder(ticker, holdingQty, currentPrice, market, 'SELL');
              // 📢 [알림 3] 매도 성공 보고
              await sendMessage(`✅ <b>[매도 체결 완료]</b>\n- 종목: <code>${ticker}</code>\n- 수량: ${holdingQty}주 (전량)`);
            } catch (err) {
              // 📢 [알림 3] 매도 실패 보고
              await sendMessage(`❌ <b>[매도 주문 실패]</b>\n- 종목: <code>${ticker}</code>\n- 사유: <code>${err.message}</code>`);
            }
          }
        }
      } catch (error) {
        console.error(`❌ [${ticker}] 분석 중 에러:`, error.message);
      }

      await sleep(1000); // API 과부하 방지
    }

    // 📢 [알림 4] 회차 요약 보고 (발견된 시그널이 있을 때만)
    if (foundSignals.length > 0) {
      const reportMsg = `🕒 <b>[${market}] 스캔 요약 보고</b>\n\n${foundSignals.join('\n')}\n\n위 종목들에 대해 자동 대응을 완료했습니다.`;
      await sendMessage(reportMsg);
    }

  } catch (error) {
    console.error(`🚨 ${market} 스캐너 치명적 에러:`, error.message);
  }
};

// ==========================================
//  💡 수동 스캔 명령어 (/scan)
//  사용자가 텔레그램에서 /scan을 입력하면 즉시 실행
// ==========================================
bot.onText(/\/scan/i, async (msg) => {
  // 본인 확인 (보안)
  if (String(msg.chat.id) !== myChatId) return;

  await sendMessage("🚀 <b>수동 스캔 요청 포착!</b>\n전체 종목 분석을 즉시 시작합니다.");

  // 국장/미장 순차 실행
  await runScanner('KR');
  await runScanner('US');

  await sendMessage("🏁 <b>수동 스캔 및 매매 처리가 완료되었습니다.</b>");
});

// ==========================================
// ⏱️ 크론(Cron) 스케줄러 세팅
// ==========================================

console.log('🤖 자동매매 봇 서버가 시작되었습니다.');

// 🇰🇷 한국 시장 (평일 09:05 ~ 15:15) - 30분 단위
cron.schedule('5,35 9-14 * * 1-5', () => runScanner('KR'), { timezone: 'Asia/Seoul' });
cron.schedule('15 15 * * 1-5', () => runScanner('KR'), { timezone: 'Asia/Seoul' });

// 🇺🇸 미국 시장 (서머타임 미고려 기준 23:35 ~ 05:35)
cron.schedule('35 23,0-5 * * 1-5', () => runScanner('US'), { timezone: 'Asia/Seoul' });