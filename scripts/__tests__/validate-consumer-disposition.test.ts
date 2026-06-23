/**
 * Tests for the R2 S2-F1 consumer-disposition validator.
 *
 * @see ../validate-consumer-disposition.ts
 * @see docs/plans/260429_r2_stage2_chunked_implementation_plan.md (S2-F1)
 */

import { describe, expect, it } from 'vitest';
import {
  HOLDING_BUCKET,
  TRANSITIONAL_BUCKET,
  runValidation,
  validateConsumerDisposition,
} from '../validate-consumer-disposition';

const validSite = {
  filePath: 'src/core/services/sessionMergeUtils.ts',
  lineRange: [40, 40],
  patternKind: 'passthrough',
  bucket: 'eventsByTurn-array-reader',
  rationale: 'Reads an AgentEvent[] to detect terminal result/error events during session merge.',
  manifestImpact: 'no-change',
  blocksStage3a: false,
};

function validDisposition(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    auditDate: '2026-04-29',
    auditedBy: 'validator-test',
    sites: [validSite],
    summary: {
      totalSites: 1,
      byBucket: {
        'eventsByTurn-array-reader': 1,
      },
      blocksStage3a: 0,
      unresolved: 0,
    },
    ...overrides,
  };
}

describe('validateConsumerDisposition', () => {
  it('passes the checked-in valid disposition file', () => {
    const result = runValidation();
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('fails when a required site key is missing', () => {
    const siteWithoutBucket: Record<string, unknown> = { ...validSite };
    delete siteWithoutBucket.bucket;
    const result = validateConsumerDisposition(
      validDisposition({
        sites: [siteWithoutBucket],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path === '$.sites[0].bucket')).toBe(true);
  });

  it('fails when a bucket is not in the Stage 1.1 allowlist', () => {
    const result = validateConsumerDisposition(
      validDisposition({
        sites: [{ ...validSite, bucket: 'not-a-real-bucket' }],
        summary: {
          totalSites: 1,
          byBucket: { 'not-a-real-bucket': 1 },
          blocksStage3a: 0,
          unresolved: 0,
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path === '$.sites[0].bucket')).toBe(true);
  });

  it('fails when summary counts do not match the sites array', () => {
    const result = validateConsumerDisposition(
      validDisposition({
        summary: {
          totalSites: 2,
          byBucket: {
            'eventsByTurn-array-reader': 1,
          },
          blocksStage3a: 0,
          unresolved: 0,
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path === '$.summary.totalSites')).toBe(true);
  });

  it('allows NEEDS-NEW-AXIS with a warning instead of a failure', () => {
    const result = validateConsumerDisposition(
      validDisposition({
        sites: [{ ...validSite, bucket: TRANSITIONAL_BUCKET }],
        summary: {
          totalSites: 1,
          byBucket: {
            [TRANSITIONAL_BUCKET]: 1,
          },
          blocksStage3a: 0,
          unresolved: 1,
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].path).toBe('$.sites[0].bucket');
  });

  it('allows uncertain manual-audit holding bucket with a warning and unresolved count', () => {
    const result = validateConsumerDisposition(
      validDisposition({
        sites: [{ ...validSite, bucket: HOLDING_BUCKET }],
        summary: {
          totalSites: 1,
          byBucket: {
            [HOLDING_BUCKET]: 1,
          },
          blocksStage3a: 0,
          unresolved: 1,
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].path).toBe('$.sites[0].bucket');
  });

  it('fails when unresolved summary omits uncertain manual-audit sites', () => {
    const result = validateConsumerDisposition(
      validDisposition({
        sites: [{ ...validSite, bucket: HOLDING_BUCKET }],
        summary: {
          totalSites: 1,
          byBucket: {
            [HOLDING_BUCKET]: 1,
          },
          blocksStage3a: 0,
          unresolved: 0,
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path === '$.summary.unresolved')).toBe(true);
    expect(result.warnings.some((warning) => warning.path === '$.sites[0].bucket')).toBe(true);
  });

  it('fails when lineRange is not a two-element positive integer range', () => {
    const result = validateConsumerDisposition(
      validDisposition({
        sites: [{ ...validSite, lineRange: [40, '41'] }],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path === '$.sites[0].lineRange')).toBe(true);
  });

  it('fails when patternKind is not an allowed enum value', () => {
    const result = validateConsumerDisposition(
      validDisposition({
        sites: [{ ...validSite, patternKind: 'type-switch' }],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path === '$.sites[0].patternKind')).toBe(true);
  });

  it('fails when manifestImpact is not an allowed enum value', () => {
    const result = validateConsumerDisposition(
      validDisposition({
        sites: [{ ...validSite, manifestImpact: 'maybe' }],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path === '$.sites[0].manifestImpact')).toBe(true);
  });

  it('fails when blocksStage3a is not boolean', () => {
    const result = validateConsumerDisposition(
      validDisposition({
        sites: [{ ...validSite, blocksStage3a: 'false' }],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path === '$.sites[0].blocksStage3a')).toBe(true);
  });
});
