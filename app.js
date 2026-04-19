require('dotenv').config();
const cron = require('node-cron');
const { sendMessage, readWatchlist } = require('./src/utils/telegram');
const { getValidToken } = require('./src/api/tokenManager');
const { getCurrentPrice, getHistoricalData } = require('./src/api/kisApi');
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
    const watchlist = watchlistObj[market] || [];

    if (watchlist.length === 0) {
      console.log(`📋 ${market} 감시 종목이 없습니다.`);
      return;
    }

    let hasSignal = false;
    let reportMsg = `🤖 [${market} 알고리즘 스캔 결과]\n\n`;

    for (const ticker of watchlist) {
      console.log(`\n🔍 [${market}] ${ticker} 분석 중...`);

      try {
        // ⚠️ 주의: 다음 스텝에서 getHistoricalData 내부 로직을 US 대응으로 수정해야 합니다!
        const ohlcvData = await getHistoricalData(ticker, market);
        const signal = analyzeSignal(ohlcvData);

        if (signal !== 'HOLD') {
          hasSignal = true;
          // ⚠️ 현재가 조회도 US 대응으로 수정 필요
          const currentPrice = await getCurrentPrice(ticker, market);
          const icon = signal === 'BUY' ? '🟢 매수' : '🔴 매도';
          reportMsg += `${icon} 시그널: ${ticker} (현재가: ${currentPrice})\n`;
        }
      } catch (error) {
        console.error(`❌ [${ticker}] 에러:`, error.message);
      }

      await sleep(1000); // 1초 대기
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