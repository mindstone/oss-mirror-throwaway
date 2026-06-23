import tsParser from '@typescript-eslint/parser';

const executeScriptNoTsSelector =
  "CallExpression[callee.type='MemberExpression'][callee.property.name='executeScript'][callee.object.type='MemberExpression'][callee.object.object.name='chrome'][callee.object.property.name='scripting'] > ObjectExpression > Property[key.name='files'] > ArrayExpression > Literal[value=/\\.ts$/]";

const executeScriptNoTsSelectorForStringKey =
  "CallExpression[callee.type='MemberExpression'][callee.property.name='executeScript'][callee.object.type='MemberExpression'][callee.object.object.name='chrome'][callee.object.property.name='scripting'] > ObjectExpression > Property[key.value='files'] > ArrayExpression > Literal[value=/\\.ts$/]";

export default [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'tests/**/*.ts', 'tests/**/*.tsx', 'vite.config.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: executeScriptNoTsSelector,
          message:
            "Never pass raw '.ts' literals to chrome.scripting.executeScript({ files }). Import the bundled URL via '?script' instead.",
        },
        {
          selector: executeScriptNoTsSelectorForStringKey,
          message:
            "Never pass raw '.ts' literals to chrome.scripting.executeScript({ files }). Import the bundled URL via '?script' instead.",
        },
      ],
    },
  },
];
