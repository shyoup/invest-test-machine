const fs = require('fs');
const path = require('path');
const axios = require('axios');

const TOKEN_PATH = path.join(__dirname, '../../token.json');
const DOMAIN = process.env.KIS_DOMAIN || 'https://openapivts.koreainvestment.com:29443';

/**
 * 로컬 파일에서 토큰 읽기
 */
const loadSavedToken = () => {
  try {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    const data = fs.readFileSync(TOKEN_PATH, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
};

/**
 * 새 토큰 발급 및 파일 저장
 */
const fetchAndSaveToken = async () => {
  try {
    const response = await axios.post(`${DOMAIN}/oauth2/tokenP`, {
      grant_type: 'client_credentials',
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_SECRET_KEY
    });

    const newToken = {
      access_token: response.data.access_token,
      expires_at: Date.now() + (response.data.expires_in * 1000) - (60 * 1000) // 만료 1분 전 여유
    };

    fs.writeFileSync(TOKEN_PATH, JSON.stringify(newToken), 'utf8');
    console.log('✅ 새 토큰 발급 및 저장 완료');
    return newToken.access_token;
  } catch (error) {
    console.error('❌ 토큰 갱신 에러:', error.message);

    // --- 아래 코드를 추가해서 KIS 서버의 진짜 답변을 확인해 보세요 ---
    if (error.response) {
      console.error('🔍 KIS 서버의 상세 에러 메시지:', error.response.data);
    }
    // -------------------------------------------------------------

    throw error;
  }
};

/**
 * 유효한 토큰 가져오기 (메인 인터페이스)
 */
const getValidToken = async () => {
  const saved = loadSavedToken();

  // 토큰이 있고 만료되지 않았으면 그대로 반환
  if (saved && saved.expires_at > Date.now()) {
    console.log('♻️ 저장된 토큰 사용');
    return saved.access_token;
  }

  // 없거나 만료되었다면 새로 발급
  console.log('🔄 토큰 만료 또는 없음. 새로 발급합니다.');
  return await fetchAndSaveToken();
};

module.exports = { getValidToken };