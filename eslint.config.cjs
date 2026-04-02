const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  {
    ignores: ['node_modules/**', 'data/**'],
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        // Common Node + browser built-ins used in this repo
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',

        // Browser globals used in public/*.js
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        Image: 'readonly',
        FileReader: 'readonly',
        confirm: 'readonly',
        alert: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: {
        io: 'readonly',
      },
    },
    rules: {
      // Public scripts intentionally expose functions via onclick handlers.
      'no-unused-vars': 'off',
      'no-undef': 'error',
    },
  },
  {
    files: ['public/app.js'],
    languageOptions: {
      globals: {
        playTurn: 'readonly',
        playDeal: 'readonly',
        playFold: 'readonly',
        playCheck: 'readonly',
        playChipBet: 'readonly',
        playAllIn: 'readonly',
        playWin: 'readonly',
      },
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        test: 'readonly',
        expect: 'readonly',
      },
    },
  },
  {
    files: ['scripts/**/*.js'],
    rules: {
      'no-unused-vars': 'error',
    },
  },
];

