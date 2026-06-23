import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Wrap node:fs so that `readdirSync` is a spyable mock that delegates to the
// real implementation. ESM named exports are not configurable, so a plain
// `vi.spyOn(fs, 'readdirSync')` throws; mocking the module is the supported
// way to count calls into the filesystem walker.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    readdirSync: vi.fn(actual.readdirSync),
    // RS-F1 residual: spyable `realpathSync` (delegates to real) so we can assert
    // a cloud-classified absolute target is NEVER `realpathSync`'d (the dead-mount
    // main-thread block). Existing tests are unaffected — it still calls through.
    realpathSync: vi.fn(actual.realpathSync),
    // S4.1f MUST-FIX C residual: spyable `existsSync` (delegates to real) so we can
    // assert a cloud-classified candidate / relativeAttempt is NEVER `existsSync`'d
    // in `resolveLibraryPath` (the same dead-mount main-thread block via the SYNC
    // probes at the cloud-ROOT cases). Local paths still call through unchanged.
    existsSync: vi.fn(actual.existsSync),
  };
});

import * as fsSync from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  tryConvertToWorkspacePath,
  tryConvertToWorkspacePathLegacy,
  resolveLibraryPath,
} from "../systemUtils";
import { buildSymlinkMap } from "../symlinkMap";
import { detectCloudStorage } from "../cloudStorageUtils";

const readdirMock = fsSync.readdirSync as unknown as ReturnType<typeof vi.fn>;
const realpathMock = fsSync.realpathSync as unknown as ReturnType<typeof vi.fn>;
const existsMock = fsSync.existsSync as unknown as ReturnType<typeof vi.fn>;

/**
 * Parity + performance tests for the rewritten `tryConvertToWorkspacePath`.
 *
 * The legacy O(workspace-size) walker is retained as
 * `tryConvertToWorkspacePathLegacy` and used here as the ORACLE: the new
 * implementation must produce identical output on every case.
 *
 * All tests use a real temp directory tree with real symlinks so that
 * realpath/lstat behave exactly as in production.
 */

let tmpRoot: string;

/** Create a temp dir tree; return its (realpath-resolved) root. */
function makeTmpRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "twp-test-"));
  // macOS tmpdir is itself a symlink (/var -> /private/var); resolve so our
  // "outside" paths are genuinely outside and comparisons are stable.
  return fsSync.realpathSync(dir);
}

beforeEach(() => {
  tmpRoot = makeTmpRoot();
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** Assert new impl matches the legacy oracle for the given inputs. */
function expectParity(absolutePath: string, workspaceRoot: string): string | null {
  const legacy = tryConvertToWorkspacePathLegacy(absolutePath, workspaceRoot);
  const next = tryConvertToWorkspacePath(absolutePath, workspaceRoot);
  expect(next).toEqual(legacy);
  return next;
}

describe("tryConvertToWorkspacePath — parity with legacy oracle", () => {
  it("maps a normal nested workspace file to dir/file.md (no symlinks)", () => {
    const ws = path.join(tmpRoot, "ws");
    mkdirSync(path.join(ws, "a", "b"), { recursive: true });
    const file = path.join(ws, "a", "b", "file.md");
    writeFileSync(file, "hi");

    const result = expectParity(file, ws);
    expect(result).toBe(path.join("a", "b", "file.md"));
  });

  it("returns null for the workspace root itself (parity)", () => {
    const ws = path.join(tmpRoot, "ws");
    mkdirSync(ws, { recursive: true });
    expectParity(ws, ws);
    expect(tryConvertToWorkspacePath(ws, ws)).toBeNull();
  });

  it("workspace root is itself a symlink: root/file.md returns file.md", () => {
    // real workspace lives elsewhere; `ws` is a symlink to it.
    const realWs = path.join(tmpRoot, "real-ws");
    mkdirSync(path.join(realWs, "sub"), { recursive: true });
    const file = path.join(realWs, "sub", "doc.md");
    writeFileSync(file, "hi");

    const wsLink = path.join(tmpRoot, "ws-link");
    symlinkSync(realWs, wsLink);

    // Pass the canonical real path of the file with the symlinked root.
    const result = expectParity(file, wsLink);
    expect(result).toBe(path.join("sub", "doc.md"));
  });

  it("symlink inside workspace -> outside target; file under it returns link/nested/file.md", () => {
    const ws = path.join(tmpRoot, "ws");
    mkdirSync(ws, { recursive: true });

    const outside = path.join(tmpRoot, "outside-target");
    mkdirSync(path.join(outside, "nested"), { recursive: true });
    const file = path.join(outside, "nested", "file.md");
    writeFileSync(file, "hi");

    const link = path.join(ws, "link");
    symlinkSync(outside, link);

    const result = expectParity(file, ws);
    expect(result).toBe(path.join("link", "nested", "file.md"));
  });

  it("symlink target itself (no nested part) returns the link's workspace path", () => {
    const ws = path.join(tmpRoot, "ws");
    mkdirSync(ws, { recursive: true });
    const outside = path.join(tmpRoot, "outside2");
    mkdirSync(outside, { recursive: true });
    const link = path.join(ws, "drive");
    symlinkSync(outside, link);

    // Real path of the target equals the symlink's realPath exactly.
    const result = expectParity(outside, ws);
    expect(result).toBe("drive");
  });

  it("boundary containment: /tmp/ws2/file must not match /tmp/ws", () => {
    const ws = path.join(tmpRoot, "ws");
    const ws2 = path.join(tmpRoot, "ws2");
    mkdirSync(ws, { recursive: true });
    mkdirSync(ws2, { recursive: true });
    const file = path.join(ws2, "file.md");
    writeFileSync(file, "hi");

    const result = expectParity(file, ws);
    expect(result).toBeNull();
  });

  it("file outside workspace and outside all symlink targets returns null", () => {
    const ws = path.join(tmpRoot, "ws");
    mkdirSync(ws, { recursive: true });
    const outside = path.join(tmpRoot, "elsewhere");
    mkdirSync(outside, { recursive: true });
    const file = path.join(outside, "x.md");
    writeFileSync(file, "hi");

    const result = expectParity(file, ws);
    expect(result).toBeNull();
  });

  it("skip-rule parity: symlink under node_modules is NOT used for conversion", () => {
    const ws = path.join(tmpRoot, "ws");
    mkdirSync(path.join(ws, "node_modules"), { recursive: true });
    const outside = path.join(tmpRoot, "nm-target");
    mkdirSync(outside, { recursive: true });
    const file = path.join(outside, "f.md");
    writeFileSync(file, "hi");
    symlinkSync(outside, path.join(ws, "node_modules", "link"));

    const result = expectParity(file, ws);
    expect(result).toBeNull();
  });

  it("skip-rule parity: symlink under a depth>0 dotdir is NOT used for conversion", () => {
    const ws = path.join(tmpRoot, "ws");
    mkdirSync(path.join(ws, "sub", ".hidden"), { recursive: true });
    const outside = path.join(tmpRoot, "dot-target");
    mkdirSync(outside, { recursive: true });
    const file = path.join(outside, "f.md");
    writeFileSync(file, "hi");
    symlinkSync(outside, path.join(ws, "sub", ".hidden", "link"));

    const result = expectParity(file, ws);
    expect(result).toBeNull();
  });

  it("broken symlink is ignored and does not prevent conversion via another mapping", () => {
    const ws = path.join(tmpRoot, "ws");
    mkdirSync(ws, { recursive: true });
    // Broken symlink (target does not exist)
    symlinkSync(path.join(tmpRoot, "does-not-exist"), path.join(ws, "broken"));

    const outside = path.join(tmpRoot, "good-target");
    mkdirSync(path.join(outside, "n"), { recursive: true });
    const file = path.join(outside, "n", "f.md");
    writeFileSync(file, "hi");
    symlinkSync(outside, path.join(ws, "good"));

    const result = expectParity(file, ws);
    expect(result).toBe(path.join("good", "n", "f.md"));
  });

  it("deleted / nonexistent absolute path returns null (no negative caching)", () => {
    const ws = path.join(tmpRoot, "ws");
    mkdirSync(ws, { recursive: true });
    const ghost = path.join(ws, "ghost.md");

    const result = expectParity(ghost, ws);
    expect(result).toBeNull();
  });

});

// ---------------------------------------------------------------------------
// INTENTIONAL divergences from the legacy walker.
//
// MA1/MA2 (260529 GPT-5.5 review): the rewritten resolver is NOT bug-for-bug
// identical to the legacy O(workspace) walker, and that is BY DESIGN. The legacy
// walker's output depended on `readdirSync` traversal order, which is
// filesystem-/platform-dependent and therefore NONDETERMINISTIC when more than
// one in-workspace path could reach the same canonical file. The new resolver
// makes a deterministic choice instead (fast realpath-relative first; then the
// longest / most-specific symlink target). Deterministic > legacy-readdir-order.
//
// These tests assert the new DETERMINISTIC behavior directly and deliberately do
// NOT call the parity oracle, because there is no single "correct" legacy answer
// to compare against. They live OUTSIDE the parity-vs-oracle block above so the
// parity suite only ever holds genuine new===legacy agreement cases.
// ---------------------------------------------------------------------------
describe("tryConvertToWorkspacePath — intentional divergences from legacy (deterministic by design)", () => {
  it("maps a root-level workspace file to its bare name (legacy returned null)", () => {
    const ws = path.join(tmpRoot, "ws");
    mkdirSync(ws, { recursive: true });
    const file = path.join(ws, "top.md");
    writeFileSync(file, "hi");

    // Legacy full-walks and returns null for a root-level file because no CHILD
    // directory's realpath contains it. The new fast path computes
    // path.relative(realRoot, realTarget) and returns "top.md" — the
    // observably-useful workspace-relative path. Intentional improvement, not a
    // parity case.
    expect(tryConvertToWorkspacePathLegacy(file, ws)).toBeNull();
    expect(tryConvertToWorkspacePath(file, ws)).toBe("top.md");
  });

  it("overlapping symlink targets choose the most specific (longest realPath) mapping", () => {
    // ws/outer -> /outside, and ws/short -> /outside/deep.
    // The file lives under /outside/deep; BOTH symlinks can reach it.
    const ws = path.join(tmpRoot, "ws");
    mkdirSync(ws, { recursive: true });

    const outside = path.join(tmpRoot, "outside");
    mkdirSync(path.join(outside, "deep"), { recursive: true });
    const file = path.join(outside, "deep", "f.md");
    writeFileSync(file, "hi");

    symlinkSync(outside, path.join(ws, "outer"));
    // Second symlink directly to the deep dir, registered at ws/short
    symlinkSync(path.join(outside, "deep"), path.join(ws, "short"));

    // Legacy returned whichever symlink readdir visited FIRST ("outer/deep/f.md"
    // or "short/f.md") — nondeterministic across platforms. The new impl sorts
    // mappings longest-realPath-first, so /outside/deep beats /outside and the
    // result is DETERMINISTICALLY "short/f.md". This is the deliberate divergence;
    // we assert the deterministic answer rather than oracle parity.
    expect(tryConvertToWorkspacePath(file, ws)).toBe(path.join("short", "f.md"));
  });
});

describe("tryConvertToWorkspacePath — performance regression (warm registry)", () => {
  it("N conversions with an injected symlink map do NOT call readdirSync per call", () => {
    const ws = path.join(tmpRoot, "ws");
    mkdirSync(ws, { recursive: true });
    const outside = path.join(tmpRoot, "perf-target");
    mkdirSync(path.join(outside, "n"), { recursive: true });
    const file = path.join(outside, "n", "f.md");
    writeFileSync(file, "hi");
    symlinkSync(outside, path.join(ws, "link"));

    // Build the registry ONCE.
    const map = buildSymlinkMap(ws);

    readdirMock.mockClear();
    const N = 50;
    for (let i = 0; i < N; i++) {
      const r = tryConvertToWorkspacePath(file, ws, map);
      expect(r).toBe(path.join("link", "n", "f.md"));
    }
    // With a warm/injected map, no directory scanning happens at all.
    expect(readdirMock).not.toHaveBeenCalled();
  });

  it("fast-path (in-root) conversions never scan directories even without a map", () => {
    const ws = path.join(tmpRoot, "ws");
    mkdirSync(path.join(ws, "a"), { recursive: true });
    const file = path.join(ws, "a", "f.md");
    writeFileSync(file, "hi");

    readdirMock.mockClear();
    const N = 50;
    for (let i = 0; i < N; i++) {
      expect(tryConvertToWorkspacePath(file, ws)).toBe(path.join("a", "f.md"));
    }
    // In-root files resolve purely via realpath + path.relative — no readdir.
    expect(readdirMock).not.toHaveBeenCalled();
  });

  it("legacy oracle DOES scan directories per call (proves the regression it fixes)", () => {
    const ws = path.join(tmpRoot, "ws");
    mkdirSync(path.join(ws, "a", "b"), { recursive: true });
    const outside = path.join(tmpRoot, "legacy-target");
    mkdirSync(outside, { recursive: true });
    const file = path.join(outside, "x.md");
    writeFileSync(file, "hi");
    symlinkSync(outside, path.join(ws, "link"));

    readdirMock.mockClear();
    const N = 10;
    for (let i = 0; i < N; i++) {
      tryConvertToWorkspacePathLegacy(file, ws);
    }
    // The legacy walker reads directories on every single call.
    expect(readdirMock.mock.calls.length).toBeGreaterThanOrEqual(N);
  });
});

// ---------------------------------------------------------------------------
// MA3 (260529 GPT-5.5 review): a CACHED symlink map can go stale if a symlink is
// retargeted WITHOUT a dir:added/dir:removed event (atomic re-point, mount swap,
// previously-broken target appearing). A stale map mis-converts both the indexed
// relative_path AND the DELETE predicate, so a delete after a silent retarget can
// remove the WRONG file_vectors row.
//
// The fix rebuilds the cached map at the START of each lazy-fill pass (see
// vectorsDerive.ts), bounding staleness to ≤ one pass. These tests prove the
// underlying resolver semantics that make the per-pass rebuild correct:
//   1. A stale cached map yields the WRONG path after a retarget; a freshly
//      rebuilt map yields the CORRECT path — i.e. rebuilding is the fix.
//   2. The delete-path conversion (same resolver, same map) follows suit: a
//      stale map points the delete at the OLD relative path (wrong row), a fresh
//      map points it at the NEW one.
// ---------------------------------------------------------------------------
describe("tryConvertToWorkspacePath — MA3 cached-map staleness on silent symlink retarget", () => {
  it("a retarget without a dir event is reflected only after the map is rebuilt", () => {
    const ws = path.join(tmpRoot, "ws");
    mkdirSync(ws, { recursive: true });

    const oldTarget = path.join(tmpRoot, "old-target");
    const newTarget = path.join(tmpRoot, "new-target");
    mkdirSync(oldTarget, { recursive: true });
    mkdirSync(newTarget, { recursive: true });

    const linkPath = path.join(ws, "drive");
    symlinkSync(oldTarget, linkPath);

    // Build the map while the link points at oldTarget, then cache it.
    const staleMap = buildSymlinkMap(ws);

    // A file appears under the NEW target after a silent retarget of the symlink
    // (no dir:added/removed observed).
    const newFile = path.join(newTarget, "doc.md");
    writeFileSync(newFile, "hi");
    unlinkSync(linkPath);
    symlinkSync(newTarget, linkPath);

    // With the STALE cached map, newTarget is not reachable → resolver misses
    // (returns null; the production caller then falls back to ../.. paths).
    expect(tryConvertToWorkspacePath(newFile, ws, staleMap)).toBeNull();

    // After a rebuild (what the per-pass MA3 fix does), the conversion is correct.
    const freshMap = buildSymlinkMap(ws);
    expect(tryConvertToWorkspacePath(newFile, ws, freshMap)).toBe(path.join("drive", "doc.md"));
  });

  it("a delete after a retarget maps to the NEW row only with a rebuilt map (stale map → wrong row)", () => {
    const ws = path.join(tmpRoot, "ws");
    mkdirSync(ws, { recursive: true });

    const oldTarget = path.join(tmpRoot, "old-target");
    const newTarget = path.join(tmpRoot, "new-target");
    mkdirSync(oldTarget, { recursive: true });
    mkdirSync(newTarget, { recursive: true });

    const linkPath = path.join(ws, "drive");
    symlinkSync(oldTarget, linkPath);

    // Cache the map while pointing at oldTarget.
    const staleMap = buildSymlinkMap(ws);

    // Retarget the symlink at newTarget (silent — no dir event), and a doc exists
    // under newTarget reachable as drive/doc.md.
    unlinkSync(linkPath);
    symlinkSync(newTarget, linkPath);
    const newDoc = path.join(newTarget, "doc.md");
    writeFileSync(newDoc, "hi");

    // The DELETE path converts the file via the SAME resolver+map. With the stale
    // map it cannot resolve the new doc to drive/doc.md (it would fall back to a
    // ../.. path, i.e. the wrong/none predicate). With a freshly-rebuilt map the
    // delete correctly targets drive/doc.md — the row that actually exists.
    expect(tryConvertToWorkspacePath(newDoc, ws, staleMap)).toBeNull();

    const freshMap = buildSymlinkMap(ws);
    expect(tryConvertToWorkspacePath(newDoc, ws, freshMap)).toBe(path.join("drive", "doc.md"));
  });
});

/**
 * RS-F1 residual (Stage 5 carry-forward): an absolute, cloud-classified target
 * must NOT be `realpathSync`'d on the main thread — that dereferences a possibly
 * dead cloud FUSE mount and blocks in the kernel with no timeout (the
 * libuv-threadpool-exhaustion hang). `detectCloudStorage` is a pure STRING match
 * (no I/O), so a `~/Library/CloudStorage/…` path classifies as cloud without any
 * filesystem access; the function degrades to non-resolvable (`null`).
 *
 * These assert the cloud TARGET path is never passed to `realpathSync`. The
 * non-cloud assertions confirm LOCAL paths keep the exact realpath fast path.
 */
describe("tryConvertToWorkspacePath / resolveLibraryPath — RS-F1 cloud-target realpath residual", () => {
  const CLOUD_TARGET =
    "/Users/test/Library/CloudStorage/GoogleDrive-test@example.com/Shared drives/Company Memories/doc.md";

  it("returns null for a cloud-classified absolute target WITHOUT realpathSync'ing it", () => {
    const ws = path.join(tmpRoot, "ws");
    mkdirSync(ws, { recursive: true });
    realpathMock.mockClear();

    const result = tryConvertToWorkspacePath(CLOUD_TARGET, ws);

    expect(result).toBeNull();
    // The cloud target is NEVER realpath'd (the dead-mount main-thread block).
    expect(realpathMock).not.toHaveBeenCalledWith(CLOUD_TARGET);
  });

  it("resolveLibraryPath does NOT realpathSync a cloud-classified absolute candidate (falls through to non-resolvable handling)", () => {
    const ws = path.join(tmpRoot, "ws");
    mkdirSync(ws, { recursive: true });
    realpathMock.mockClear();

    // An absolute cloud path that isn't under the workspace root → resolveLibraryPath
    // routes it through tryConvertToWorkspacePath, which must NOT realpath the cloud
    // target. Conversion fails (null) → existing fake-absolute / not-found handling
    // applies; we only assert the cloud target is never realpath'd here.
    try {
      resolveLibraryPath(CLOUD_TARGET, ws);
    } catch {
      /* non-resolvable cloud path may throw downstream — irrelevant to this assertion */
    }
    expect(realpathMock).not.toHaveBeenCalledWith(CLOUD_TARGET);
  });

  it("a LOCAL absolute target STILL gets realpathSync'd (fast path unchanged)", () => {
    const ws = path.join(tmpRoot, "ws");
    mkdirSync(path.join(ws, "a"), { recursive: true });
    const file = path.join(ws, "a", "local.md");
    writeFileSync(file, "hi");
    realpathMock.mockClear();

    const result = tryConvertToWorkspacePath(file, ws);

    expect(result).toBe(path.join("a", "local.md"));
    // The local target IS realpath'd (cycle/containment resolution preserved).
    expect(realpathMock).toHaveBeenCalledWith(file);
  });
});

/**
 * S4.1f Stage 3 — MUST-FIX C: the THREE remaining SYNC probes on the path-
 * resolution lane (`realpathSync(workspaceRoot)` in `tryConvertToWorkspacePath`,
 * and `existsSync(candidate)` / `existsSync(relativeAttempt)` in
 * `resolveLibraryPath`) must short-circuit when the path is cloud-CLASSIFIED
 * (pure-string `detectCloudStorage`, no I/O) BEFORE the probe — otherwise a dead
 * cloud FUSE mount blocks the main thread with no timeout (a hang, NOT a throw).
 *
 * The RS-F1 guard above already covers the cloud-TARGET case; these cover the
 * residual where the target/candidate is LOCAL-looking but the workspace ROOT
 * (or the absolute candidate itself) is cloud-hosted. LOCAL paths are unchanged.
 */
describe("path-resolution sync probes — S4.1f MUST-FIX C cloud short-circuit", () => {
  // Synthetic, NON-EXISTENT cloud paths — `detectCloudStorage` is a pure string
  // match, so these classify as cloud without any filesystem access (the whole
  // point: we must decide BEFORE touching a possibly-dead mount).
  const CLOUD_ROOT =
    "/Users/test/Library/CloudStorage/GoogleDrive-test@example.com/Shared drives/Workspace";
  const CLOUD_CANDIDATE =
    "/Users/test/Library/CloudStorage/GoogleDrive-test@example.com/Shared drives/Memory/doc.md";

  it("Probe 1 — a CLOUD workspace ROOT is NOT realpathSync'd (tryConvertToWorkspacePath)", () => {
    // Local, existing target so it passes the cloud-TARGET guard and IS realpath'd
    // (proving we reached the ROOT-realpath step); the cloud ROOT must be skipped.
    const localTarget = path.join(tmpRoot, "local-doc.md");
    writeFileSync(localTarget, "hi");
    realpathMock.mockClear();

    const result = tryConvertToWorkspacePath(localTarget, CLOUD_ROOT);

    // Local target outside the cloud lexical root → not resolvable → null.
    expect(result).toBeNull();
    // The local target IS realpath'd; the CLOUD root is NEVER realpath'd.
    expect(realpathMock).toHaveBeenCalledWith(localTarget);
    expect(realpathMock).not.toHaveBeenCalledWith(CLOUD_ROOT);
  });

  it("Probe 1 — a LOCAL workspace root IS realpathSync'd (behaviour unchanged)", () => {
    const ws = path.join(tmpRoot, "ws");
    mkdirSync(path.join(ws, "a"), { recursive: true });
    const file = path.join(ws, "a", "f.md");
    writeFileSync(file, "hi");
    realpathMock.mockClear();

    const result = tryConvertToWorkspacePath(file, ws);

    expect(result).toBe(path.join("a", "f.md"));
    // The local root IS realpath'd (the realpath fast path is preserved verbatim).
    expect(realpathMock).toHaveBeenCalledWith(ws);
  });

  it("Probe 2 — a CLOUD absolute CANDIDATE is NOT existsSync'd (resolveLibraryPath)", () => {
    const localRoot = path.join(tmpRoot, "ws");
    mkdirSync(localRoot, { recursive: true });
    existsMock.mockClear();

    // The cloud candidate isn't under the local root and fails symlink conversion
    // (cloud-TARGET guard → null), entering the fake-absolute branch. The cloud
    // candidate must NOT reach existsSync. Downstream may throw (security check on
    // a cloud-absolute path outside the workspace) — irrelevant to this assertion.
    try {
      resolveLibraryPath(CLOUD_CANDIDATE, localRoot);
    } catch {
      /* non-resolvable cloud candidate may throw the security error — expected */
    }
    expect(existsMock).not.toHaveBeenCalledWith(CLOUD_CANDIDATE);
  });

  it("Probe 3 — when the ROOT is cloud, the under-root relativeAttempt is NOT existsSync'd", () => {
    // A fake-absolute path that is NOT itself cloud-classified (so it passes the
    // Probe-2 candidate guard) but whose workspace-relative form resolves UNDER the
    // cloud root → relativeAttempt is cloud → existsSync must be skipped.
    const fakeAbsolute = "/Memory/notes.md";
    existsMock.mockClear();

    try {
      resolveLibraryPath(fakeAbsolute, CLOUD_ROOT);
    } catch {
      /* security check may throw on the leading-slash absolute — irrelevant here */
    }

    const relativeAttempt = path.resolve(CLOUD_ROOT, "Memory/notes.md");
    // Sanity: relativeAttempt is genuinely cloud-classified (root is cloud).
    expect(detectCloudStorage(relativeAttempt).isCloud).toBe(true);
    // The under-cloud-root relativeAttempt is NEVER existsSync'd.
    expect(existsMock).not.toHaveBeenCalledWith(relativeAttempt);
  });

  it("Probe 2/3 — a LOCAL fake-absolute path STILL hits existsSync and resolves workspace-relative (unchanged)", () => {
    const localRoot = path.join(tmpRoot, "ws");
    mkdirSync(localRoot, { recursive: true });
    // A real workspace file reachable via the fake-absolute → workspace-relative
    // salvage path (the legacy behaviour we must preserve byte-for-byte locally).
    const real = path.join(localRoot, "Memory", "notes.md");
    mkdirSync(path.dirname(real), { recursive: true });
    writeFileSync(real, "hi");
    existsMock.mockClear();

    const { root, resolved } = resolveLibraryPath("/Memory/notes.md", localRoot);

    expect(root).toBe(path.resolve(localRoot));
    expect(resolved).toBe(path.resolve(localRoot, "Memory", "notes.md"));
    // The local probes ARE exercised (the salvage path is preserved):
    // candidate existsSync('/Memory/notes.md') → false, then
    // relativeAttempt existsSync(<root>/Memory/notes.md) → true.
    expect(existsMock).toHaveBeenCalledWith("/Memory/notes.md");
    expect(existsMock).toHaveBeenCalledWith(path.resolve(localRoot, "Memory", "notes.md"));
  });
});
