import { describe, it, expect } from 'vitest';
import {
  scanSourceForRetryTransience,
  findRetryTransienceViolations,
  SCAN_FILES,
} from '../check-safety-eval-retry-transience';

describe('scanSourceForRetryTransience — fires on the non-transient-retry shape (non-vacuous)', () => {
  it('flags a loop calling callLlm() with NO transience guard in catch', () => {
    const src = `
      async function doEval() {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const response = await service.callLlm({ system, userMessage });
            return response;
          } catch (err) {
            // retries blindly on ANY error — including non-transient billing/auth
            if (attempt < 3) {
              await sleep(500);
            }
          }
        }
      }
    `;
    const v = scanSourceForRetryTransience(src, 'src/core/safetyPromptLogic.ts');
    expect(v).toHaveLength(1);
    expect(v[0].functionName).toBe('doEval');
  });

  it('flags a while-loop calling create() with no transience signal', () => {
    const src = `
      class Client {
        async runWithRetry() {
          let attempt = 0;
          while (true) {
            try {
              return await this.client.create(params);
            } catch (e) {
              attempt++;
              if (attempt > 3) throw e;
              await sleep(100);
            }
          }
        }
      }
    `;
    const v = scanSourceForRetryTransience(src, 'src/core/rebelCore/clients/anthropicClient.ts');
    expect(v).toHaveLength(1);
    expect(v[0].functionName).toBe('runWithRetry');
  });
});

describe('scanSourceForRetryTransience — clears compliant forms (no false positives)', () => {
  it('does NOT flag the real safetyPromptLogic shape (instanceof ModelError + !isTransient break)', () => {
    const src = `
      async function doEval() {
        for (let attempt = 1; attempt <= EVAL_MAX_RETRIES; attempt++) {
          try {
            const response = await service.callLlm({ system, userMessage });
            return response;
          } catch (err) {
            if (err instanceof ModelError && !err.isTransient) {
              break;
            }
            if (attempt < EVAL_MAX_RETRIES) {
              await sleep(retryDelay(attempt));
            }
          }
        }
      }
    `;
    const v = scanSourceForRetryTransience(src, 'src/core/safetyPromptLogic.ts');
    expect(v).toHaveLength(0);
  });

  it('does NOT flag a runWithRetry shape gated on modelError.isTransient', () => {
    const src = `
      async function runWithRetry(run) {
        for (let attempt = 0; ; attempt++) {
          try {
            return await run();
          } catch (error) {
            const modelError = classifyError(error);
            if (attempt < MAX_RETRIES && modelError.isTransient) {
              await sleep(100);
              continue;
            }
            throw modelError;
          }
        }
      }
    `;
    const v = scanSourceForRetryTransience(src, 'src/core/rebelCore/clients/openaiClient.ts');
    expect(v).toHaveLength(0);
  });

  it('does NOT flag a loop short-circuiting on === "rate_limit"', () => {
    const src = `
      async function runWithRetry(run) {
        for (let attempt = 0; ; attempt++) {
          try {
            return await run();
          } catch (error) {
            const modelError = classifyError(error);
            if (modelError.kind === 'rate_limit') throw modelError;
            await sleep(100);
          }
        }
      }
    `;
    const v = scanSourceForRetryTransience(src, 'src/core/rebelCore/clients/anthropicClient.ts');
    expect(v).toHaveLength(0);
  });

  it('does NOT flag a loop referencing TRANSIENT_KINDS', () => {
    const src = `
      async function doEval() {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            return await service.callLlm({ system });
          } catch (err) {
            if (!TRANSIENT_KINDS.has(err.kind)) break;
            await sleep(100);
          }
        }
      }
    `;
    const v = scanSourceForRetryTransience(src, 'src/core/safetyPromptLogic.ts');
    expect(v).toHaveLength(0);
  });

  it('honors the RETRY_TRANSIENCE_OK: escape-hatch marker', () => {
    const src = `
      async function doEval() {
        // RETRY_TRANSIENCE_OK: every error here is transient by construction (local mock).
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            return await service.callLlm({ system });
          } catch (err) {
            await sleep(100);
          }
        }
      }
    `;
    const v = scanSourceForRetryTransience(src, 'src/core/safetyPromptLogic.ts');
    expect(v).toHaveLength(0);
  });
});

describe('scanSourceForRetryTransience — does not over-match', () => {
  it('does NOT flag a NON-model retry loop (file I/O) — no model method in body', () => {
    // This is the shape of the ~9 unrelated retry loops elsewhere in the tree.
    // Even fed to the analyzer directly (the allow-list is the real guard), the
    // call-name discriminator means it is never a candidate.
    const src = `
      async function readWithRetry(path) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            return await fs.readFile(path, 'utf8');
          } catch (err) {
            await sleep(100);
          }
        }
      }
    `;
    const v = scanSourceForRetryTransience(src, 'src/core/services/safety/btsSafetyEvalService.ts');
    expect(v).toHaveLength(0);
  });
});

describe('live invariant — the real SCAN_FILES tree is clean', () => {
  it('exposes exactly the four allow-listed files', () => {
    expect([...SCAN_FILES]).toEqual([
      'src/core/safetyPromptLogic.ts',
      'src/core/rebelCore/clients/anthropicClient.ts',
      'src/core/rebelCore/clients/openaiClient.ts',
      'src/core/services/safety/btsSafetyEvalService.ts',
    ]);
  });

  it('reports ZERO violations against the actual repo SCAN_FILES (postmortem live invariant)', () => {
    const violations = findRetryTransienceViolations();
    expect(
      violations,
      `Unexpected non-transient retry loop(s):\n${violations
        .map((x) => `  ${x.relativePath}:${x.line} ${x.functionName}`)
        .join('\n')}`,
    ).toHaveLength(0);
  });
});
