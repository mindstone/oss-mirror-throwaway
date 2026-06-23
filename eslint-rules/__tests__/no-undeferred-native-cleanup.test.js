import { RuleTester } from 'eslint';
import tsparser from '@typescript-eslint/parser';
import { createRequire } from 'node:module';
import { describe } from 'vitest';

const require = createRequire(import.meta.url);
const rule = require('../no-undeferred-native-cleanup.js');

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsparser,
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: {
      ecmaFeatures: {
        jsx: true,
      },
    },
  },
});

describe('no-undeferred-native-cleanup', () => {
  ruleTester.run('no-undeferred-native-cleanup', rule, {
    valid: [
      {
        name: 'native close routed through deferNativeCleanup is valid',
        code: `
          import { useEffect } from 'react';
          import { deferNativeCleanup } from '../utils/deferNativeCleanup';
          function Component({ socket }) {
            useEffect(() => {
              return () => {
                deferNativeCleanup(() => socket.close());
              };
            }, [socket]);
          }
        `,
      },
      {
        name: 'native close already nested in queueMicrotask inside cleanup is valid',
        code: `
          import { useEffect } from 'react';
          function Component({ socket }) {
            useEffect(() => {
              return () => {
                queueMicrotask(() => socket.close());
              };
            }, [socket]);
          }
        `,
      },
      {
        name: 'plain event handler close is valid',
        code: `
          import { useCallback } from 'react';
          function Component({ socket }) {
            const onPress = useCallback(() => {
              socket.close();
            }, [socket]);
            return null;
          }
        `,
      },
      {
        name: 'clearTimeout in cleanup is valid',
        code: `
          import { useEffect } from 'react';
          function Component({ timer }) {
            useEffect(() => {
              return () => {
                clearTimeout(timer);
              };
            }, [timer]);
          }
        `,
      },
      {
        name: 'React Native event subscription remove in cleanup is valid',
        code: `
          import { useEffect } from 'react';
          import { AppState } from 'react-native';
          function Component() {
            useEffect(() => {
              const subscription = AppState.addEventListener('change', () => {});
              return () => {
                subscription.remove();
              };
            }, []);
          }
        `,
      },
    ],
    invalid: [
      {
        name: 'raw socket close in useEffect cleanup is invalid',
        code: `
          import { useEffect } from 'react';
          function Component({ socket }) {
            useEffect(() => {
              return () => {
                socket.close();
              };
            }, [socket]);
          }
        `,
        errors: [{ messageId: 'undeferred' }],
      },
    ],
  });
});
