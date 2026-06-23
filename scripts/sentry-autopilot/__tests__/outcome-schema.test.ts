import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FailureKind, OutcomeSchema, parseOutcome } from '../outcome-schema.ts';

const BASE_OUTCOME = {
  sentry_id: 'SENTRY-123',
  confidence: 72,
} as const;
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

describe('OutcomeSchema', () => {
  it('parses auto_committed with a 40-char SHA and rejects 6-char SHAs', () => {
    expect(
      OutcomeSchema.parse({
        ...BASE_OUTCOME,
        outcome: 'auto_committed',
        commit_hash: 'a'.repeat(40),
      }),
    ).toMatchObject({
      outcome: 'auto_committed',
      commit_hash: 'a'.repeat(40),
    });

    expect(() =>
      OutcomeSchema.parse({
        ...BASE_OUTCOME,
        outcome: 'auto_committed',
        commit_hash: 'abcdef',
      }),
    ).toThrow();
  });

  it('allows auto_committed outcomes without sentry_id and confidence', () => {
    expect(
      OutcomeSchema.parse({
        outcome: 'auto_committed',
        commit_hash: 'a'.repeat(40),
      }),
    ).toMatchObject({
      outcome: 'auto_committed',
      commit_hash: 'a'.repeat(40),
    });
  });

  it('accepts the legacy literal plan_file: "plan.md" for plan_created outcomes (transitional)', () => {
    expect(
      OutcomeSchema.parse({
        ...BASE_OUTCOME,
        outcome: 'plan_created',
        plan_file: 'plan.md',
      }),
    ).toMatchObject({
      outcome: 'plan_created',
      plan_file: 'plan.md',
    });
  });

  it('accepts the CE2-native plan_file path docs/plans/<slug>/PLAN.md for plan_created outcomes', () => {
    expect(
      OutcomeSchema.parse({
        ...BASE_OUTCOME,
        outcome: 'plan_created',
        plan_file: 'docs/plans/260605_my-fix/PLAN.md',
      }),
    ).toMatchObject({
      outcome: 'plan_created',
      plan_file: 'docs/plans/260605_my-fix/PLAN.md',
    });
  });

  it('rejects arbitrary plan_file paths that match neither legacy nor CE2-native shape', () => {
    for (const bad of ['other.md', 'docs/plans/foo.md', 'PLAN.md', 'src/foo/PLAN.md', 'docs/plans//PLAN.md']) {
      expect(() =>
        OutcomeSchema.parse({
          ...BASE_OUTCOME,
          outcome: 'plan_created',
          plan_file: bad,
        }),
      ).toThrow();
    }
  });

  it('rejects absolute and traversal plan_file paths', () => {
    for (const bad of ['/tmp/PLAN.md', '/docs/plans/x/PLAN.md', 'docs/../etc/PLAN.md', '../PLAN.md']) {
      expect(() =>
        OutcomeSchema.parse({
          ...BASE_OUTCOME,
          outcome: 'plan_created',
          plan_file: bad,
        }),
      ).toThrow();
    }
  });

  it('rejects plan_file values longer than 512 chars', () => {
    const long = `docs/plans/${'a'.repeat(600)}/PLAN.md`;
    expect(() =>
      OutcomeSchema.parse({
        ...BASE_OUTCOME,
        outcome: 'plan_created',
        plan_file: long,
      }),
    ).toThrow();
  });

  it('accepts the CE2-native plan_file shape on auto_committed outcomes too', () => {
    expect(
      OutcomeSchema.parse({
        ...BASE_OUTCOME,
        outcome: 'auto_committed',
        commit_hash: 'a'.repeat(40),
        plan_file: 'docs/plans/260605_my-fix/PLAN.md',
      }),
    ).toMatchObject({
      outcome: 'auto_committed',
      plan_file: 'docs/plans/260605_my-fix/PLAN.md',
    });
  });

  it('accepts optional reason on plan_created outcomes', () => {
    expect(
      OutcomeSchema.parse({
        outcome: 'plan_created',
        plan_file: 'plan.md',
        reason: 'Below 90% confidence threshold',
      }),
    ).toMatchObject({
      outcome: 'plan_created',
      reason: 'Below 90% confidence threshold',
    });
  });

  it('accepts all valid failure_kind values and rejects unknown ones', () => {
    for (const failure_kind of FailureKind.options) {
      expect(
        OutcomeSchema.parse({
          ...BASE_OUTCOME,
          outcome: 'failed',
          failure_kind,
          error: 'failed hard',
        }),
      ).toMatchObject({
        outcome: 'failed',
        failure_kind,
      });
    }

    expect(() =>
      OutcomeSchema.parse({
        ...BASE_OUTCOME,
        outcome: 'failed',
        failure_kind: 'unknown_kind',
        error: 'failed hard',
      }),
    ).toThrow();
  });

  it('accepts supervisor fallback failed outcomes without failure_kind', () => {
    const parsed = OutcomeSchema.parse({
      outcome: 'failed',
      exit_code: 1,
      error: 'boom',
    });

    expect(parsed).toMatchObject({
      outcome: 'failed',
      exit_code: 1,
      error: 'boom',
    });
    expect(parsed.failure_kind).toBeUndefined();
  });

  it('preserves extra keys as unknown via catchall', () => {
    const parsed = OutcomeSchema.parse({
      ...BASE_OUTCOME,
      outcome: 'not_a_bug',
      originating_commit: 'abcdef1234',
      reviewer_results: [{ name: 'r1' }],
      sentry_issue_short_id: 'REBEL-123',
    });

    expect(parsed).toMatchObject({
      outcome: 'not_a_bug',
      originating_commit: 'abcdef1234',
      reviewer_results: [{ name: 'r1' }],
      sentry_issue_short_id: 'REBEL-123',
    });
  });

  it('accepts diagnosis_confidence as a typed [0, 1] number on every outcome branch', () => {
    expect(
      OutcomeSchema.parse({
        ...BASE_OUTCOME,
        outcome: 'auto_committed',
        commit_hash: 'a'.repeat(40),
        diagnosis_confidence: 0.95,
      }),
    ).toMatchObject({ outcome: 'auto_committed', diagnosis_confidence: 0.95 });

    expect(
      OutcomeSchema.parse({
        ...BASE_OUTCOME,
        outcome: 'plan_created',
        plan_file: 'docs/plans/fix-foo/PLAN.md',
        diagnosis_confidence: 0,
      }),
    ).toMatchObject({ outcome: 'plan_created', diagnosis_confidence: 0 });
  });

  it('rejects diagnosis_confidence values outside [0, 1] (no 0-100 percentages, no negatives)', () => {
    expect(() =>
      OutcomeSchema.parse({
        ...BASE_OUTCOME,
        outcome: 'auto_committed',
        commit_hash: 'a'.repeat(40),
        diagnosis_confidence: 95,
      }),
    ).toThrow();

    expect(() =>
      OutcomeSchema.parse({
        ...BASE_OUTCOME,
        outcome: 'auto_committed',
        commit_hash: 'a'.repeat(40),
        diagnosis_confidence: -0.1,
      }),
    ).toThrow();

    expect(() =>
      OutcomeSchema.parse({
        ...BASE_OUTCOME,
        outcome: 'auto_committed',
        commit_hash: 'a'.repeat(40),
        diagnosis_confidence: 1.0001,
      }),
    ).toThrow();
  });

  it('rejects mistyped diagnosis_confidence (e.g. string)', () => {
    expect(() =>
      OutcomeSchema.parse({
        ...BASE_OUTCOME,
        outcome: 'auto_committed',
        commit_hash: 'a'.repeat(40),
        diagnosis_confidence: '0.95',
      }),
    ).toThrow();
  });

  it('still rejects mistyped known fields even with catchall', () => {
    expect(() =>
      OutcomeSchema.parse({
        outcome: 'auto_committed',
        commit_hash: 'not-a-sha',
        extra_key: 'allowed',
      }),
    ).toThrow();
  });

  it('parses is_bug when true, false, or omitted', () => {
    expect(
      OutcomeSchema.parse({
        ...BASE_OUTCOME,
        outcome: 'escalated',
        reason: 'needs manual help',
        is_bug: true,
      }).is_bug,
    ).toBe(true);

    expect(
      OutcomeSchema.parse({
        ...BASE_OUTCOME,
        outcome: 'escalated',
        reason: 'needs manual help',
        is_bug: false,
      }).is_bug,
    ).toBe(false);

    expect(
      OutcomeSchema.parse({
        ...BASE_OUTCOME,
        outcome: 'escalated',
        reason: 'needs manual help',
      }).is_bug,
    ).toBeUndefined();
  });

  it('rejects non-autopilot branch names and accepts anchored autopilot branch names', () => {
    expect(() =>
      OutcomeSchema.parse({
        outcome: 'auto_committed',
        commit_hash: 'a'.repeat(40),
        branch_name: 'main',
      }),
    ).toThrow();

    expect(
      OutcomeSchema.parse({
        outcome: 'auto_committed',
        commit_hash: 'a'.repeat(40),
        branch_name: 'autopilot/sentry-123',
      }),
    ).toMatchObject({
      branch_name: 'autopilot/sentry-123',
    });
  });

  it('throws with Error.cause for malformed payloads without embedding stringified payload text', () => {
    const malformedInputs: unknown[] = [null, undefined, '', 'not json', '{}'];

    for (const input of malformedInputs) {
      let thrown: (Error & { cause?: unknown }) | undefined;
      try {
        parseOutcome(input, { repoRoot: REPO_ROOT });
      } catch (error) {
        thrown = error as Error & { cause?: unknown };
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown?.cause).toBe(input);
      expect(thrown?.message.includes('Offending payload:')).toBe(false);
    }
  });
});
