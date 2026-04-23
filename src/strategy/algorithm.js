const { RSI, IchimokuCloud } = require('technicalindicators');

/**
 * 1. RSI 계산 함수
 * @param {number[]} closePrices - 종가 배열
 * @param {number} period - 기본값 14
 * @returns {number} 현재(최신) RSI 값
 */
const getLatestRSI = (closePrices, period = 14) => {
  const rsiInput = { values: closePrices, period };
  const rsiResult = RSI.calculate(rsiInput);

  // 가장 마지막(최신) RSI 값을 반환
  return rsiResult[rsiResult.length - 1];
};

/**
 * 2. 일목균형표 계산 함수
 * @param {number[]} highPrices - 고가 배열
 * @param {number[]} lowPrices - 저가 배열
 * @returns {Object} 최신 일목균형표 데이터 { conversion, base, spanA, spanB }
 */
const getLatestIchimoku = (highPrices, lowPrices) => {
  const ichimokuInput = {
    high: highPrices,
    low: lowPrices,
    conversionPeriod: 9,
    basePeriod: 26,
    spanPeriod: 52,
    displacement: 26,
  };
  const ichimokuResult = IchimokuCloud.calculate(ichimokuInput);

  // 가장 마지막(최신) 지표 반환
  return ichimokuResult[ichimokuResult.length - 1];
};

/**
 * 3. 최종 매매 시그널 판별 함수 (핵심 로직)
 * @param {Array} ohlcvData - [{ open, high, low, close, volume }, ...] 형태의 과거 데이터 배열
 * @returns {string} 'BUY' | 'SELL' | 'HOLD'
 */
const analyzeSignal = (ohlcvData, ticker) => {
  // 데이터 파싱
  const highs = ohlcvData.map((d) => d.high);
  const lows = ohlcvData.map((d) => d.low);
  const closes = ohlcvData.map((d) => d.close);

  const currentPrice = closes[closes.length - 1];
  const laggingSpanPrice = closes[closes.length - 1]; // 후행스팬 (현재가)
  const price26DaysAgo = closes[closes.length - 26]; // 26일 전 종가 (후행스팬 비교용)

  // 지표 계산
  const rsi = getLatestRSI(closes);
  const ichimoku = getLatestIchimoku(highs, lows);

  if (rsi == null || !ichimoku) return { state: 'HOLD', message: `⏸️ [${ticker}] 데이터 부족 — HOLD` };

  const cloudTop = Math.max(ichimoku.spanA, ichimoku.spanB);
  const cloudBottom = Math.min(ichimoku.spanA, ichimoku.spanB);

  // [로직 디버깅용 로그] - 실제 운영 시에는 주석 처리해도 됩니다.
  const resultLog = `📊 종목명: ${ticker} | 현재가: ${currentPrice} | RSI: ${rsi.toFixed(2)} | 구름대상단: ${cloudTop} | 전환선: ${ichimoku.conversion}`;
  console.log(resultLog);

  // ==========================================
  // 🟢 매수 조건 (Buy Signal)
  // 1. 현재가가 구름대 상단을 돌파하여 위에 있을 것
  // 2. 후행스팬(현재가)이 26일 전 주가보다 위에 있을 것
  // 3. RSI가 70 미만일 것 (과매수 상태가 아닐 것)
  // ==========================================
  const isAboveCloud = currentPrice > cloudTop;
  const isLaggingSpanBullish = laggingSpanPrice > price26DaysAgo;
  const isNotOverbought = rsi < 70;

  if (isAboveCloud && isLaggingSpanBullish && isNotOverbought) {
    return { state: 'BUY', message: '' };
  }

  // ==========================================
  // 🔴 매도 조건 (Sell Signal - 차트 기반)
  // 1. 현재가가 일목균형표 전환선을 하향 돌파했을 때 (추세 꺾임)
  // 2. 또는 주가가 구름대 하단 밑으로 빠졌을 때 (완벽한 추세 이탈)
  // ※ 익절/손절(예: +5%, -3%) 로직은 매매 주문 엔진(app.js) 단에서 별도로 처리합니다.
  // ==========================================
  const isBelowConversion = currentPrice < ichimoku.conversion;
  const isBelowCloud = currentPrice < cloudBottom;

  if (isBelowConversion || isBelowCloud) {
    return { state: 'SELL', message: '' };
  }

  // 매수/매도 조건에 모두 해당하지 않으면 관망
  return { state: 'HOLD', message: '' };
};

module.exports = {
  getLatestRSI,
  getLatestIchimoku,
  analyzeSignal,
};