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
    const currentHoldings = await getCurrentHoldings(market);
    console.log(`💼 현재 [${market}] 보유 종목: ${currentHoldings.length > 0 ? currentHoldings.join(', ') : '없음'}`);

    let hasSignal = false;
    let reportMsg = `🤖 [${market} 알고리즘 스캔 결과]\n\n`;

    for (const [ticker, weight] of Object.entries(marketWatchlist)) {
      console.log(`\n🔍 [${market}] ${ticker} (설정비중: ${weight}%) 분석 중...`);

      try {
        const ohlcvData = await getHistoricalData(ticker, market);
        const signal = analyzeSignal(ohlcvData);

        if (signal !== 'HOLD') {
          const currentPrice = await getCurrentPrice(ticker, market);
          let orderInfoText = '';
          let isExecute = false; // 실제 주문을 넣을지 결정하는 플래그

          if (signal === 'BUY') {
            // 🛡️ 중복 매수 방어 로직
            if (currentHoldings.includes(ticker)) {
              orderInfoText = `\n  - 🛡️ 방어 로직 작동: 이미 보유 중인 종목이므로 추가 매수를 패스합니다.`;
              console.log(`[PASS] ${ticker} 이미 보유 중`);
            } else {
              // 보유하고 있지 않다면 정상적으로 매수 프로세스 진행
              const availableCash = await getAvailableCash(market);
              const targetAmount = Math.floor(availableCash * (weight / 100));
              const targetQuantity = Math.floor(targetAmount / currentPrice);
              const currency = market === 'KR' ? '원' : '달러';

              orderInfoText = `\n  - 💰 가용 현금: ${availableCash.toLocaleString()}${currency}` +
                `\n  - 🎯 투자 비중: ${weight}% (${targetAmount.toLocaleString()}${currency})` +
                `\n  - 🛒 매수 목표 수량: ${targetQuantity}주`;

              if (targetQuantity > 0) {
                isExecute = true; // 주문 실행 승인!
              } else {
                orderInfoText += `\n  - ⚠️ 주문 보류: 현금 부족 (1주 미만)`;
              }
            }
          } else if (signal === 'SELL') {
            // 🛡️ 공매도(없는 주식 팔기) 방어 로직
            if (!currentHoldings.includes(ticker)) {
              orderInfoText = `\n  - 🛡️ 방어 로직 작동: 보유하고 있지 않은 종목이므로 매도를 패스합니다.`;
            } else {
              orderInfoText = `\n  - 🛒 매도 시그널 감지 (수동 매도 요망 또는 추후 매도 로직 연동 필요)`;
              // 💡 매도 주문 로직은 나중에 executeOrder(ticker, 매도수량, currentPrice, market, 'SELL') 로 연결할 수 있습니다.
            }
          }

          const icon = signal === 'BUY' ? '🟢 매수' : '🔴 매도';
          reportMsg += `${icon} 시그널: ${ticker} (현재가: ${currentPrice})${orderInfoText}\n\n`;
          hasSignal = true;

          // 승인된 주문만 실제로 발사!
          if (isExecute) {
            try {
              // 앞에서 계산한 targetQuantity를 넘겨주기 위해 변수 스코프를 위로 빼거나 다시 계산 (여기선 편의상 생략된 부분을 채워주세요)
              const availableCash = await getAvailableCash(market);
              const targetQuantity = Math.floor((availableCash * (weight / 100)) / currentPrice);

              await executeOrder(ticker, targetQuantity, currentPrice, market, 'BUY');
              reportMsg += `  - 🚀 주문 상태: 성공 (체결 대기)\n`;
            } catch (orderErr) {
              reportMsg += `  - ❌ 주문 실패: ${orderErr.message}\n`;
            }
          }
        }
      } catch (error) {
        console.error(`❌ [${ticker}] 에러:`, error.message);
      }

      await sleep(1000);
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