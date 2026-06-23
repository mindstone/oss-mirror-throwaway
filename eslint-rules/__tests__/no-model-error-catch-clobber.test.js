import { RuleTester } from 'eslint';
import tsparser from '@typescript-eslint/parser';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rule = require('../no-model-error-catch-clobber.js');

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsparser,
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
});

const productionFile = 'src/core/rebelCore/rebelCoreQuery.ts';

ruleTester.run('no-model-error-catch-clobber', rule, {
  valid: [
    {
      name: 'allows OpenAI Codex stream timeout fallback because it does not rewrap the caught error',
      filename: 'src/core/rebelCore/clients/openaiClient.ts',
      code: `
        async function stream(signal) {
          try {
            await readCodexStream();
          } catch (error) {
            if (streamStartTimeout.didTimeout() && !signal?.aborted) {
              throw new ModelError('server_error', STREAM_FIRST_CHUNK_TIMEOUT_MESSAGE, undefined, this.provider);
            }
            throw error;
          }
        }
      `,
    },
    {
      name: 'allows OpenAI Chat Completions stream timeout fallback because fallthrough rethrows the caught error',
      filename: 'src/core/rebelCore/clients/openaiClient.ts',
      code: `
        async function stream(signal) {
          try {
            await this.consumeChatCompletionStream(body);
          } catch (error) {
            if (streamStartTimeout.didTimeout() && !signal?.aborted) {
              log.warn({ timeoutMs: STREAM_FIRST_CHUNK_TIMEOUT_MS }, 'stream timed out');
              throw new ModelError('server_error', STREAM_FIRST_CHUNK_TIMEOUT_MESSAGE, undefined, this.provider);
            }
            throw error;
          }
        }
      `,
    },
    {
      name: 'allows OpenAI Responses stream timeout fallback because the ModelError comes from local timeout state',
      filename: 'src/core/rebelCore/clients/openaiClient.ts',
      code: `
        async function stream(signal) {
          try {
            await this.consumeResponsesStream(body);
          } catch (error) {
            if (streamStartTimeout.didTimeout() && !signal?.aborted) {
              throw new ModelError('server_error', STREAM_FIRST_CHUNK_TIMEOUT_MESSAGE, undefined, this.provider);
            }
            throw error;
          } finally {
            streamStartTimeout.dispose();
          }
        }
      `,
    },
    {
      name: 'allows catch that delegates preservation to reclassifyOrRethrow',
      filename: productionFile,
      code: `
        async function createPlanningClient() {
          try {
            await createClientForModel();
          } catch (planClientError) {
            const msg = planClientError instanceof Error ? planClientError.message : String(planClientError);
            reclassifyOrRethrow(planClientError, 'auth', \`Cannot initialize planning model: \${msg}\`);
          }
        }
      `,
    },
    {
      name: 'allows explicit getErrorKind preservation guard before fallback wrap',
      filename: productionFile,
      code: `
        async function createPlanningClient() {
          try {
            await createClientForModel();
          } catch (planClientError) {
            const msg = planClientError instanceof Error ? planClientError.message : String(planClientError);
            if (getErrorKind(planClientError) !== 'unknown') {
              throw planClientError;
            }
            throw new ModelError('auth', \`Cannot initialize planning model: \${msg}\`);
          }
        }
      `,
    },
    {
      name: 'allows explicit __agentErrorKind guard on catch binding before fallback wrap',
      filename: productionFile,
      code: `
        async function createPlanningClient() {
          try {
            await createClientForModel();
          } catch (planClientError) {
            const msg = planClientError instanceof Error ? planClientError.message : String(planClientError);
            if (planClientError && typeof planClientError === 'object' && planClientError.__agentErrorKind) {
              throw planClientError;
            }
            throw new ModelError('auth', \`Cannot initialize planning model: \${msg}\`);
          }
        }
      `,
    },
    {
      name: 'allows fixed-kind ModelError outside a catch for a known-condition mint',
      filename: productionFile,
      code: `
        function decodeQueryRoutingModelOrThrow(value: string, source: string) {
          const decoded = decodeRoutingModelId(value);
          if (!decoded) {
            throw new ModelError('invalid_request', \`Invalid \${source} model id "\${value}"\`, 400);
          }
          return decoded;
        }
      `,
    },
  ],
  invalid: [
    {
      name: 'flags direct rewrap of caught error message as fixed auth ModelError',
      filename: productionFile,
      code: `
        async function createPlanningClient() {
          try {
            await createClientForModel();
          } catch (err) {
            throw new ModelError('auth', \`Cannot initialize planning model: \${err.message}\`);
          }
        }
      `,
      errors: [{ messageId: 'noModelErrorCatchClobber' }],
    },
    {
      name: 'flags rewrap through a derived message local',
      filename: productionFile,
      code: `
        async function createPlanningClient() {
          try {
            await createClientForModel();
          } catch (planClientError) {
            const msg = planClientError instanceof Error ? planClientError.message : String(planClientError);
            throw new ModelError('auth', \`Cannot initialize planning model: \${msg}\`);
          }
        }
      `,
      errors: [{ messageId: 'noModelErrorCatchClobber' }],
    },
    {
      name: 'flags assigned ModelError rewrap that is thrown later',
      filename: productionFile,
      code: `
        async function createPlanningClient() {
          try {
            await createClientForModel();
          } catch (planClientError) {
            const msg = planClientError instanceof Error ? planClientError.message : String(planClientError);
            const wrapped = new ModelError('server_error', \`Planning failed: \${msg}\`);
            throw wrapped;
          }
        }
      `,
      errors: [{ messageId: 'noModelErrorCatchClobber' }],
    },
  ],
});
