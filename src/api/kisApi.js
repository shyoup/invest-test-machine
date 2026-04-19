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

module.exports = { getCurrentPrice, getHistoricalData };