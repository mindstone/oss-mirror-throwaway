// Boundary guard (Stage 6 / Amendment A6).
//
// The `sessions/folders.json` sidecar is INTENTIONALLY excluded from the
// appdata tar (`APP_DATA_SKIP` contains `'sessions'`) — but that exclusion is
// only safe BECAUSE a dedicated non-archive carrier exists (Carrier Option A:
// the `/api/sessions/folders` route + the migration upload + the cloudRouter
// restore). This was the root-cause gap: the skip existed with NO carrier, so
// folders silently fell through (PLAN.md Root Cause, F11/F12).
//
// This test fails if EITHER invariant is broken:
//   (a) someone relaxes the skip (removes `'sessions'` from APP_DATA_SKIP), or
//   (b) someone removes the folders carrier (the upload step / restore method).
//
// It is deliberately NOT a general sidecar registry (A6 dropped that) — just
// the cheap tie between the skip and the carrier.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { APP_DATA_SKIP } from '../migrationSkipLists';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

describe('folders cloud-carry boundary guard', () => {
  it('keeps sessions/ excluded from the appdata archive (skip still in force)', () => {
    // If this is ever relaxed, folders.json would double-send via the archive
    // AND the dedicated carrier — or worse, unintended session-dir files would
    // ride the tar. The skip MUST stay.
    expect(APP_DATA_SKIP.has('sessions')).toBe(true);
  });

  it('requires a non-archive folders carrier to exist (upload + restore + route)', () => {
    // (1) Migration uploads the folders document to the dedicated carrier.
    const migration = readSource('src/main/services/cloud/cloudMigrationService.ts');
    expect(migration).toContain("'/api/sessions/folders'");

    // (2) Restore pulls + reconstructs folders on first-connect.
    const router = readSource('src/main/services/cloud/cloudRouter.ts');
    expect(router).toContain("'/api/sessions/folders'");
    expect(router).toContain('restoreFoldersFromCloud');

    // (3) Cloud-service serves the folders route + storage.
    const route = readSource('cloud-service/src/routes/sessions.ts');
    expect(route).toContain("sessionId === 'folders'");
    // Storage module exists (importable carrier-side).
    expect(() => readSource('cloud-service/src/services/cloudFolderStorage.ts')).not.toThrow();
  });
});
