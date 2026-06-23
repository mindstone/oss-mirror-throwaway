import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { diagnosticEventEntrySchema } from '../../diagnosticEventsLedger';
import { DIAGNOSTIC_EVENT_SCHEMA_VERSION } from '../manifest';
import {
  CONTINUITY_FAMILIES,
  CONTINUITY_TRANSITION_TUPLES,
  type ContinuityFamily,
  toDiagnosticContinuityTransition,
} from '@shared/diagnostics/continuityTransition';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');

describe('toDiagnosticContinuityTransition', () => {
  it('maps every closed continuity tuple to a valid diagnostic event', () => {
    const coveredFamilies = new Set<ContinuityFamily>();

    for (const tuple of CONTINUITY_TRANSITION_TUPLES) {
      const reason = 'reason' in tuple ? tuple.reason : undefined;
      coveredFamilies.add(tuple.family);
      const event = toDiagnosticContinuityTransition({
        family: tuple.family,
        category: tuple.category,
        message: tuple.message,
        level: 'warning',
        surface: 'desktop',
        data: {
          ...(reason ? { reason } : {}),
          sessionIdHash: 'session_abc123',
        },
      });

      expect(event).toEqual({
        kind: 'continuity_transition',
        surface: 'desktop',
        data: {
          family: tuple.family,
          message: tuple.message,
          ...(reason ? { reason } : {}),
          level: 'warning',
          sessionIdHash: 'session_abc123',
        },
      });
      expect(diagnosticEventEntrySchema.parse({
        v: DIAGNOSTIC_EVENT_SCHEMA_VERSION,
        ts: 1,
        ...event,
      })).toMatchObject(event);
    }

    expect([...coveredFamilies].sort()).toEqual([...CONTINUITY_FAMILIES].sort());
  });

  it('normalizes non-reason breadcrumb fields into closed reasons', () => {
    expect(toDiagnosticContinuityTransition({
      family: 'state',
      category: 'continuity.merge-guard',
      message: 'continuity-merge-refused',
      data: { refusal: 'no-intent' },
    }).data.reason).toBe('no-intent');

    expect(toDiagnosticContinuityTransition({
      family: 'state',
      category: 'continuity.gc-guard',
      message: 'state-map-gc-protected',
      data: { protected: 'no-removal-intent' },
    }).data.reason).toBe('no-removal-intent');
  });

  it('throws on unknown continuity inputs instead of silently widening enums', () => {
    expect(() => toDiagnosticContinuityTransition({
      family: 'state',
      category: 'continuity.unknown',
      message: 'state-transition',
      data: { reason: 'cloud-enabled' },
    })).toThrow(/Unsupported continuity transition tuple/u);

    expect(() => toDiagnosticContinuityTransition({
      family: 'metadata',
      category: 'continuity.continuity-state',
      message: 'state-transition',
      data: { reason: 'not-a-real-reason' },
    })).toThrow();
  });
});

describe('mobile continuity diagnostic emit invariant', () => {
  it('does not reintroduce mobile-side diagnostic continuity emits', () => {
    const mobileDir = path.join(REPO_ROOT, 'mobile');
    const offenders: string[] = [];

    for (const filePath of listSourceFiles(mobileDir)) {
      const content = readFileSync(filePath, 'utf8');
      if (/appendDiagnosticEvent\s*\(\s*toDiagnosticContinuityTransition\s*\(/u.test(content)) {
        offenders.push(path.relative(REPO_ROOT, filePath));
      }
    }

    expect(offenders).toEqual([]);
  });
});

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'build' || entry === 'dist') continue;
      out.push(...listSourceFiles(fullPath));
    } else if (/\.(ts|tsx)$/u.test(entry)) {
      out.push(fullPath);
    }
  }
  return out;
}
