/**
 * Anti-rot + non-vacuity unit test for the boot-smoke's pure readiness classifier
 * (scripts/check-packaged-app-boot-smoke.ts). The classifier is the decision core: if
 * it silently starts always-passing (e.g. shape drift in the e2e readiness bridge), the
 * smoke becomes a placebo. These cases lock the contract derived from the Stage 13 spike:
 *   - missing/null/wrong-shape bridge  → keep polling (not a pass)
 *   - appReady:true                    → PASS
 *   - safe-mode / startup-recovery     → terminal FAIL (degraded/crash-recovery boot)
 *   - appReady:false                   → keep polling
 */
import { describe, expect, it } from 'vitest';
import {
  classifyBootReadiness,
  classifyFseventsInterception,
  classifyRebelMediaPdfFetch,
} from '../check-packaged-app-boot-smoke';

describe('classifyBootReadiness', () => {
  it('does NOT pass when the readiness bridge is unavailable (null/undefined)', () => {
    for (const v of [null, undefined]) {
      const c = classifyBootReadiness(v);
      expect(c.ok).toBe(false);
      expect(c).toMatchObject({ done: false }); // keep polling, not terminal
    }
  });

  it('does NOT pass on a wrong-shape snapshot (missing boolean appReady → shape drift)', () => {
    for (const v of [42, 'main', {}, { appReady: 'yes' }, { phase: 'main' }]) {
      const c = classifyBootReadiness(v);
      expect(c.ok).toBe(false);
    }
    // The empty-object / non-boolean cases are treated as "not ready yet", not terminal,
    // so a momentarily-incomplete snapshot doesn't cause a spurious fail.
    expect(classifyBootReadiness({}).ok).toBe(false);
    expect((classifyBootReadiness({}) as { done: boolean }).done).toBe(false);
  });

  it('PASSES when appReady === true', () => {
    const c = classifyBootReadiness({ phase: 'main', appReady: true, safeModeEnabled: false, startupRecoveryDialogVisible: false });
    expect(c.ok).toBe(true);
    expect(c.reason).toContain('appReady');
  });

  it('keeps polling while appReady === false (still booting)', () => {
    const c = classifyBootReadiness({ phase: 'login', appReady: false, blockingReason: 'auth-login' });
    expect(c.ok).toBe(false);
    expect((c as { done: boolean }).done).toBe(false);
    expect(c.reason).toContain('login');
  });

  it('TERMINAL-FAILS on safe-mode even if it would otherwise look ready', () => {
    const c = classifyBootReadiness({ phase: 'safe-mode', appReady: false, safeModeEnabled: true });
    expect(c.ok).toBe(false);
    expect((c as { done: boolean }).done).toBe(true); // stop polling, fail fast
    expect(c.reason.toLowerCase()).toContain('safe mode');
  });

  it('TERMINAL-FAILS when the startup-recovery dialog is visible', () => {
    const c = classifyBootReadiness({ phase: 'main', appReady: false, startupRecoveryDialogVisible: true });
    expect(c.ok).toBe(false);
    expect((c as { done: boolean }).done).toBe(true);
    expect(c.reason.toLowerCase()).toContain('recovery');
  });

  it('safe-mode/recovery take precedence over a stale appReady:true (degraded boot is not a pass)', () => {
    const safe = classifyBootReadiness({ phase: 'safe-mode', appReady: true, safeModeEnabled: true });
    expect(safe.ok).toBe(false);
    const recovery = classifyBootReadiness({ phase: 'main', appReady: true, startupRecoveryDialogVisible: true });
    expect(recovery.ok).toBe(false);
  });

  it('TERMINAL-FAILS on the test-mode superMcpStartupFailed signal (real users would see recovery)', () => {
    // The dialog itself is suppressed under e2e, so startupRecoveryDialogVisible stays
    // false; this test-mode signal is the only way the smoke can see the degraded boot.
    const c = classifyBootReadiness({ phase: 'main', appReady: true, startupRecoveryDialogVisible: false, superMcpStartupFailed: true });
    expect(c.ok).toBe(false);
    expect((c as { done: boolean }).done).toBe(true);
    expect(c.reason.toLowerCase()).toContain('super-mcp');
  });
});

// --- fsevents interception gate classifier (PLAN.md 260611_fsevents-shutdown-crash 3a) --

/** Convenience darwin snapshot builder. */
function darwinSnap(overrides: {
  installState?: string | null;
  liveCount?: number;
  isWatching?: boolean;
  readyObserved?: boolean;
}): unknown {
  return {
    platform: 'darwin',
    guard: {
      installState: overrides.installState === undefined ? 'installed' : overrides.installState,
      quitMode: false,
      liveNativeInstanceCount: overrides.liveCount ?? 0,
    },
    watcher: {
      isWatching: overrides.isWatching ?? false,
      currentDirectory: overrides.isWatching ? '/tmp/smoke-workspace' : null,
      readyObserved: overrides.readyObserved ?? false,
    },
  };
}

describe('classifyFseventsInterception', () => {
  it('keeps polling on missing/odd-shaped snapshots (never a verdict)', () => {
    for (const v of [null, undefined, 42, {}, { platform: 7 }, { platform: 'darwin' }]) {
      const c = classifyFseventsInterception(v);
      expect(c.ok).toBe(false);
      expect(c).toMatchObject({ done: false, kind: 'setup' });
    }
  });

  it('darwin PASS: any tracked live instance proves interception (even pre-ready)', () => {
    const c = classifyFseventsInterception(darwinSnap({ liveCount: 3, isWatching: true }));
    expect(c.ok).toBe(true);
    expect(c.reason).toContain('3 live');
  });

  it('darwin SETUP (pending): zero instances before the watcher starts is NOT an interception verdict', () => {
    const c = classifyFseventsInterception(darwinSnap({ liveCount: 0, isWatching: false }));
    expect(c).toMatchObject({ ok: false, done: false, kind: 'setup' });
    expect(c.reason).toContain('NOT an interception verdict');
  });

  it('darwin SETUP (pending): watcher running but not ready yet keeps polling', () => {
    const c = classifyFseventsInterception(darwinSnap({ liveCount: 0, isWatching: true, readyObserved: false }));
    expect(c).toMatchObject({ ok: false, done: false, kind: 'setup' });
  });

  it('darwin INTERCEPTION FAILURE (the gate): watcher READY with zero tracked instances', () => {
    const c = classifyFseventsInterception(darwinSnap({ liveCount: 0, isWatching: true, readyObserved: true }));
    expect(c).toMatchObject({ ok: false, done: true, kind: 'interception' });
    expect(c.reason).toContain('D falls');
  });

  it('darwin INTERCEPTION FAILURE: guard inert in a packaged darwin app (fsevents never patched)', () => {
    const c = classifyFseventsInterception(darwinSnap({ installState: 'inert:unloadable' }));
    expect(c).toMatchObject({ ok: false, done: true, kind: 'interception' });
  });

  it('darwin SETUP (terminal): installState null = build predates the guard, not a gate verdict', () => {
    const c = classifyFseventsInterception(darwinSnap({ installState: null }));
    expect(c).toMatchObject({ ok: false, done: true, kind: 'setup' });
  });

  it('non-darwin PASS: guard cleanly inert with zero instances', () => {
    const c = classifyFseventsInterception({
      platform: 'linux',
      guard: { installState: 'inert:non-darwin', quitMode: false, liveNativeInstanceCount: 0 },
    });
    expect(c.ok).toBe(true);
    expect(c.reason).toContain('inert');
  });

  it('non-darwin FAIL: guard NOT inert (installed or tracking) is terminal', () => {
    const c = classifyFseventsInterception({
      platform: 'linux',
      guard: { installState: 'installed', quitMode: false, liveNativeInstanceCount: 1 },
    });
    expect(c).toMatchObject({ ok: false, done: true, kind: 'interception' });
  });

  it('non-darwin SETUP (terminal): installState null = build predates the guard', () => {
    const c = classifyFseventsInterception({
      platform: 'win32',
      guard: { installState: null, quitMode: false, liveNativeInstanceCount: 0 },
    });
    expect(c).toMatchObject({ ok: false, done: true, kind: 'setup' });
  });
});

// --- PDF-render-via-protocol gate classifier (PM 260619_pdf_preview_blank_blob_file_origin) --
//
// Locks the contract that catches the dev_works_packaged_fails class: a packaged file://
// renderer must be able to obtain a PDF over rebel-media:// (full + Range). The decision
// core must NOT silently start always-passing (e.g. if the probe shape drifts), and must
// classify a renderer fetch FAILURE as a render verdict (exit 1), not a setup error (F1).

/** A fully-passing probe snapshot; override one field to assert a single failure mode. */
function pdfProbe(overrides: {
  fetchError?: string;
  full?: Partial<{ status: number; contentType: string | null; byteLength: number }> | null;
  range?: Partial<{ status: number; contentType: string | null; contentRange: string | null; byteLength: number }> | null;
}): unknown {
  const base = {
    full: { status: 200, contentType: 'application/pdf', byteLength: 312 },
    range: { status: 206, contentType: 'application/pdf', contentRange: 'bytes 0-0/312', byteLength: 1 },
  };
  const snap: Record<string, unknown> = {};
  if (overrides.fetchError !== undefined) snap.fetchError = overrides.fetchError;
  snap.full = overrides.full === null ? undefined : { ...base.full, ...(overrides.full ?? {}) };
  snap.range = overrides.range === null ? undefined : { ...base.range, ...(overrides.range ?? {}) };
  return snap;
}

describe('classifyRebelMediaPdfFetch', () => {
  it('keeps polling on missing/odd-shaped snapshots (never a verdict)', () => {
    for (const v of [null, undefined, 42, 'x']) {
      const c = classifyRebelMediaPdfFetch(v);
      expect(c.ok).toBe(false);
      expect(c).toMatchObject({ done: false });
    }
  });

  it('PASSES when both the full (200) and range (206) legs return application/pdf with bytes', () => {
    const c = classifyRebelMediaPdfFetch(pdfProbe({}));
    expect(c.ok).toBe(true);
    expect(c.reason).toContain('rebel-media://');
  });

  it('accepts a 206 on the full leg too (range-capable handler answering full requests)', () => {
    const c = classifyRebelMediaPdfFetch(pdfProbe({ full: { status: 206 } }));
    expect(c.ok).toBe(true);
  });

  it('F1 — a renderer fetch REJECTION is a RENDER failure (exit 1), not setup', () => {
    const c = classifyRebelMediaPdfFetch(pdfProbe({ fetchError: 'Failed to fetch' }));
    expect(c).toMatchObject({ ok: false, done: true, kind: 'render' });
    expect(c.reason).toContain('rejected');
  });

  it('RENDER-FAILS on an error status (404/500 — handler did not serve the PDF)', () => {
    for (const status of [404, 500, 403]) {
      const c = classifyRebelMediaPdfFetch(pdfProbe({ full: { status } }));
      expect(c).toMatchObject({ ok: false, done: true, kind: 'render' });
    }
  });

  it('RENDER-FAILS when the full content-type is not application/pdf (MIME mapping broke)', () => {
    const c = classifyRebelMediaPdfFetch(pdfProbe({ full: { contentType: 'application/octet-stream' } }));
    expect(c).toMatchObject({ ok: false, done: true, kind: 'render' });
    expect(c.reason).toContain('application/pdf');
  });

  it('RENDER-FAILS on an empty body (no PDF bytes reached the renderer)', () => {
    const c = classifyRebelMediaPdfFetch(pdfProbe({ full: { byteLength: 0 } }));
    expect(c).toMatchObject({ ok: false, done: true, kind: 'render' });
  });

  it('keeps polling (setup) when the probe is still incomplete (no full/range result yet)', () => {
    expect(classifyRebelMediaPdfFetch(pdfProbe({ full: null }))).toMatchObject({ ok: false, done: false, kind: 'setup' });
    expect(classifyRebelMediaPdfFetch(pdfProbe({ range: null }))).toMatchObject({ ok: false, done: false, kind: 'setup' });
  });

  it('F2 — RENDER-FAILS when the range leg is not 206 (byte-range support broken; PDFium needs it)', () => {
    const c = classifyRebelMediaPdfFetch(pdfProbe({ range: { status: 200 } }));
    expect(c).toMatchObject({ ok: false, done: true, kind: 'render' });
    expect(c.reason).toContain('206');
  });

  it('F2 — RENDER-FAILS when the 206 omits Content-Range (malformed partial response)', () => {
    const c = classifyRebelMediaPdfFetch(pdfProbe({ range: { contentRange: null } }));
    expect(c).toMatchObject({ ok: false, done: true, kind: 'render' });
    expect(c.reason).toContain('Content-Range');
  });

  it('F3 — RENDER-FAILS on a 206 with a malformed (non-empty) Content-Range shape', () => {
    for (const bad of ['bytes */312', 'bytes 0-5/312', '0-0/312', 'bytes 0-0']) {
      const c = classifyRebelMediaPdfFetch(pdfProbe({ range: { contentRange: bad } }));
      expect(c).toMatchObject({ ok: false, done: true, kind: 'render' });
    }
    // the canonical single-byte shape still passes
    expect(classifyRebelMediaPdfFetch(pdfProbe({ range: { contentRange: 'bytes 0-0/999' } })).ok).toBe(true);
  });

  it('F2 — RENDER-FAILS when bytes=0-0 returns the wrong slice length (not 1 byte)', () => {
    const c = classifyRebelMediaPdfFetch(pdfProbe({ range: { byteLength: 312 } }));
    expect(c).toMatchObject({ ok: false, done: true, kind: 'render' });
  });
});
