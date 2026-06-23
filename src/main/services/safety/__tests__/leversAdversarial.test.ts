/**
 * Adversarial tests for Lever B (260525_approval_overasking_diagnostic.md).
 *
 * The bda78829 simulator proves the lever cuts routine over-asking from 29
 * approvals to 2. These tests probe the OPPOSITE direction: does the lever
 * ever auto-approve something it shouldn't?
 *
 * Each test names the attack scenario, sets up the smallest possible state
 * to reproduce it, and asserts the safe outcome.
 *
 * Coverage:
 *   - Credentials in opted-in shared spaces (still gate via secret check).
 *   - HR / salary / legal / PII content in opted-in shared spaces (LLM judges).
 *   - Private Mode override (cautious wins regardless).
 *   - `low` confidence under the medium floor (still gated).
 *   - `block` decisions under the medium floor (still gated).
 *   - Read-only tools always allowed at medium regardless of floor.
 *   - Unknown spaces remain cautious (no override possible).
 *   - Undefined sharing keeps the balanced floor (corrupted frontmatter).
 */

import { describe, it, expect } from 'vitest';
import type { AppSettings, ModelSettings, SpaceConfig } from '@shared/types';
import { resolveMemorySafetyLevel } from '../memoryWriteHook';
import { shouldAllow } from '@core/safetyPromptLogic';
import type { SafetyEvalResult } from '@core/safetyPromptTypes';
import { containsCredentialPatterns } from '@core/utils/logRedaction';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type SettingsOverrides = Partial<Omit<AppSettings, 'models'>> & {
  models?: Partial<ModelSettings>;
};

function settingsWith(overrides: SettingsOverrides = {}): AppSettings {
  const { models: modelOverrides, ...rootOverrides } = overrides;
  const models: ModelSettings = {
    apiKey: null,
    oauthToken: null,
    authMethod: 'api-key',
    model: 'claude-sonnet-4-5-20250514',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: true,
    extendedContext: true,
    thinkingEffort: 'high',
    ...modelOverrides,
  };
  return {
    coreDirectory: '/workspace',
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'gpt-4o-mini-transcribe-2025-12-15',
      ttsVoice: 'nova',
      activationHotkey: null,
      activationHotkeyVoiceMode: true,
    },
    models,
    diagnostics: { debugBreadcrumbsUntil: null },
    ...rootOverrides,
  };
}

function space(path: string, type: SpaceConfig['type'] = 'team', sharing: SpaceConfig['sharing'] = 'company-wide'): SpaceConfig {
  return {
    name: path.split('/').pop() || path,
    path,
    type,
    sharing,
    isSymlink: false,
    createdAt: 0,
  };
}

const ALLOW_MEDIUM: SafetyEvalResult = {
  decision: 'allow',
  confidence: 'medium',
  reason: 'looks fine',
};
const ALLOW_LOW: SafetyEvalResult = {
  decision: 'allow',
  confidence: 'low',
  reason: 'unclear',
};
const ALLOW_HIGH: SafetyEvalResult = {
  decision: 'allow',
  confidence: 'high',
  reason: 'clearly fine',
};
const BLOCK: SafetyEvalResult = {
  decision: 'block',
  confidence: 'high',
  reason: 'policy violation',
};

// ─── 1. Credentials in non-private permissive shared spaces ─────────────────

describe('adversarial: credentials in non-private permissive shared space', () => {
  const settings = settingsWith({
    spaces: [space('work/Acme/General', 'team', 'company-wide')],
    spaceSafetyLevels: { 'work/Acme/General': 'permissive' },
  });

  it('the resolved level is permissive (user choice honoured)', () => {
    const r = resolveMemorySafetyLevel('work/Acme/General', 'company-wide', settings, false);
    expect(r.level).toBe('permissive');
  });

  it('but containsCredentialPatterns still flags real credentials in the content', () => {
    const credContent = 'API_KEY=***********************************';
    const result = containsCredentialPatterns(credContent);
    expect(result.detected).toBe(true);
  });

  it('and structural credentials in JSON are flagged', () => {
    const jsonCred = '{"password": "MyR3@lP4ssw0rd!23", "user": "admin"}';
    const result = containsCredentialPatterns(jsonCred);
    expect(result.detected).toBe(true);
  });

  // The secret gate in memoryWriteHook.ts (`effectiveTrust === 'permissive'`
  // branch) runs containsCredentialPatterns and stages on a hit. Lever B
  // does NOT change that gate.
});

// ─── 2. HR / salary / legal content — LLM is the judge ──────────────────────

describe('adversarial: HR / salary / legal content in non-private permissive shared space', () => {
  const settings = settingsWith({
    spaces: [space('work/Acme/General', 'team', 'company-wide')],
    spaceSafetyLevels: { 'work/Acme/General': 'permissive' },
  });

  // The auto-approve fast path is scoped to private/CoS only. Non-private
  // permissive falls through to the LLM-eval branch, where:
  //   - The LLM sees the content and applies the user's safety prompt.
  //   - shouldAllow uses confidenceFloor: 'medium' for permissive, so
  //     routine writes pass on `allow + medium` but `block` decisions still
  //     surface approval cards.
  //   - HR / legal / PII content the LLM judges sensitive will still gate.
  //
  // The tests below confirm:
  //   (a) containsCredentialPatterns ALONE cannot detect this content
  //       (so a credential-only bypass would have been unsafe).
  //   (b) The resolved level is permissive but the medium floor still
  //       defers `block` and `low` decisions to the LLM.

  it('PROBE: HR salary content does not match credentialPatterns', () => {
    const hr = `
# Q4 Compensation Review — Engineering
Alex Chen — base $185,000, bonus $32,000, perf rating: exceeds
Brooke Kim — base $172,000, bonus $24,000, perf rating: meets
Carlos Diaz — base $210,000, bonus $48,000, perf rating: exceeds
Engineering org total comp delta: +$1.2M YoY.
`;
    const result = containsCredentialPatterns(hr);
    expect(result.detected).toBe(false);
  });

  it('PROBE: legal-dispute notes do not match credentialPatterns', () => {
    const legal = `
# Avion-Rebel Contract Dispute — Privileged
Counsel: outside firm Smith & Lang
Theory of damages: breach of MSA §7.2, exposure ~$2.4M.
Settlement floor: $400k cash + 12-month migration credit.
Do NOT share with Avion or any non-legal stakeholder.
`;
    const result = containsCredentialPatterns(legal);
    expect(result.detected).toBe(false);
  });

  it('PROBE: customer PII (SSN-like) does not match credentialPatterns', () => {
    const pii = `
Customer record: J. Doe, DOB 1987-04-12
SSN: 123-45-6789  (verified by call)
Address: 742 Evergreen Ter, Springfield
Health note: T1 diabetic, EpiPen required for visits.
`;
    const result = containsCredentialPatterns(pii);
    expect(result.detected).toBe(false);
  });

  it('CLOSURE: resolved level is permissive but the LLM is the judge under the medium floor', () => {
    // memoryWriteHook.ts routes non-private permissive writes through the
    // balanced/permissive LLM-eval branch. The `if (effectiveTrust ===
    // 'permissive')` branch passes confidenceFloor: 'medium', so:
    //   - LLM `allow + high`     → pass
    //   - LLM `allow + medium`   → pass (Lever B win)
    //   - LLM `allow + low`      → block
    //   - LLM `block`            → block (HR/legal/PII safety)
    //
    // Spaces still skipped (auto-approve fast path): private and verified
    // CoS, via shouldSkipSecretGateForPermissive.
    const r = resolveMemorySafetyLevel('work/Acme/General', 'company-wide', settings, false);
    expect(r.level).toBe('permissive');
    // LLM `block` still gates regardless of floor.
    expect(shouldAllow(BLOCK, 'Edit', { confidenceFloor: 'medium' })).toBe(false);
    expect(shouldAllow(BLOCK, 'memory_write', { confidenceFloor: 'medium' })).toBe(false);
    // LLM `allow + low` still gates regardless of floor.
    expect(shouldAllow(ALLOW_LOW, 'Edit', { confidenceFloor: 'medium' })).toBe(false);
  });
});

// ─── 3. No spaceSafetyLevels override → default still applies ───────────────

describe('adversarial: shared space without an explicit per-space override stays balanced', () => {
  it('non-private with no override -> balanced (Lever B has nothing to honour)', () => {
    const settings = settingsWith({
      spaces: [space('work/Acme/General', 'team', 'company-wide')],
    });
    const r = resolveMemorySafetyLevel('work/Acme/General', 'company-wide', settings, false);
    expect(r.level).toBe('balanced');
  });

  it('explicit balanced stays balanced (no lever-induced upgrade)', () => {
    const settings = settingsWith({
      spaces: [space('work/Acme/General', 'team', 'company-wide')],
      spaceSafetyLevels: { 'work/Acme/General': 'balanced' },
    });
    const r = resolveMemorySafetyLevel('work/Acme/General', 'company-wide', settings, false);
    expect(r.level).toBe('balanced');
  });

  it('explicit cautious stays cautious', () => {
    const settings = settingsWith({
      spaces: [space('work/Acme/General', 'team', 'company-wide')],
      spaceSafetyLevels: { 'work/Acme/General': 'cautious' },
    });
    const r = resolveMemorySafetyLevel('work/Acme/General', 'company-wide', settings, false);
    expect(r.level).toBe('cautious');
  });
});

// ─── 4. Private Mode override (cautious wins regardless) ────────────────────

describe('adversarial: Private Mode forces cautious even with explicit permissive', () => {
  const settings = settingsWith({
    spaces: [space('work/Acme/General', 'team', 'company-wide')],
    spaceSafetyLevels: { 'work/Acme/General': 'permissive' },
  });

  it('private mode forces cautious despite an explicit permissive setting', () => {
    const r = resolveMemorySafetyLevel('work/Acme/General', 'company-wide', settings, true);
    expect(r.level).toBe('cautious');
  });
});

// ─── 5. Confidence floors stay correctly bounded ────────────────────────────

describe('adversarial: shouldAllow medium floor never weakens the safety semantics it inherits', () => {
  it('low confidence is still rejected even with medium floor (never auto-allowed)', () => {
    expect(shouldAllow(ALLOW_LOW, 'Edit', { confidenceFloor: 'medium' })).toBe(false);
    expect(shouldAllow(ALLOW_LOW, 'memory_write', { confidenceFloor: 'medium' })).toBe(false);
    expect(shouldAllow(ALLOW_LOW, 'Bash', { confidenceFloor: 'medium' })).toBe(false);
  });

  it('block decisions are NEVER auto-allowed regardless of floor', () => {
    expect(shouldAllow(BLOCK, 'Edit', { confidenceFloor: 'high' })).toBe(false);
    expect(shouldAllow(BLOCK, 'Edit', { confidenceFloor: 'medium' })).toBe(false);
    expect(shouldAllow(BLOCK, 'Read', { confidenceFloor: 'medium' })).toBe(false);
  });

  it('high confidence still works (no over-tightening)', () => {
    expect(shouldAllow(ALLOW_HIGH, 'Edit', { confidenceFloor: 'high' })).toBe(true);
    expect(shouldAllow(ALLOW_HIGH, 'Edit', { confidenceFloor: 'medium' })).toBe(true);
    expect(shouldAllow(ALLOW_HIGH, 'Read', { confidenceFloor: 'high' })).toBe(true);
  });

  it('medium floor only relaxes side-effect tools — read-only tools always allowed at medium', () => {
    expect(shouldAllow(ALLOW_MEDIUM, 'Read', { confidenceFloor: 'high' })).toBe(true);
    expect(shouldAllow(ALLOW_MEDIUM, 'Glob', { confidenceFloor: 'high' })).toBe(true);
  });
});

// ─── 6. Side-effect verb gating untouched outside the memory-write hook ─────

describe('adversarial: existing SIDE_EFFECT_VERBS still gate at high confidence by default', () => {
  it('Edit (in SIDE_EFFECT_VERBS) requires high confidence by default', () => {
    expect(shouldAllow(ALLOW_MEDIUM, 'Edit')).toBe(false);
    expect(shouldAllow(ALLOW_HIGH, 'Edit')).toBe(true);
  });

  it('slack_send_message still requires high confidence by default', () => {
    expect(shouldAllow(ALLOW_MEDIUM, 'slack_send_message')).toBe(false);
    expect(shouldAllow(ALLOW_HIGH, 'slack_send_message')).toBe(true);
  });

  it('memory_write and Write are NOT in SIDE_EFFECT_VERBS — pass at medium by default', () => {
    // memory_write and the built-in Write tool are excluded from
    // SIDE_EFFECT_VERBS by design — they're gated by the dedicated
    // memoryWriteHook path, not the generic side-effect floor.
    expect(shouldAllow(ALLOW_MEDIUM, 'memory_write')).toBe(true);
    expect(shouldAllow(ALLOW_MEDIUM, 'Write')).toBe(true);
  });

  it('read-only tools (gmail_search_emails, list_workspaces) pass at medium', () => {
    expect(shouldAllow(ALLOW_MEDIUM, 'gmail_search_emails')).toBe(true);
    expect(shouldAllow(ALLOW_MEDIUM, 'list_workspaces')).toBe(true);
  });
});

// ─── 7. Unknown / corrupted-frontmatter paths stay safe ─────────────────────

describe('adversarial: unknown spaces and undefined sharing remain safe', () => {
  const settings = settingsWith({
    spaceSafetyLevels: { 'work/Acme/General': 'permissive' },
  });

  it('null spacePath -> cautious', () => {
    const r = resolveMemorySafetyLevel(null, 'company-wide', settings, false);
    expect(r.level).toBe('cautious');
  });

  it('a path NOT in spaceSafetyLevels and NOT in spaces config -> default balanced', () => {
    const r = resolveMemorySafetyLevel('random/path', 'company-wide', settings, false);
    expect(r.level).toBe('balanced');
  });

  it('undefined sharing keeps the balanced floor (corrupted/missing frontmatter)', () => {
    // Undefined sharing isn't an explicit user choice, so we stay
    // conservative even if the level is set to permissive.
    const settings2 = settingsWith({
      spaceSafetyLevels: { 'work/Legacy/OldSpace': 'permissive' },
    });
    const r = resolveMemorySafetyLevel('work/Legacy/OldSpace', undefined, settings2, false);
    expect(r.level).toBe('balanced');
  });
});
