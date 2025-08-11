import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierPlugin from 'eslint-plugin-prettier';
import jsonc from 'eslint-plugin-jsonc';
import jsoncParser from 'jsonc-eslint-parser';

export default [
  // TypeScript files
  {
    files: ['**/*.{ts,mts,cts,tsx}'],
    plugins: {
      '@typescript-eslint': tseslint,
      prettier: prettierPlugin,
    },
    languageOptions: {
      parser: tsParser,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      'prettier/prettier': 'error',
    },
  },
  // JSONC files
  {
    files: ['**/*.jsonc'],
    plugins: {
      jsonc: jsonc,
    },
    languageOptions: {
      parser: jsoncParser,
    },
    rules: {
      ...jsonc.configs['recommended-with-jsonc'].rules,
    },
  },
];
