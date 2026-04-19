import { FlatCompat } from '@eslint/eslintrc';
import pluginJs from '@eslint/js';

// 구형 룰(Airbnb, Prettier plugin)을 Flat Config 형식으로 변환해 주는 호환성 도구
const compat = new FlatCompat();

export default [
  // 1. ESLint 기본 추천 룰
  pluginJs.configs.recommended,

  // 2. 에어비앤비 룰 적용 (compat.extends 배열 전개)
  ...compat.extends('airbnb-base'),

  // 3. Prettier 포매팅 룰 (Prettier와 충돌하는 ESLint 룰 무시)
  ...compat.extends('plugin:prettier/recommended'),

  // 4. 프로젝트 커스텀 룰 덮어쓰기
  {
    rules: {
      'no-console': 'off', // 터미널에서 봇의 상태를 확인해야 하므로 경고 끔
      'import/no-extraneous-dependencies': 'off',
      'no-unused-vars': 'warn',
    },
  },
];