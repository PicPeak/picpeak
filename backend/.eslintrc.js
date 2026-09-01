module.exports = {
  env: {
    browser: false,
    es2021: true,
    node: true,
    jest: true
  },
  extends: [
    'eslint:recommended'
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  rules: {
    'indent': ['error', 2],
    'linebreak-style': ['error', 'unix'],
    'quotes': ['error', 'single'],
    'semi': ['error', 'always'],
    // varsIgnorePattern + ignoreRestSiblings cover the "omit fields via rest
    // spread" idiom (e.g. adminEvents/helpers.js pulling password hashes out
    // of ...rest), which is intentional and would otherwise need a disable
    // comment at every occurrence.
    'no-unused-vars': ['error', {
      'argsIgnorePattern': '^_',
      'varsIgnorePattern': '^_',
      'ignoreRestSiblings': true
    }],
    'no-console': ['warn', { allow: ['warn', 'error'] }]
  }
};
