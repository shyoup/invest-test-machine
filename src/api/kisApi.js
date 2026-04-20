require('dotenv').config();
const axios = require('axios');
const { getValidToken } = require('./tokenManager');

const DOMAIN = 'https://openapivts.koreainvestment.com:29443';
const APP_KEY = process.env.KIS_APP_KEY;
const APP_SECRET = process.env.KIS_SECRET_KEY;

/**
 * 1. 현재가 조회 (국내/해외 통합)
 */
const getCurrentPrice = async (ticker, market = 'KR') => {
  const token = await getValidToken();
  const isKR = market === 'KR';

  try {
    const trId = isKR ? 'FHKST01010100' : 'HHDFS00000300'; // 국장 vs 미장 TR ID
    const config = {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        appkey: APP_KEY,
        appsecret: APP_SECRET,
        tr_id: trId,
      },
      params: isKR
        ? { fid_cond_mrkt_div_code: 'J', fid_input_iscd: ticker }
        : { AUTH_CODE: '', EXCD: 'NAS', SYMB: ticker } // 미장은 기본 NAS(나스닥) 설정
    };

    const response = await axios.get(`${DOMAIN}/uapi/${isKR ? 'domestic-stock' : 'overseas-price'}/v1/quotations/inquire-price`, config);

    // 국장은 stck_prpr, 미장은 last 필드 사용
    return isKR ? response.data.output.stck_prpr : response.data.output.last;
  } catch (error) {
    console.error(`❌ [${market}][${ticker}] 현재가 조회 실패:`, error.message);
    throw error;
  }
};

/**
 * 2. 과거 데이터 조회 (국내/해외 통합)
 */
const getHistoricalData = async (ticker, market = 'KR') => {
  const token = await getValidToken();
  const isKR = market === 'KR';

  const today = new Date();
  const past = new Date();
  past.setDate(today.getDate() - 150);

  const formatDate = (date) => date.toISOString().split('T')[0].replace(/-/g, '');
  const endDate = formatDate(today);
  const startDate = formatDate(past);

  try {
    const trId = isKR ? 'FHKST03010100' : 'HHDFS76950200';
    const url = isKR
      ? `${DOMAIN}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`
      : `${DOMAIN}/uapi/overseas-price/v1/quotations/inquire-daily-chartprice`;

    const config = {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        appkey: APP_KEY,
        appsecret: APP_SECRET,
        tr_id: trId,
      },
      params: isKR
        ? {
          FID_COND_MRKT_DIV_CODE: 'J',
          FID_INPUT_ISCD: ticker,
          FID_INPUT_DATE_1: startDate,
          FID_INPUT_DATE_2: endDate,
          FID_PERIOD_DIV_CODE: 'D',
          FID_ORG_ADJ_PRC: '0',
        }
        : {
          AUTH_CODE: '',
          EXCD: 'NAS', // 기본 나스닥
          SYMB: ticker,
          GUBN: '0', // 일봉
          BYMD: endDate,
          MODP: '1', // 수정주가
        }
    };

    const response = await axios.get(url, config);
    const rawData = isKR ? response.data.output2 : response.data.output2; // 미장도 동일한 필드명 사용

    if (!rawData || rawData.length === 0) throw new Error('데이터 없음');

    const ohlcv = rawData.map((item) => ({
      open: Number(isKR ? item.stck_oprc : item.open),
      high: Number(isKR ? item.stck_hgpr : item.high),
      low: Number(isKR ? item.stck_lwpr : item.low),
      close: Number(isKR ? item.stck_clpr : item.clos),
      volume: Number(isKR ? item.acml_vol : item.tvol),
    }));

    return ohlcv.reverse();
  } catch (error) {
    console.error(`❌ [${market}][${ticker}] 과거 데이터 실패:`, error.message);
    throw error;
  }
};

/**
 * 3. 주문 가능 예수금 조회 (국내/해외 통합)
 * @returns {number} 매수 가능한 현금 (KR: 원화, US: 달러)
 */
const getAvailableCash = async (market = 'KR') => {
  const token = await getValidToken();
  const isKR = market === 'KR';

  // .env에서 계좌번호 가져오기
  const CANO = process.env.KIS_CANO;
  const ACNT_PRDT_CD = process.env.KIS_ACNT_PRDT_CD;

  try {
    // 모의투자 기준 잔고조회 TR ID
    const trId = isKR ? 'VTTC8908R' : 'VTTS3007R';
    const url = isKR
      ? `${DOMAIN}/uapi/domestic-stock/v1/trading/inquire-psbl-order`
      : `${DOMAIN}/uapi/overseas-stock/v1/trading/inquire-psbl-order`;

    const config = {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        appkey: APP_KEY,
        appsecret: APP_SECRET,
        tr_id: trId,
      },
      params: isKR
        ? {
          CANO,
          ACNT_PRDT_CD,
          PDNO: '',
          ORD_UNPR: '',
          ORD_DVSN: '01',
          CMA_EVLU_AMT_ICLD_YN: 'N',
          OVRS_ICLD_YN: 'N'
        }
        : {
          CANO,
          ACNT_PRDT_CD,
          OVRS_EXCG_CD: 'NAS',
          ITEM_CD: '',
          PRCR_STAT_EXCG_OPE_DVSN_CD: ''
        }
    };

    const response = await axios.get(url, config);

    // 국장은 '주문가능현금(ord_psbl_cash)', 미장은 '외화주문가능금액(frcr_ord_psbl_amt1)'
    const balance = isKR
      ? Number(response.data.output.ord_psbl_cash)
      : Number(response.data.output.frcr_ord_psbl_amt1);

    return balance;
  } catch (error) {
    console.error(`❌ [${market}] 예수금 조회 실패:`, error.response ? error.response.data : error.message);
    throw error;
  }
};

/**
 * 4. 주식 주문 실행 (국내/해외 통합 - 모의투자 전용)
 * @param {string} ticker - 종목코드
 * @param {number} quantity - 주문 수량
 * @param {number} price - 주문 단가 (국장은 0 입력 시 시장가)
 * @param {string} market - 'KR' 또는 'US'
 * @param {string} side - 'BUY' 또는 'SELL'
 */
const executeOrder = async (ticker, quantity, price, market = 'KR', side = 'BUY') => {
  const token = await getValidToken();
  const isKR = market === 'KR';

  const CANO = process.env.KIS_CANO;
  const ACNT_PRDT_CD = process.env.KIS_ACNT_PRDT_CD;

  try {
    // 1. TR ID 분기 (모의투자용)
    let trId = '';
    if (isKR) {
      trId = side === 'BUY' ? 'VTTC0802U' : 'VTTC0801U'; // 국장 현금 매수/매도
    } else {
      trId = side === 'BUY' ? 'VTTT1002U' : 'VTTT1006U'; // 미장 해외주식 매수/매도
    }

    // 2. URL 분기
    const url = isKR
      ? `${DOMAIN}/uapi/domestic-stock/v1/trading/order-cash`
      : `${DOMAIN}/uapi/overseas-stock/v1/trading/order`;

    // 3. 파라미터 분기
    // 국장은 확실한 체결을 위해 '시장가(01)'로 쏘고, 단가를 '0'으로 보냅니다.
    // 미장은 거래소마다 시장가 지원 여부가 달라, 현재가를 넣은 '지정가(00)'로 쏩니다.
    const data = isKR
      ? {
        CANO,
        ACNT_PRDT_CD,
        PDNO: ticker,
        ORD_DVSN: '01', // 01: 시장가
        ORD_QTY: String(quantity),
        ORD_UNPR: '0',  // 시장가는 단가 0
      }
      : {
        CANO,
        ACNT_PRDT_CD,
        OVRS_EXCG_CD: 'NAS', // 기본 나스닥
        PDNO: ticker,
        ORD_QTY: String(quantity),
        OVRS_ORD_UNPR: String(price), // 미장은 지정가 단가 입력
        ORD_SVR_DVSN_CD: '0',
        ORD_DVSN: '00', // 00: 지정가
      };

    const config = {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        appkey: APP_KEY,
        appsecret: APP_SECRET,
        tr_id: trId,
      }
    };

    // 주문은 GET이 아니라 POST 요청입니다!
    const response = await axios.post(url, data, config);

    // KIS API는 실패해도 200 응답을 주고, 내부 rt_cd 값으로 에러를 표현하는 경우가 있습니다.
    if (response.data.rt_cd !== '0') {
      throw new Error(response.data.msg1);
    }

    return response.data;
  } catch (error) {
    console.error(`❌ [${market}][${ticker}] 주문 에러:`, error.message);
    throw error;
  }
};

/**
 * 5. 현재 보유 종목 및 수량 조회 (국내/해외 통합 - 모의투자)
 * @returns {Object} { '종목코드': 보유수량 } 형태의 객체 반환
 */
const getCurrentHoldings = async (market = 'KR') => {
  const token = await getValidToken();
  const isKR = market === 'KR';

  const CANO = process.env.KIS_CANO;
  const ACNT_PRDT_CD = process.env.KIS_ACNT_PRDT_CD;

  try {
    const trId = isKR ? 'VTTC8434R' : 'VTTS3012R';
    const url = isKR
      ? `${DOMAIN}/uapi/domestic-stock/v1/trading/inquire-balance`
      : `${DOMAIN}/uapi/overseas-stock/v1/trading/inquire-balance`;

    // (config 부분은 기존과 100% 동일하므로 생략 없이 기존 코드 유지)
    const config = {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        appkey: APP_KEY,
        appsecret: APP_SECRET,
        tr_id: trId,
      },
      params: isKR
        ? { CANO, ACNT_PRDT_CD, AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '01', UNPR_DVSN: '01', FUND_STTL_ICLD_YN: 'N', FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '00', CTX_AREA_FK100: '', CTX_AREA_NK100: '' }
        : { CANO, ACNT_PRDT_CD, OVRS_EXCG_CD: 'NAS', TR_CRCY_CD: 'USD', CTX_AREA_FK200: '', CTX_AREA_NK200: '' }
    };

    const response = await axios.get(url, config);
    const holdList = response.data.output1;

    const holdingsMap = {};
    if (!holdList || holdList.length === 0) return holdingsMap;

    // 💡 변경된 부분: 수량을 객체 매핑 형태로 저장합니다.
    if (isKR) {
      holdList.forEach(item => {
        if (Number(item.hldg_qty) > 0) holdingsMap[item.pdno] = Number(item.hldg_qty);
      });
    } else {
      holdList.forEach(item => {
        if (Number(item.ovrs_cblc_qty) > 0) holdingsMap[item.ovrs_pdno] = Number(item.ovrs_cblc_qty);
      });
    }
    return holdingsMap;
  } catch (error) {
    console.error(`❌ [${market}] 잔고 조회 에러:`, error.message);
    return {};
  }
};

module.exports = { getCurrentPrice, getHistoricalData, getAvailableCash, executeOrder, getCurrentHoldings };