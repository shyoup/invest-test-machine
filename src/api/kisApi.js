const axios = require('axios');
const { getValidToken } = require('./tokenManager');

const APP_KEY = process.env.KIS_APP_KEY;
const APP_SECRET = process.env.KIS_SECRET_KEY;
const DOMAIN = process.env.KIS_DOMAIN;
const CANO = process.env.KIS_ACCOUNT_NO;
const ACNT_PRDT_CD = process.env.KIS_ACCOUNT_PRDT;

// 실전투자 / 모의투자 환경 자동 판별
const IS_MOCK = DOMAIN.includes('openapivts');

// 종목별 거래소 캐시 (US 종목 → NAS/NYS/AMS)
const exchangeCache = new Map();

// 날짜를 YYYYMMDD 형식으로 변환
const formatDate = d => d.toISOString().slice(0, 10).replace(/-/g, '');

// KIS 전용 에러 메시지 추출 헬퍼
const getKisErrorMsg = (err) => {
  if (err.response && err.response.data) {
    const { msg_cd, msg1 } = err.response.data;
    if (msg_cd || msg1) return `[${msg_cd || 'ERROR'}] ${msg1 || '메시지없음'}`;
  }
  return err.message;
};

// API 과부하 방지용 딜레이
const microSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 1. 과거 데이터 (일봉) 조회
 * - KR: FHKST03010100 (inquire-daily-itemchartprice) — 날짜 범위 지정으로 충분한 데이터 확보
 * - US: HHDFS76240000 (dailyprice) — NAS → NYS → AMS 순 탐색
 * 반환 데이터는 오름차순(oldest→newest)으로 정렬됨
 */
const getHistoricalData = async (ticker, market = 'KR') => {
  const token = await getValidToken();
  const isKR = market === 'KR';

  try {
    if (isKR) {
      // 6개월 치 일봉 데이터 요청 (일목균형표 계산에 최소 78개 필요)
      const endDate = new Date();
      const startDate = new Date();
      startDate.setMonth(startDate.getMonth() - 6);

      const url = `${DOMAIN}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`;
      const config = {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          appkey: APP_KEY,
          appsecret: APP_SECRET,
          tr_id: 'FHKST03010100',
        },
        params: {
          FID_COND_MRKT_DIV_CODE: 'J',
          FID_INPUT_ISCD: ticker,
          FID_INPUT_DATE_1: formatDate(startDate),
          FID_INPUT_DATE_2: formatDate(endDate),
          FID_PERIOD_DIV_CODE: 'D',
          FID_ORG_ADJ_PRC: '0',
        },
      };
      await microSleep(1000);
      const res = await axios.get(url, config);
      if (res.data.rt_cd === '1') throw new Error(res.data.msg1);

      // KIS API는 최신순(내림차순)으로 반환 → .reverse()로 오름차순 변환
      return (res.data.output2 || []).map(item => ({
        date: item.stck_bsop_date,
        open: Number(item.stck_oprc),
        close: Number(item.stck_clpr),
        high: Number(item.stck_hgpr),
        low: Number(item.stck_lwpr),
      })).reverse();

    } else {
      // 미장 과거데이터
      const url = `${DOMAIN}/uapi/overseas-price/v1/quotations/dailyprice`;
      let lastApiError = null;

      const fetchUsData = async (excd) => {
        try {
          const config = {
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${token}`,
              appkey: APP_KEY,
              appsecret: APP_SECRET,
              tr_id: 'HHDFS76240000',
              custtype: 'P',
            },
            params: { AUTH: '', EXCD: excd, SYMB: ticker, GUBN: '0', BYMD: '', MODP: '1' },
          };
          await microSleep(1000);
          const res = await axios.get(url, config);
          if (res.data.rt_cd === '1') throw new Error(`[${res.data.msg_cd}] ${res.data.msg1}`);
          if (res.data && res.data.output2 && res.data.output2.length > 0) {
            exchangeCache.set(ticker, excd); // 거래소 코드 캐시
            return res.data.output2;
          }
          return null;
        } catch (err) {
          lastApiError = getKisErrorMsg(err);
          if (lastApiError.includes('초과') || lastApiError.includes('야간') || lastApiError.includes('점검')) {
            throw new Error(lastApiError);
          }
          return null;
        }
      };

      let rawData = await fetchUsData('NAS');
      if (!rawData) { rawData = await fetchUsData('NYS'); }
      if (!rawData) { rawData = await fetchUsData('AMS'); }

      if (!rawData) throw new Error(lastApiError || `해당 티커를 NAS/NYS/AMS에서 찾을 수 없습니다.`);

      // KIS API는 최신순(내림차순)으로 반환 → .reverse()로 오름차순 변환
      return rawData.map(item => ({
        date: item.xymd,
        open: Number(item.open),
        close: Number(item.clos),
        high: Number(item.high),
        low: Number(item.low),
      })).reverse();
    }
  } catch (error) {
    const finalErrMsg = getKisErrorMsg(error);
    console.error(`❌ [${market}][${ticker}] API 통신 에러: ${finalErrMsg}`);
    throw new Error(finalErrMsg);
  }
};

/**
 * 2. 현재가 조회
 */
const getCurrentPrice = async (ticker, market = 'KR') => {
  const token = await getValidToken();
  const isKR = market === 'KR';

  try {
    if (isKR) {
      const url = `${DOMAIN}/uapi/domestic-stock/v1/quotations/inquire-price`;
      const config = {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          appkey: APP_KEY,
          appsecret: APP_SECRET,
          tr_id: 'FHKST01010100',
        },
        params: { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: ticker },
      };
      await microSleep(1000);
      const res = await axios.get(url, config);
      if (res.data.rt_cd === '1') throw new Error(res.data.msg1);
      return Number(res.data.output.stck_prpr);

    } else {
      const url = `${DOMAIN}/uapi/overseas-price/v1/quotations/price`;
      let lastApiError = null;

      const fetchUsPrice = async (excd) => {
        try {
          const config = {
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${token}`,
              appkey: APP_KEY,
              appsecret: APP_SECRET,
              tr_id: 'HHDFS00000300',
              custtype: 'P',
            },
            params: { AUTH: '', EXCD: excd, SYMB: ticker },
          };
          await microSleep(1000);
          const res = await axios.get(url, config);
          if (res.data.rt_cd === '1') throw new Error(`[${res.data.msg_cd}] ${res.data.msg1}`);
          if (res.data && res.data.output) return Number(res.data.output.last);
          return null;
        } catch (err) {
          lastApiError = getKisErrorMsg(err);
          if (lastApiError.includes('초과') || lastApiError.includes('점검')) throw new Error(lastApiError);
          return null;
        }
      };

      // 캐시에 거래소가 있으면 바로 조회, 없으면 순차 탐색
      const cachedExcd = exchangeCache.get(ticker);
      let price = cachedExcd ? await fetchUsPrice(cachedExcd) : null;
      if (price === null) { price = await fetchUsPrice('NAS'); }
      if (price === null) { price = await fetchUsPrice('NYS'); }
      if (price === null) { price = await fetchUsPrice('AMS'); }

      if (price === null) throw new Error(lastApiError || `현재가 조회 실패`);
      return price;
    }
  } catch (error) {
    throw new Error(getKisErrorMsg(error));
  }
};

/**
 * 3. 예수금(매수가능현금) 조회
 * - KR: ord_psbl_cash (원화 주문가능금액)
 * - US: output2에서 USD 항목의 frcs_ord_psbl_amt (외화주문가능금액)
 */
const getAvailableCash = async (market = 'KR') => {
  const token = await getValidToken();
  const isKR = market === 'KR';

  try {
    const trId = isKR
      ? (IS_MOCK ? 'VTTC8908R' : 'TTTC8908R')
      : (IS_MOCK ? 'VTRP6504R' : 'CTRP6504R');

    const url = isKR
      ? `${DOMAIN}/uapi/domestic-stock/v1/trading/inquire-psbl-order`
      : `${DOMAIN}/uapi/overseas-stock/v1/trading/inquire-present-balance`;

    const params = isKR
      ? { CANO, ACNT_PRDT_CD, PDNO: '', ORD_UNPR: '', ORD_DVSN: '01', CMA_EVLU_AMT_ICLD_YN: 'N', OVRS_ICLD_YN: 'N' }
      : {
        CANO,
        ACNT_PRDT_CD,
        WCRC_FRCR_DVSN_CD: '02',
        NATN_CD: '840',
        TR_MKET_CD: '00',
        INQR_DVSN_CD: '00',
      };

    const config = {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, appkey: APP_KEY, appsecret: APP_SECRET, tr_id: trId },
      params,
    };

    await microSleep(1000);
    const res = await axios.get(url, config);
    if (res.data.rt_cd === '1') throw new Error(res.data.msg1);

    if (isKR) {
      return Number(res.data.output.ord_psbl_cash);
    } else {
      // fallback: output3 요약값 (USD 환산 순자산 근사치)
      return Number(res.data.output3?.frcr_evlu_tota || 0);
    }

  } catch (error) {
    console.error(`❌ [${market}] 예수금 조회 에러: ${getKisErrorMsg(error)}`);
    return 0;
  }
};

/**
 * 4. 현재 보유 종목 및 수량 조회
 * - KR: 단일 조회
 * - US: NASD / NYSE / AMEX 세 거래소 모두 조회 후 합산
 */
const getCurrentHoldings = async (market = 'KR') => {
  const token = await getValidToken();
  const isKR = market === 'KR';

  const holdingsMap = {};

  try {
    const trId = isKR
      ? (IS_MOCK ? 'VTTC8434R' : 'TTTC8434R')
      : (IS_MOCK ? 'VTTS3012R' : 'TTTS3012R');

    const url = isKR
      ? `${DOMAIN}/uapi/domestic-stock/v1/trading/inquire-balance`
      : `${DOMAIN}/uapi/overseas-stock/v1/trading/inquire-balance`;

    if (isKR) {
      const params = { CANO, ACNT_PRDT_CD, AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '01', UNPR_DVSN: '01', FUND_STTL_ICLD_YN: 'N', FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '00', CTX_AREA_FK100: '', CTX_AREA_NK100: '' };
      const config = { headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, appkey: APP_KEY, appsecret: APP_SECRET, tr_id: trId }, params };
      await microSleep(1000);
      const res = await axios.get(url, config);
      if (res.data.rt_cd === '1') throw new Error(res.data.msg1);
      (res.data.output1 || []).forEach(item => {
        if (Number(item.hldg_qty) > 0) holdingsMap[item.pdno] = Number(item.hldg_qty);
      });
    } else {
      // 미장은 세 거래소를 모두 조회해야 전체 보유 종목 파악 가능
      for (const exchCd of ['NASD', 'NYSE', 'AMEX']) {
        try {
          const params = { CANO, ACNT_PRDT_CD, OVRS_EXCG_CD: exchCd, TR_CRCY_CD: 'USD', CTX_AREA_FK200: '', CTX_AREA_NK200: '' };
          const config = { headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, appkey: APP_KEY, appsecret: APP_SECRET, tr_id: trId }, params };
          await microSleep(1000);
          const res = await axios.get(url, config);
          if (res.data.rt_cd !== '1') {
            (res.data.output1 || []).forEach(item => {
              if (Number(item.ovrs_cblc_qty) > 0) holdingsMap[item.ovrs_pdno] = Number(item.ovrs_cblc_qty);
            });
          }
        } catch (e) {
          console.error(`⚠️ [US][${exchCd}] 잔고 조회 에러: ${getKisErrorMsg(e)}`);
        }
      }
    }

    return holdingsMap;
  } catch (error) {
    console.error(`❌ [${market}] 잔고 조회 에러: ${getKisErrorMsg(error)}`);
    return holdingsMap;
  }
};

/**
 * 5. 매수 / 매도 주문 실행
 * - US 주문 시 exchangeCache에 저장된 거래소 코드 사용
 */
const executeOrder = async (ticker, quantity, price, market, position) => {
  const token = await getValidToken();
  const isKR = market === 'KR';

  try {
    let url, trId, body;

    if (isKR) {
      url = `${DOMAIN}/uapi/domestic-stock/v1/trading/order-cash`;
      if (position === 'BUY') trId = IS_MOCK ? 'VTTC0012U' : 'TTTC0012U';
      else trId = IS_MOCK ? 'VTTC0011U' : 'TTTC0011U';

      body = { CANO, ACNT_PRDT_CD, PDNO: ticker, ORD_DVSN: '01', ORD_QTY: String(quantity), ORD_UNPR: '0' };
    } else {
      url = `${DOMAIN}/uapi/overseas-stock/v1/trading/order`;

      if (position === 'BUY') trId = IS_MOCK ? 'VTTT1002U' : 'TTTT1002U';
      else trId = IS_MOCK ? 'VTTT1001U' : 'TTTT1006U';

      // 캐시된 거래소 코드 활용 (없으면 NASD 기본값)
      const exchCodeMap = { NAS: 'NASD', NYS: 'NYSE', AMS: 'AMEX' };
      const ovrsExcgCd = exchCodeMap[exchangeCache.get(ticker)] || 'NASD';

      body = {
        CANO, ACNT_PRDT_CD, OVRS_EXCG_CD: ovrsExcgCd, PDNO: ticker,
        ORD_DVSN: '00', ORD_QTY: String(quantity), OVRS_ORD_UNPR: String(price),
        SLL_TYPE: '00', ORD_SVR_DVSN_CD: '0',
      };
    }

    const config = {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, appkey: APP_KEY, appsecret: APP_SECRET, tr_id: trId },
    };

    await microSleep(1000);
    const res = await axios.post(url, body, config);
    if (res.data.rt_cd === '1') throw new Error(res.data.msg1);
    return res.data;

  } catch (error) {
    throw new Error(getKisErrorMsg(error));
  }
};

module.exports = {
  getHistoricalData,
  getCurrentPrice,
  getAvailableCash,
  getCurrentHoldings,
  executeOrder,
};
