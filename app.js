require('dotenv').config();
const cron = require('node-cron');
const { sendMessage, readWatchlist } = require('./src/utils/telegram');
const { getValidToken } = require('./src/api/tokenManager');
const { getCurrentPrice, getHistoricalData, getAvailableCash, executeOrder, getCurrentHoldings } = require('./src/api/kisApi');
const { analyzeSignal } = require('./src/strategy/algorithm');

// KIS API 속도 제한 방지를 위한 딜레이 함수 (예: 1000 = 1초 대기)
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 관심종목 전체를 스캔하는 메인 함수
 */
const runScanner = async (market) => {
  console.log(`\n🤖 [${market} 스캐너 가동] 분석을 시작합니다...`);

  try {
    await getValidToken();

    const watchlistObj = readWatchlist();
    const marketWatchlist = watchlistObj[market] || {};

    if (Object.keys(marketWatchlist).length === 0) {
      console.log(`📋 ${market} 감시 종목이 없습니다.`);
      return;
    }

    // 💡 [핵심 방어막] 스캔 시작 전, 현재 내 계좌에 있는 종목들을 싹 가져옵니다.
    const holdingsMap = await getCurrentHoldings(market);
    console.log(`💼 현재 [${market}] 보유 종목 수: ${Object.keys(holdingsMap).length}개`);

    for (const [ticker, weight] of Object.entries(marketWatchlist)) {
      try {
        const ohlcvData = await getHistoricalData(ticker, market);
        const signal = analyzeSignal(ohlcvData);

        if (signal !== 'HOLD') {
          const currentPrice = await getCurrentPrice(ticker, market);
          const currency = market === 'KR' ? '원' : '달러';
          const priceStr = currentPrice.toLocaleString() + currency;

          // 📢 1. 조건에 들어온 관심 종목 보고
          const directionTxt = signal === 'BUY' ? '🟢 매수' : '🔴 매도';
          await sendMessage(`🔍 <b>[시그널 포착]</b>\n- 종목: <code>${ticker}</code>\n- 방향: ${directionTxt}\n- 현재가: ${priceStr}`);

          // 🛒 매수 프로세스
          if (signal === 'BUY') {
            if (holdingsMap[ticker]) {
              await sendMessage(`🛡️ <b>[매수 보류]</b> 이미 보유 중인 종목입니다. (중복 매수 방지)`);
              continue;
            }

            const availableCash = await getAvailableCash(market);
            const targetAmount = Math.floor(availableCash * (weight / 100));
            const targetQuantity = Math.floor(targetAmount / currentPrice);

            if (targetQuantity > 0) {
              try {
                // 매수 API 발사!
                await executeOrder(ticker, targetQuantity, currentPrice, market, 'BUY');

                // 📢 2. 매수 성공 보고
                await sendMessage(`✅ <b>[매수 체결 완료]</b>\n- 종목: <code>${ticker}</code>\n- 주문수량: ${targetQuantity}주\n- 소요금액: 약 ${targetAmount.toLocaleString()}${currency}\n- 설정비중: ${weight}%`);
              } catch (err) {
                // 📢 2. 매수 실패 보고
                await sendMessage(`❌ <b>[매수 주문 실패]</b>\n- 종목: <code>${ticker}</code>\n- 사유: <code>${err.message}</code>`);
              }
            } else {
              await sendMessage(`⚠️ <b>[매수 보류]</b> 가용 현금 부족 (목표: ${targetAmount.toLocaleString()}${currency} / 현재가: ${priceStr})`);
            }
          }

          // 🛒 매도 프로세스
          else if (signal === 'SELL') {
            const holdingQty = holdingsMap[ticker];

            if (!holdingQty) {
              await sendMessage(`🛡️ <b>[매도 보류]</b> 현재 보유하고 있지 않은 종목입니다. (공매도 방지)`);
              continue;
            }

            try {
              // 매도 API 발사 (전량 청산)
              await executeOrder(ticker, holdingQty, currentPrice, market, 'SELL');

              // 📢 3. 매도 성공 보고
              await sendMessage(`✅ <b>[매도 체결 완료]</b>\n- 종목: <code>${ticker}</code>\n- 매도수량: ${holdingQty}주 (전량)\n- 체결단가: ${priceStr}`);
            } catch (err) {
              // 📢 3. 매도 실패 보고
              await sendMessage(`❌ <b>[매도 주문 실패]</b>\n- 종목: <code>${ticker}</code>\n- 사유: <code>${err.message}</code>`);
            }
          }
        }
      } catch (error) {
        console.error(`❌ [${ticker}] 분석 중 에러:`, error.message);
      }

      await sleep(1000); // 1초 대기 (API Rate Limit 방어)
    }

    if (hasSignal) {
      await sendMessage(reportMsg);
    }

  } catch (error) {
    console.error(`🚨 ${market} 스캐너 에러:`, error.message);
  }
};

// ==========================================
// ⏱️ 크론(Cron) 스케줄러 세팅 (심장 부착)
// ==========================================

console.log('🤖 자동매매 봇 서버가 시작되었습니다.');

// 🇰🇷 한국 시장 (평일 09:05 ~ 15:15) - 30분 단위 스캔
cron.schedule('5,35 9-14 * * 1-5', () => runScanner('KR'), { timezone: 'Asia/Seoul' });
cron.schedule('15 15 * * 1-5', () => runScanner('KR'), { timezone: 'Asia/Seoul' }); // 마감 동시호가 전

// 🇺🇸 미국 시장 (평일 23:35 ~ 익일 05:35) - 서머타임 해제 기준 30분 단위 스캔
// (23시, 0시, 1시, 2시, 3시, 4시, 5시 스캔)
cron.schedule('35 23,0-5 * * 1-5', () => runScanner('US'), { timezone: 'Asia/Seoul' });