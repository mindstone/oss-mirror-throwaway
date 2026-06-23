/**
 * Unit tests for the integration-test provider-gate AST check (260419 A3b)
 * and legacy-model-read scan (260507).
 *
 * Fixture files exercise the grammar:
 *   (a) correct pattern (passes)
 *   (b) auth-helper-only gate (fails)
 *   (c) raw-field-only gate (fails)
 *   (d) suppressed-with-justification (passes, logged)
 *   (e) suppressed-without-justification (fails)
 *   (f-h) aliased-import / indirect-alias / malformed grammar
 *   (i) canonical-accessor model read (passes — 260507 addition)
 *   (j) raw legacy-namespace model read in body (fails — 260507 addition)
 *   (k) raw legacy-namespace model read with rationale (passes, logged)
 *   (l) gate via local helper that composes auth-shape only (fails —
 *       260507 Phase-6 helper-recursion addition)
 *   (m) gate via local helper that composes auth + provider-shape (passes)
 *   (n) legacy-model read INSIDE a correctly-composed gate (fails —
 *       260507 Round-3 dedup-hole closure)
 *
 * Plus tests for `loadAuthShapeHelpers` / `loadModelSettingsFieldKeys`
 * (source-of-truth imports) and the canary against the real repo state.
 *
 * @see ../check-integration-test-provider-gates.ts
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ESM module namespaces are non-configurable, so `vi.spyOn(fs, 'readFileSync')`
// throws. To intercept the scanner's `readFileToleratingVanished` (which calls
// `fs.readFileSync` internally) deterministically, mock `node:fs` with a
// readFileSync that delegates to the real implementation unless a per-test hook
// overrides a specific path. Every other fs symbol is the real one
// (importActual), so the directory walk and fixture/temp helpers behave
// normally. Mirrors the token-drift check's unit test (sibling under
// scripts/__tests__/).
let readFileSyncHook:
  | ((targetPath: string) => void) // throw to simulate a read failure for this path
  | null = null;
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: actual,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readFileSync: ((p: any, ...rest: any[]): any => {
      if (readFileSyncHook && typeof p === 'string') {
        readFileSyncHook(p); // may throw (ENOENT / EACCES) to simulate the race
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.readFileSync as any)(p, ...rest);
    }) as typeof actual.readFileSync,
  };
});

import {
  checkSourceText,
  loadAuthShapeHelpers,
  loadModelSettingsFieldKeys,
  runProviderGateCheck,
} from '../check-integration-test-provider-gates';

const FIXTURE_DIR = join(__dirname, 'fixtures', 'check-integration-test-provider-gates');
const REPO_ROOT = join(__dirname, '..', '..');

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

const HELPERS = loadAuthShapeHelpers(REPO_ROOT);
const LEGACY_FIELDS = loadModelSettingsFieldKeys();

function check(src: string, relPath: string) {
  return checkSourceText(src, relPath, HELPERS, LEGACY_FIELDS);
}

// ---------------------------------------------------------------------------
// loadAuthShapeHelpers — source-of-truth import
// ---------------------------------------------------------------------------

describe('loadAuthShapeHelpers', () => {
  it('parses AUTH_SHAPE_HELPERS from src/core/utils/authEnvUtils.ts', () => {
    expect(HELPERS).toEqual(
      expect.arrayContaining([
        'getAuthForDirectUse',
        'hasDirectAuth',
        'getApiKeyForDirectUse',
      ]),
    );
  });

  it('returns at least one helper (canary against accidental empty list)', () => {
    expect(HELPERS.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// loadModelSettingsFieldKeys — source-of-truth import
// ---------------------------------------------------------------------------

describe('loadModelSettingsFieldKeys', () => {
  it('imports MODEL_SETTINGS_FIELD_KEYS from the pure twin (source-of-truth, not AST parse)', () => {
    expect(LEGACY_FIELDS).toEqual(
      expect.arrayContaining([
        'model',
        'thinkingModel',
        'permissionMode',
        'apiKey',
        'oauthToken',
      ]),
    );
  });

  it('returns at least one field key (canary against accidental empty list)', () => {
    expect(LEGACY_FIELDS.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Fixture-driven grammar tests
// ---------------------------------------------------------------------------

describe('checkSourceText — fixture (a) correct pattern', () => {
  it('passes when isDirectAnthropicConfig is composed alongside auth-shape', () => {
    const src = readFixture('a-correct-pattern.fixture.ts');
    const { violations, suppressions } = check(src, 'a-correct-pattern.fixture.ts');
    expect(violations).toEqual([]);
    expect(suppressions).toEqual([]);
  });
});

describe('checkSourceText — fixture (b) auth-helper-only', () => {
  it('fails when canRun gates only on an auth-shape helper (the 260419 shape)', () => {
    const src = readFixture('b-auth-helper-only.fixture.ts');
    const { violations, suppressions } = check(src, 'b-auth-helper-only.fixture.ts');
    expect(suppressions).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0].gateLabel).toBe('canRun');
    expect(violations[0].reason).toMatch(/auth-shape helper/);
  });
});

describe('checkSourceText — fixture (c) raw-field-only', () => {
  it('fails when canRun gates only on a raw settings.claude?.apiKey field', () => {
    const src = readFixture('c-raw-field-only.fixture.ts');
    const { violations, suppressions } = check(src, 'c-raw-field-only.fixture.ts');
    expect(suppressions).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0].gateLabel).toBe('canRun');
    expect(violations[0].reason).toMatch(/raw auth field/);
  });
});

describe('checkSourceText — fixture (d) suppressed-with-justification', () => {
  it('passes (logged as suppression) when SKIP-GATE-INTENT has a non-empty reason', () => {
    const src = readFixture('d-suppressed-with-justification.fixture.ts');
    const { violations, suppressions } = check(src, 'd-suppressed-with-justification.fixture.ts');
    expect(violations).toEqual([]);
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0].justification).toMatch(/legacy migration/);
  });
});

describe('checkSourceText — fixture (e) suppressed-without-justification', () => {
  it('fails when SKIP-GATE-INTENT marker exists but the rationale is empty', () => {
    const src = readFixture('e-suppressed-without-justification.fixture.ts');
    const { violations, suppressions } = check(src, 'e-suppressed-without-justification.fixture.ts');
    expect(suppressions).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toMatch(/empty/);
  });
});

describe('checkSourceText — fixture (f) aliased import', () => {
  it('fails when an aliased auth-shape helper import gates canRun without provider-shape', () => {
    const src = readFixture('f-aliased-import-auth-helper-only.fixture.ts');
    const { violations, suppressions } = check(src, 'f-aliased-import-auth-helper-only.fixture.ts');
    expect(suppressions).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0].gateLabel).toBe('canRun');
    expect(violations[0].reason).toMatch(/auth-shape helper/);
  });

  it('passes when an aliased auth-shape helper import is composed with provider-shape', () => {
    const src = readFixture('f-aliased-import-correct-pattern.fixture.ts');
    const { violations, suppressions } = check(src, 'f-aliased-import-correct-pattern.fixture.ts');
    expect(violations).toEqual([]);
    expect(suppressions).toEqual([]);
  });
});

describe('checkSourceText — fixture (g) indirect alias', () => {
  it('fails when an indirect alias of an auth-shape helper gates canRun without provider-shape', () => {
    const src = readFixture('g-indirect-alias-auth-helper-only.fixture.ts');
    const { violations, suppressions } = check(src, 'g-indirect-alias-auth-helper-only.fixture.ts');
    expect(suppressions).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0].gateLabel).toBe('canRun');
    expect(violations[0].reason).toMatch(/auth-shape helper/);
  });

  it('passes when indirect aliases compose auth-shape and provider-shape', () => {
    const src = readFixture('g-indirect-alias-correct-pattern.fixture.ts');
    const { violations, suppressions } = check(src, 'g-indirect-alias-correct-pattern.fixture.ts');
    expect(violations).toEqual([]);
    expect(suppressions).toEqual([]);
  });
});

describe('checkSourceText — fixture (h) malformed TypeScript', () => {
  it('rejects malformed TypeScript instead of silently passing', () => {
    const src = readFixture('h-malformed-typescript.fixture.txt');
    expect(() => check(src, 'h-malformed-typescript.fixture.txt')).toThrow(
      /syntax|parse|malformed/i,
    );
  });
});

// ---------------------------------------------------------------------------
// 260507 — raw legacy-namespace model reads in integration tests
// ---------------------------------------------------------------------------

describe('checkSourceText — fixture (i) canonical-accessor model reads', () => {
  it('passes when reads go through getCurrentModel/getThinkingModel/getPermissionMode', () => {
    const src = readFixture('i-canonical-model-read.fixture.ts');
    const { violations, suppressions } = check(src, 'i-canonical-model-read.fixture.ts');
    expect(violations).toEqual([]);
    expect(suppressions).toEqual([]);
  });
});

describe('checkSourceText — fixture (j) legacy-namespace model read in body', () => {
  it('fails when settings.claude.model is read directly inside the test body', () => {
    const src = readFixture('j-legacy-model-read-in-body.fixture.ts');
    const { violations, suppressions } = check(src, 'j-legacy-model-read-in-body.fixture.ts');
    expect(suppressions).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0].gateLabel).toBe('legacy-model-read:model');
    expect(violations[0].reason).toMatch(/legacy-namespace read of '\.\.\.claude\.model'/);
    expect(violations[0].reason).toMatch(/getCurrentModel/);
  });

  it('would have flagged the old fullPath mockSettings.claude.model body read', () => {
    const src = `
      import { describe, it } from 'vitest';
      import {
        getApiKeyForDirectUse,
        isDirectAnthropicConfig,
      } from '@core/utils/authEnvUtils';
      import { resolveModelConfig } from '@shared/utils/modelNormalization';
      import type { AppSettings } from '@shared/types';
      declare const realSettings: AppSettings;
      declare const mockSettings: AppSettings;

      const canRun = isDirectAnthropicConfig(realSettings) && !!getApiKeyForDirectUse(realSettings);

      describe.skipIf(!canRun)('Full-Path Integration (real settings)', () => {
        it('should produce AgentMessage shapes the handler expects', async () => {
          const modelConfig = resolveModelConfig(mockSettings.claude.model, null, false);
          void modelConfig;
        });
      });
    `;
    const { violations } = check(src, 'fullPath.integration.test.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0].gateLabel).toBe('legacy-model-read:model');
  });

  it('flags thinkingModel and permissionMode reads with the right field label', () => {
    const src = `
      import { describe, it } from 'vitest';
      import {
        getApiKeyForDirectUse,
        isDirectAnthropicConfig,
      } from '@core/utils/authEnvUtils';
      import type { AppSettings } from '@shared/types';
      declare const settings: AppSettings;

      const canRun = isDirectAnthropicConfig(settings) && !!getApiKeyForDirectUse(settings);

      describe.skipIf(!canRun)('multi-field leak', () => {
        it('reads thinkingModel and permissionMode', () => {
          const t = settings.claude.thinkingModel;
          const p = settings.claude.permissionMode;
          void t;
          void p;
        });
      });
    `;
    const { violations } = check(src, 'multi-field.integration.test.ts');
    const labels = violations.map((v) => v.gateLabel).sort();
    expect(labels).toEqual([
      'legacy-model-read:permissionMode',
      'legacy-model-read:thinkingModel',
    ]);
  });

  it('matches regardless of root identifier (suffix-only check)', () => {
    const src = `
      import { describe, it } from 'vitest';
      import {
        getApiKeyForDirectUse,
        isDirectAnthropicConfig,
      } from '@core/utils/authEnvUtils';
      import type { AppSettings } from '@shared/types';
      declare const myCfg: AppSettings;

      const canRun = isDirectAnthropicConfig(myCfg) && !!getApiKeyForDirectUse(myCfg);

      describe.skipIf(!canRun)('alternate root identifier', () => {
        it('still flags myCfg.claude.model', () => {
          const w = myCfg.claude.model;
          void w;
        });
      });
    `;
    const { violations } = check(src, 'alt-root.integration.test.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0].gateLabel).toBe('legacy-model-read:model');
  });
});

describe('checkSourceText — fixture (k) legacy-namespace model read suppressed', () => {
  it('passes (logged as suppression) when SKIP-GATE-INTENT has a non-empty rationale', () => {
    const src = readFixture('k-legacy-model-read-suppressed.fixture.ts');
    const { violations, suppressions } = check(src, 'k-legacy-model-read-suppressed.fixture.ts');
    expect(violations).toEqual([]);
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0].gateLabel).toBe('legacy-model-read:thinkingModel');
    expect(suppressions[0].justification).toMatch(/migration/);
  });

  it('applies same-line SKIP-GATE-INTENT suppressions in both gate and body-scan contexts', () => {
    const src = `
      import { describe, it } from 'vitest';
      import type { AppSettings } from '@shared/types';
      declare const settings: AppSettings;

      const canRun = !!settings.claude.apiKey; // SKIP-GATE-INTENT: legacy auth-shape fixture intentionally omits provider-shape gate

      describe.skipIf(!canRun)('same-line suppressions', () => {
        it('reads legacy model on a same-line suppressed statement', () => {
          const w = settings.claude.model; // SKIP-GATE-INTENT: legacy mirror assertion during migration
          void w;
        });
      });
    `;
    const { violations, suppressions } = check(src, 'same-line-suppression.integration.test.ts');
    expect(violations).toEqual([]);
    expect(suppressions.map((s) => s.gateLabel).sort()).toEqual([
      'canRun',
      'legacy-model-read:model',
    ]);
  });

  it('fails when the SKIP-GATE-INTENT marker has no rationale', () => {
    const src = `
      import { describe, it } from 'vitest';
      import {
        getApiKeyForDirectUse,
        isDirectAnthropicConfig,
      } from '@core/utils/authEnvUtils';
      import type { AppSettings } from '@shared/types';
      declare const settings: AppSettings;

      const canRun = isDirectAnthropicConfig(settings) && !!getApiKeyForDirectUse(settings);

      describe.skipIf(!canRun)('empty rationale', () => {
        it('reads with an empty SKIP marker', () => {
          // SKIP-GATE-INTENT:
          const w = settings.claude.model;
          void w;
        });
      });
    `;
    const { violations, suppressions } = check(src, 'empty-rationale.integration.test.ts');
    expect(suppressions).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0].gateLabel).toBe('legacy-model-read:model');
    expect(violations[0].reason).toMatch(/empty/);
  });
});

// ---------------------------------------------------------------------------
// describe.skipIf direct call expression (no canRun binding)
// ---------------------------------------------------------------------------

describe('checkSourceText — describe.skipIf direct argument', () => {
  it('catches a misuse passed inline to describe.skipIf', () => {
    const src = `
      import { describe } from 'vitest';
      import { getApiKeyForDirectUse } from '@core/utils/authEnvUtils';
      import type { AppSettings } from '@shared/types';
      declare const settings: AppSettings;

      describe.skipIf(!getApiKeyForDirectUse(settings))('inline gate', () => {});
    `;
    const { violations } = check(src, 'inline.integration.test.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0].gateLabel).toBe('describe.skipIf');
  });
});

// ---------------------------------------------------------------------------
// 260507 Phase-6 — local-helper recursion in gate analysis
// ---------------------------------------------------------------------------

describe('checkSourceText — fixture (l) local-helper auth-shape only', () => {
  it('flags a canRun binding whose initializer calls a local helper that composes auth-shape only', () => {
    const src = readFixture('l-local-helper-auth-only.fixture.ts');
    const { violations, suppressions } = check(src, 'l-local-helper-auth-only.fixture.ts');
    expect(suppressions).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0].gateLabel).toBe('canRun');
    expect(violations[0].reason).toMatch(/auth-shape helper/);
  });

  it('flags an arrow-form local helper composed into canRun without provider-shape', () => {
    const src = `
      import { describe } from 'vitest';
      import { getApiKeyForDirectUse } from '@core/utils/authEnvUtils';
      import type { AppSettings } from '@shared/types';
      declare const settings: AppSettings;

      const hasRequiredSetup = (s: AppSettings) => !!getApiKeyForDirectUse(s);
      const canRun = hasRequiredSetup(settings);

      describe.skipIf(!canRun)('arrow-form helper leak', () => {});
    `;
    const { violations } = check(src, 'arrow-helper.integration.test.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0].gateLabel).toBe('canRun');
    expect(violations[0].reason).toMatch(/auth-shape helper/);
  });

  it('caps recursion depth so mutually-recursive helpers terminate', () => {
    const src = `
      import { describe } from 'vitest';
      import { getApiKeyForDirectUse } from '@core/utils/authEnvUtils';
      import type { AppSettings } from '@shared/types';
      declare const settings: AppSettings;

      function helperA(s: AppSettings): boolean { return helperB(s); }
      function helperB(s: AppSettings): boolean { return helperA(s) || !!getApiKeyForDirectUse(s); }
      const canRun = helperA(settings);

      describe.skipIf(!canRun)('mutually-recursive helpers', () => {});
    `;
    const { violations } = check(src, 'mutual-recursion.integration.test.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0].gateLabel).toBe('canRun');
  });
});

describe('checkSourceText — fixture (m) local-helper auth + provider-shape', () => {
  it('passes when canRun calls a local helper that composes both auth-shape and provider-shape', () => {
    const src = readFixture('m-local-helper-auth-and-provider.fixture.ts');
    const { violations, suppressions } = check(src, 'm-local-helper-auth-and-provider.fixture.ts');
    expect(violations).toEqual([]);
    expect(suppressions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 260507 Round-3 — legacy-model read inside a correctly-composed gate
// ---------------------------------------------------------------------------

describe('checkSourceText — fixture (n) legacy-model-read inside gate', () => {
  it('flags settings.claude.model inside an otherwise-correct gate composition', () => {
    const src = readFixture('n-legacy-model-read-in-gate.fixture.ts');
    const { violations, suppressions } = check(src, 'n-legacy-model-read-in-gate.fixture.ts');
    expect(suppressions).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0].gateLabel).toBe('legacy-model-read:model');
    expect(violations[0].reason).toMatch(/legacy-namespace read of '\.\.\.claude\.model'/);
  });

  it('still dedups raw auth-field reads (claude.apiKey) inside gate ranges', () => {
    // Regression check: the dedup change must continue suppressing the
    // body-scan report for `claude.apiKey` inside a gate, otherwise
    // fixture (c) and similar tests would double-report.
    const src = `
      import { describe } from 'vitest';
      import type { AppSettings } from '@shared/types';
      declare const settings: AppSettings | null;

      const canRun = !!settings?.claude?.apiKey;

      describe.skipIf(!canRun)('raw-field gate dedups apiKey', () => {});
    `;
    const { violations } = check(src, 'dedup-apikey.integration.test.ts');
    // Exactly ONE report — the gate-composition violation, not a
    // duplicate legacy-model-read:apiKey from the body-scan pass.
    expect(violations).toHaveLength(1);
    expect(violations[0].gateLabel).toBe('canRun');
  });
});

// ---------------------------------------------------------------------------
// Stage 6 — live-API tests must use the shared harness
// ---------------------------------------------------------------------------

describe('checkSourceText — live-API harness requirement', () => {
  it('flags a live integration test without the liveApiHarness import', () => {
    const src = `
      import { it } from 'vitest';

      it('does a live call', () => {});
    `;
    const { violations } = check(src, 'tests/live-api/missing.live.integration.test.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0].gateLabel).toBe('live-harness-required');
    expect(violations[0].reason).toMatch(/src\/test-utils\/liveApiHarness/);
  });

  it('passes a live integration test with the liveApiHarness import', () => {
    const src = `
      import { it } from 'vitest';
      import { describeLiveApi } from '../../src/test-utils/liveApiHarness';

      describeLiveApi(
        { provider: 'openai', label: 'live', envVar: 'TEST_OPENAI_API_KEY', model: 'gpt-5-nano' },
        () => {
          it('does a live call', () => {});
        },
      );
    `;
    const { violations } = check(src, 'tests/live-api/with-harness.live.integration.test.ts');
    expect(violations).toEqual([]);
  });

  it('rejects an empty SKIP-LIVE-HARNESS-INTENT marker', () => {
    const src = `
      // SKIP-LIVE-HARNESS-INTENT:
      import { it } from 'vitest';

      it('does a live call', () => {});
    `;
    const { violations } = check(src, 'tests/live-api/empty-intent.live.integration.test.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0].gateLabel).toBe('live-harness-required');
    expect(violations[0].reason).toMatch(/rationale was empty/);
  });

  it('allows a non-empty SKIP-LIVE-HARNESS-INTENT marker', () => {
    const src = `
      // SKIP-LIVE-HARNESS-INTENT: fixture exercises the escape hatch grammar
      import { it } from 'vitest';

      it('does a live call', () => {});
    `;
    const { violations } = check(src, 'tests/live-api/intent.live.integration.test.ts');
    expect(violations).toEqual([]);
  });

  it('does not apply the harness rule to non-live integration tests', () => {
    const src = `
      import { it } from 'vitest';

      it('does a regular integration check', () => {});
    `;
    const { violations } = check(src, 'tests/regular.integration.test.ts');
    expect(violations).toEqual([]);
  });

  // Review F2 — a look-alike local stub must NOT satisfy the gate (it
  // re-implements none of the five invariants). Only the anchored real-harness
  // specifier counts.
  it('flags a live integration test that imports a look-alike local harness stub', () => {
    const src = `
      import { it } from 'vitest';
      import { describeLiveApi } from './local-test-utils/liveApiHarness';

      describeLiveApi({}, () => { it('does a live call', () => {}); });
    `;
    const { violations } = check(src, 'tests/live-api/lookalike.live.integration.test.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0].gateLabel).toBe('live-harness-required');
  });

  it('accepts the @test-utils alias form of the harness import', () => {
    const src = `
      import { it } from 'vitest';
      import { describeLiveApi } from '@test-utils/liveApiHarness';

      describeLiveApi({}, () => { it('does a live call', () => {}); });
    `;
    const { violations } = check(src, 'tests/live-api/alias.live.integration.test.ts');
    expect(violations).toEqual([]);
  });

  // Review F3 — the intent marker is honoured only as a real line-comment, not
  // when it appears inside a string literal.
  it('does not honour a SKIP-LIVE-HARNESS-INTENT marker embedded in a string literal', () => {
    const src = `
      import { it } from 'vitest';
      const doc = 'see // SKIP-LIVE-HARNESS-INTENT: not a real waiver';

      it('does a live call', () => { void doc; });
    `;
    const { violations } = check(src, 'tests/live-api/string-marker.live.integration.test.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0].gateLabel).toBe('live-harness-required');
  });
});

// ---------------------------------------------------------------------------
// TOCTOU mid-scan deletion (260623) — vanishedDuringScan wiring at the twin
// ---------------------------------------------------------------------------
//
// Pins the twin-level discriminator: when a *.integration.test.ts file
// enumerated by the walk vanishes mid-scan (ENOENT), runProviderGateCheck must
// increment `vanishedDuringScan`, skip the file (no throw, violations logic
// untouched). A non-ENOENT read error (EACCES) must still throw — fail-closed.
// Uses the same `node:fs` module-mock as the token-drift test; the scanner's
// `readFileToleratingVanished` calls `fs.readFileSync`, intercepted per-path.
const providerGateTempRoots: string[] = [];

afterEach(() => {
  readFileSyncHook = null;
  for (const root of providerGateTempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Build a minimal repo root that runProviderGateCheck can traverse: it needs
 * `src/core/utils/authEnvUtils.ts` (AST-parsed for AUTH_SHAPE_HELPERS — a
 * fixed source-of-truth path, NOT walked) plus one walked
 * `*.integration.test.ts` whose read we hook.
 */
function makeProviderGateRoot(integrationTestRel: string): {
  root: string;
  integrationTestAbs: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'provider-gates-toctou-'));
  providerGateTempRoots.push(root);

  const authEnvPath = join(root, 'src', 'core', 'utils', 'authEnvUtils.ts');
  mkdirSync(join(root, 'src', 'core', 'utils'), { recursive: true });
  writeFileSync(
    authEnvPath,
    "export const AUTH_SHAPE_HELPERS = ['getApiKeyForDirectUse'] as const;\n",
  );

  const integrationTestAbs = join(root, integrationTestRel);
  mkdirSync(join(integrationTestAbs, '..'), { recursive: true });
  writeFileSync(
    integrationTestAbs,
    "import { it } from 'vitest';\nit('noop', () => {});\n",
  );

  return { root, integrationTestAbs };
}

describe('runProviderGateCheck — TOCTOU mid-scan deletion (ENOENT vs EACCES)', () => {
  it('increments vanishedDuringScan and skips a file that vanished mid-scan (ENOENT)', () => {
    const { root, integrationTestAbs } = makeProviderGateRoot(
      join('src', 'feature', 'vanished.integration.test.ts'),
    );
    readFileSyncHook = (p) => {
      if (p === integrationTestAbs) {
        const err = new Error(
          `ENOENT: no such file or directory, open '${p}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
    };

    let result: ReturnType<typeof runProviderGateCheck> | undefined;
    expect(() => {
      result = runProviderGateCheck(root);
    }).not.toThrow();
    expect(result!.vanishedDuringScan).toBeGreaterThanOrEqual(1);
    // Violations logic untouched: the skipped file produced no violations.
    expect(result!.violations).toEqual([]);
  });

  it('still throws (fail-closed) for a non-ENOENT read error (EACCES)', () => {
    const { root, integrationTestAbs } = makeProviderGateRoot(
      join('src', 'feature', 'unreadable.integration.test.ts'),
    );
    readFileSyncHook = (p) => {
      if (p === integrationTestAbs) {
        const err = new Error(
          `EACCES: permission denied, open '${p}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
    };

    expect(() => runProviderGateCheck(root)).toThrow(/EACCES/);
  });
});

// ---------------------------------------------------------------------------
// Real-repo canary
// ---------------------------------------------------------------------------

describe('real repo at HEAD', () => {
  it('passes the integration-test provider-gate check (canary against regression)', () => {
    const result = runProviderGateCheck(REPO_ROOT);
    if (result.violations.length > 0) {
      const summary = result.violations
        .map((v) => `  ${v.file}:${v.line}:${v.column} (${v.gateLabel}) — ${v.reason}`)
        .join('\n');
      throw new Error(
        `Real repo failed integration-test provider-gate check:\n${summary}`,
      );
    }
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });
});
