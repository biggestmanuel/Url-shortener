import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['**/node_modules/**', 'backend/package-lock.json', 'package-lock.json'],
  },
  js.configs.recommended,
  {
    // Browser globals for the dependency-free frontend.
    files: ['app.js', 'qr.js', 'escape.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // qr.js and escape.js are UMD shims: they also load under Node for tests.
        module: 'readonly',
        Buffer: 'readonly',
        QRCode: 'readonly',
        LinklyEscape: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
      // app.js is one long IIFE: a `const` referenced by an earlier-registered
      // listener is a temporal-dead-zone crash that no other rule here catches.
      'no-use-before-define': ['error', { variables: true, functions: false, classes: true }],
    },
  },
  {
    // Node ESM for the backend.
    files: ['backend/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    files: ['backend/loadtest/**/*.js'],
    languageOptions: {
      globals: {
        __ENV: 'readonly',
        __VU: 'readonly',
        __ITER: 'readonly',
      },
    },
  },
];