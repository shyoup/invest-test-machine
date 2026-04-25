const fs = require('fs');
const path = require('path');

const K_VALUE = 0.5;
const VB_POSITIONS_FILE = path.join(__dirname, '../../vbPositions.json');

// ─────────────────────────────────────────
// 당일 목표가 메모리 캐시 (하루 1회 계산)
// { ticker → { targetPrice, ma5, openPrice, date } }
// ─────────────────────────────────────────
const dailyCache = new Map();

// 오늘 날짜를 KST 기준 YYYYMMDD 로 반환 (KIS API date 포맷과 일치)
const getTodayKST = () => {
  const now = new Date();
  return new Date(now.getTime() + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '');
};

/**
 * VB 목표가 계산 (하루 1회 캐싱)
 * ohlcvData: getHistoricalData() 반환값 — 오름차순(oldest→newest) 정렬 확인 완료
 */
const computeVBTarget = (ticker, ohlcvData) => {
  const today = getTodayKST();
  const cached = dailyCache.get(ticker);
  if (cached && cached.date === today) return cached;

  // 최소 데이터: 오늘 봉 1 + MA5용 5봉 + 버퍼 1 = 7개
  if (!ohlcvData || ohlcvData.length < 7) return null;

  // 오름차순이므로 마지막이 최신 (오늘), 그 앞이 전일
  const todayBar = ohlcvData[ohlcvData.length - 1];
  const yesterdayBar = ohlcvData[ohlcvData.length - 2];

  // 오늘 봉이 실제로 오늘 날짜인지 확인 (장 시작 전엔 아직 오늘 봉이 없을 수 있음)
  if (!todayBar || todayBar.date !== today) return null;
  if (!yesterdayBar || !todayBar.open) return null;

  const prevRange = yesterdayBar.high - yesterdayBar.low;
  if (prevRange <= 0) return null;

  // MA5: 오늘 직전 5영업일 종가 평균 (indices -6 ~ -2)
  const last5 = ohlcvData.slice(-6, -1);
  if (last5.length < 5) return null;
  const ma5 = Math.round(last5.reduce((sum, d) => sum + d.close, 0) / 5);

  const targetPrice = Math.round(todayBar.open + prevRange * K_VALUE);

  const entry = { targetPrice, ma5, openPrice: todayBar.open, date: today };
  dailyCache.set(ticker, entry);
  console.log(`📌 [VB 캐시] ${ticker} | 시가: ${todayBar.open} | 전일범위: ${prevRange} | MA5: ${ma5} | 목표가: ${targetPrice}`);
  return entry;
};

/**
 * 장 시작 전(08:55) 캐시 초기화
 */
const clearDailyCache = () => {
  dailyCache.clear();
  console.log('🗑️  [VB] 당일 목표가 캐시 초기화 완료');
};

/**
 * VB 매수 시그널 판별
 * - 조건 A: 당일 시가 > MA5  (추세 필터)
 * - 조건 B: 현재가 >= 목표가  (변동성 돌파 확인)
 */
const analyzeVBSignal = (ticker, ohlcvData, currentPrice) => {
  const vb = computeVBTarget(ticker, ohlcvData);
  if (!vb) return { state: 'HOLD', info: '데이터 부족 또는 오늘 봉 미확인' };

  const { targetPrice, ma5, openPrice } = vb;
  const isTrendOk = openPrice > ma5;
  const isBreakout = currentPrice >= targetPrice;

  const info = `시가 ${openPrice.toLocaleString()} | MA5 ${ma5.toLocaleString()} | 목표가 ${targetPrice.toLocaleString()} | 현재가 ${currentPrice.toLocaleString()}`;
  console.log(`📊 [VB] ${ticker} | ${info} | 추세필터 ${isTrendOk ? '✅' : '❌'} | 돌파 ${isBreakout ? '✅' : '❌'}`);

  if (isTrendOk && isBreakout) return { state: 'BUY', info };
  return { state: 'HOLD', info };
};

// ─────────────────────────────────────────
// VB 포지션 영속화 (다음 날 아침 청산용)
// vbPositions.json: { "005930": 10, "000660": 5 }
// ─────────────────────────────────────────

const readVBPositions = () => {
  try {
    if (!fs.existsSync(VB_POSITIONS_FILE)) return {};
    return JSON.parse(fs.readFileSync(VB_POSITIONS_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
};

const writeVBPositions = (positions) => {
  fs.writeFileSync(VB_POSITIONS_FILE, JSON.stringify(positions, null, 2), 'utf8');
};

const recordVBBuy = (ticker, quantity) => {
  const positions = readVBPositions();
  positions[ticker] = quantity;
  writeVBPositions(positions);
  console.log(`💾 [VB] ${ticker} ${quantity}주 포지션 기록`);
};

const removeVBPosition = (ticker) => {
  const positions = readVBPositions();
  if (positions[ticker] !== undefined) {
    delete positions[ticker];
    writeVBPositions(positions);
  }
};

module.exports = {
  analyzeVBSignal,
  clearDailyCache,
  readVBPositions,
  recordVBBuy,
  removeVBPosition,
};
