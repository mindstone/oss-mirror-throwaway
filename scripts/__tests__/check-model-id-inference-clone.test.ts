import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findCloneViolations } from '../check-model-id-inference-clone';
import {
  hasCloneSignature,
  isAllowlisted,
  isTestFile,
  MODEL_ID_CLONE_ALLOWLIST,
} from '../model-id-clone-config.mjs';
import { STEPS } from '../run-validate-fast';

const REPO_ROOT = process.cwd();

// The clone shape WS0 eliminated: a function inferring a provider by chaining the
// per-family bare-prefix arms (claude- + gpt-). This is what must FIRE.
const CLONE_SNIPPET = `
  function inferProviderClone(modelId: string): string | undefined {
    if (modelId.includes('/')) return 'openrouter';
    if (modelId.startsWith('claude-')) return 'anthropic';
    if (modelId.startsWith('gpt-')) return 'openai';
    return undefined;
  }
`;

// Single-arm shapes that legitimately survive (must NOT fire): a claude-only
// gate, a slash-form boolean, a gpt-only sniff.
const CLAUDE_ONLY_GATE = `if (model.startsWith('claude-')) { useDirectAnthropic(); }`;
const SLASH_FORM_BOOLEAN = `const isSlash = model.includes('/');`;
const GPT_ONLY_SNIFF = `const isGpt = model.startsWith('gpt-');`;

describe('check-model-id-inference-clone', () => {
  describe('signature detection', () => {
    it('FIRES on a re-introduced provider-inference clone (claude- + gpt- chained)', () => {
      expect(hasCloneSignature(CLONE_SNIPPET)).toBe(true);
    });

    it('does NOT fire on a claude-only gate (documented WS0 LEFT shape)', () => {
      expect(hasCloneSignature(CLAUDE_ONLY_GATE)).toBe(false);
    });

    it('does NOT fire on a bare slash-form boolean (documented WS0 LEFT shape)', () => {
      expect(hasCloneSignature(SLASH_FORM_BOOLEAN)).toBe(false);
    });

    it('does NOT fire on a gpt-only sniff', () => {
      expect(hasCloneSignature(GPT_ONLY_SNIFF)).toBe(false);
    });

    it('does NOT match the `model-` label prefix or other unrelated startsWith', () => {
      expect(hasCloneSignature("const p = name.startsWith('model-');")).toBe(false);
    });
  });

  describe('minimal allowlist', () => {
    it('is exactly the three audited two-arm sites (no broad hot files)', () => {
      expect([...MODEL_ID_CLONE_ALLOWLIST].sort()).toEqual(
        [
          'src/shared/utils/modelIdClassifier.ts',
          'src/shared/utils/providerSwitch.ts',
          'src/shared/utils/settingsUtils.ts',
        ].sort(),
      );
    });

    it('does NOT allowlist hot routing files (so a clone re-added there IS caught)', () => {
      expect(isAllowlisted('src/core/rebelCore/providerRouting.ts')).toBe(false);
      expect(isAllowlisted('src/core/rebelCore/providerRouteDecision.ts')).toBe(false);
      expect(isAllowlisted('src/core/services/turnPipeline/agentTurnExecute.ts')).toBe(false);
      expect(isAllowlisted('src/main/services/councilService.ts')).toBe(false);
    });

    it('every allowlist entry still exists AND genuinely carries the two-arm signature today', () => {
      for (const rel of MODEL_ID_CLONE_ALLOWLIST) {
        const abs = path.join(REPO_ROOT, rel);
        expect(fs.existsSync(abs), `allowlisted file missing (stale entry?): ${rel}`).toBe(true);
        // A file that no longer co-occurs both sniffs should be REMOVED from the
        // allowlist (otherwise it is a needless hole). Catch that drift here.
        expect(
          hasCloneSignature(fs.readFileSync(abs, 'utf8')),
          `allowlisted file no longer has the two-arm signature — remove it: ${rel}`,
        ).toBe(true);
      }
    });

    it('treats test files as exempt', () => {
      expect(isTestFile('src/shared/utils/__tests__/modelIdClassifier.truthTable.test.ts')).toBe(true);
      expect(isTestFile('src/foo/bar.test.ts')).toBe(true);
      expect(isTestFile('src/foo/bar.ts')).toBe(false);
    });
  });

  describe('end-to-end scan against the real tree', () => {
    // Inject/clean a real clone file in a non-allowlisted path so we exercise the
    // ACTUAL guard (native candidate discovery → filters → signature), not just the
    // helper. Path chosen to be obviously non-allowlisted and self-evidently a probe.
    const PROBE_REL = 'src/core/services/__cloneGuardProbe.ts';
    const PROBE_ABS = path.join(REPO_ROOT, PROBE_REL);
    // .tsx probe: `rg --type ts` (and now the native walk) covers *.tsx, not just
    // *.ts — a clone re-added in a .tsx source must still be caught.
    const PROBE_TSX_REL = 'src/core/services/__cloneGuardProbe.tsx';
    const PROBE_TSX_ABS = path.join(REPO_ROOT, PROBE_TSX_REL);
    const TEST_PROBE_REL = 'src/core/services/__cloneGuardProbe.test.ts';
    const TEST_PROBE_ABS = path.join(REPO_ROOT, TEST_PROBE_REL);

    afterEach(() => {
      if (fs.existsSync(PROBE_ABS)) fs.rmSync(PROBE_ABS);
      if (fs.existsSync(PROBE_TSX_ABS)) fs.rmSync(PROBE_TSX_ABS);
      if (fs.existsSync(TEST_PROBE_ABS)) fs.rmSync(TEST_PROBE_ABS);
    });

    it('returns 0 offenders on the current tree (genuine green-on-tree proof)', () => {
      expect(findCloneViolations(REPO_ROOT)).toEqual([]);
    });

    it('returns the injected clone as an offender (true negative control)', () => {
      fs.writeFileSync(PROBE_ABS, CLONE_SNIPPET, 'utf8');
      const violations = findCloneViolations(REPO_ROOT);
      expect(violations).toContain(PROBE_REL);
    });

    it('catches a clone injected into a .tsx source (TS-type coverage parity)', () => {
      fs.writeFileSync(PROBE_TSX_ABS, CLONE_SNIPPET, 'utf8');
      const violations = findCloneViolations(REPO_ROOT);
      expect(violations).toContain(PROBE_TSX_REL);
    });

    it('does NOT flag a clone written into a *.test.ts path (test-file exemption)', () => {
      fs.writeFileSync(TEST_PROBE_ABS, CLONE_SNIPPET, 'utf8');
      expect(findCloneViolations(REPO_ROOT)).not.toContain(TEST_PROBE_REL);
    });
  });

  it('is wired into validate:fast', () => {
    expect(STEPS.map((step) => step.name)).toContain('check-model-id-inference-clone');
  });
});
