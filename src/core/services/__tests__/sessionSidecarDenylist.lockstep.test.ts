/**
 * Lockstep guard for the two sidecar denylists that decide which `*.json` files
 * in the `sessions/` directory are session payloads vs. non-session metadata.
 *
 * The 260617 `classifySessionKind(undefined)` crash happened because
 * `cloud-tombstone-quarantine.json` (a real sidecar written by cloudOutbox) was
 * present in NEITHER denylist: `isSessionFile()` treated it as a session, a
 * from-files rebuild hydrated it into an `id`-less "session", and the resulting
 * `id: undefined` summary crashed `classifySessionKind` across sessions:list,
 * the time-saved repair backfill, and every agent turn on that pass.
 *
 * The two sets are deliberately defined separately (the migration copy is kept
 * local so the early boot-adoption safety gate doesn't import the heavy store
 * module), so they can silently DRIFT — which is exactly what happened. This
 * test makes drift impossible-by-construction: the two MUST contain the same
 * basenames. See
 * docs-private/investigations/260617_classifysessionkind_undefined_crash_handoff.md.
 */
import { describe, expect, it } from 'vitest';
import { NON_SESSION_FILES } from '../incrementalSessionStore';
import { SESSION_DIR_NON_PAYLOAD_FILES } from '../migration/migrationImportService';

describe('sessions/ sidecar denylist lockstep', () => {
  it('the store and migration denylists contain identical basenames', () => {
    const store = Array.from(NON_SESSION_FILES).sort();
    const migration = Array.from(SESSION_DIR_NON_PAYLOAD_FILES).sort();
    // If this fails, a sidecar was added/removed in one set but not the other.
    // Missing from NON_SESSION_FILES is the DANGEROUS direction (crash); always
    // update BOTH sets together.
    expect(store).toEqual(migration);
  });

  it('includes cloud-tombstone-quarantine.json (260617 regression anchor)', () => {
    expect(NON_SESSION_FILES.has('cloud-tombstone-quarantine.json')).toBe(true);
    expect(SESSION_DIR_NON_PAYLOAD_FILES.has('cloud-tombstone-quarantine.json')).toBe(true);
  });

  it('covers every known cloud-* sidecar basename plus folders.json', () => {
    const required = [
      'cloud-outbox.json',
      'cloud-continuity-meta.json',
      'cloud-sync-meta.json',
      'cloud-workspace-manifest.json',
      'cloud-tombstone-quarantine.json',
      'folders.json',
    ];
    for (const name of required) {
      expect(NON_SESSION_FILES.has(name)).toBe(true);
    }
  });
});
