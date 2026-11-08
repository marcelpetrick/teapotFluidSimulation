// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'playwright-report/**', 'test-results/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        console: 'readonly',
        window: 'readonly',
        document: 'readonly',
        self: 'readonly',
        performance: 'readonly',
        URL: 'readonly',
      },
    },
    rules: { 'no-constant-condition': ['error', { checkLoops: false }] },
  },
);
