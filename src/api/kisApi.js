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
// src/api/kisApi.js 내부 수정

// 💡 KIS 전용 에러 메시지 추출 헬퍼 함수
const getKisErrorMsg = (err) => {
  if (err.response && err.response.data) {
    const { msg_cd, msg1 } = err.response.data;
    if (msg_cd || msg1) return `[${msg_cd || '코드없음'}] ${msg1 || '메시지없음'}`;
  }
  return err.message; // KIS 규격이 아니면 일반 에러 메시지 반환
};

const getHistoricalData = async (ticker, market = 'KR') => {
  const token = await getValidToken();
  const isKR = market === 'KR';

  const microSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  try {
    if (isKR) {
      // 🇰🇷 국장 로직 (기존과 동일)
      // ... 생략 ...
    } else {
      // 🇺🇸 미장 로직
      const url = `${DOMAIN}/uapi/overseas-price/v1/quotations/dailyprice`;

      const fetchUsData = async (excd) => {
        try {
          const config = {
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${token}`,
              appkey: APP_KEY,
              appsecret: APP_SECRET,
              tr_id: 'FHKST03030100',
              custtype: 'P'
            },
            params: { AUTH: '', EXCD: excd, SYMB: ticker, GUBN: '0', BYMD: '', MODP: '1' },
          };
          const res = await axios.get(url, config);

          if (res.data && res.data.output2 && res.data.output2.length > 0) {
            return res.data.output2;
          }
          return null;
        } catch (err) {
          const kisErrMsg = getKisErrorMsg(err);
          console.log(`⚠️ [US][${ticker}] ${excd} 탐색 실패 사유: ${kisErrMsg}`);
          return null;
        }
      };

      // 💡 1. 나스닥 찌르기
      let rawData = await fetchUsData('NAS');

      // 💡 2. 없으면 1초 쉬고 뉴욕 찌르기
      if (!rawData) {
        await microSleep(1000);
        rawData = await fetchUsData('NYS');
      }

      // 💡 3. 그래도 없으면 1초 쉬고 아멕스 찌르기
      if (!rawData) {
        await microSleep(1000);
        rawData = await fetchUsData('AMS');
      }

      if (!rawData) throw new Error('미장 거래소(NAS/NYS/AMS) 전체 탐색 실패 (로그 확인 요망)');

      return rawData.map(item => ({
        date: item.xymd, close: Number(item.clos), high: Number(item.high), low: Number(item.low)
      }));
    }
  } catch (error) {
    const finalErrMsg = getKisErrorMsg(error);
    console.error(`❌ [${market}][${ticker}] 과거 데이터 API 에러: ${finalErrMsg}`);
    throw new Error(finalErrMsg);
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