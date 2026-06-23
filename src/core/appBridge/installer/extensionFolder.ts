/**
 * Extension extraction planning helpers.
 *
 * This module decides whether the bundled browser-extension source needs
 * to be re-extracted to its target folder under userData. The decision
 * used to be "same manifest.version → skip". That was wrong: a rebuild
 * that keeps the version string pinned (common during dev, and possible
 * in production if forgotten) kept shipping stale code to users. A
 * content hash of the source tree is now the authoritative freshness
 * signal; the version string is retained only as a defensive secondary
 * check (to avoid downgrades).
 *
 * State is persisted alongside the extracted copy in a marker file
 * `.rebel-extraction-state.json`. The marker is written into the
 * staging directory BEFORE the rename swap so it moves atomically with
 * the extracted content — if the rename succeeds, the marker is fresh;
 * if it fails, there is no stale marker claiming we're up to date.
 */

import { createHash } from 'node:crypto';

/**
 * Filename of the marker that lives inside every extracted extension
 * folder. Starts with a dot so browsers that list the folder don't show
 * it as a bundled extension asset. Keep this name stable — changing it
 * invalidates every installed user's marker and forces a re-extract on
 * the next run, which is usually fine but worth noting in the commit.
 */
export const EXTRACTION_STATE_FILENAME = '.rebel-extraction-state.json' as const;

/**
 * Version-1 marker shape. Future changes should bump `schemaVersion` and
 * have `readExtractionState` treat unknown versions as "no state" so the
 * rollout path is: new build lands → marker rewritten with new version.
 * Older runtimes reading a newer marker will re-extract, which is safe.
 */
export interface ExtractionState {
  schemaVersion: 1;
  /** sha256 hex of the source tree at extract time. */
  sourceHash: string;
  /** manifest.version at extract time — kept as a secondary safety net. */
  sourceManifestVersion: string;
  /** ms since epoch. Debug/forensics only; never used for freshness. */
  extractedAt: number;
}

export function semverCompare(a: string, b: string): -1 | 0 | 1 {
  const cleanA = (a || '').split('-')[0].replace(/[^0-9.]/g, '');
  const cleanB = (b || '').split('-')[0].replace(/[^0-9.]/g, '');

  const pa = cleanA.split('.').map(x => parseInt(x, 10)).filter(x => !isNaN(x));
  const pb = cleanB.split('.').map(x => parseInt(x, 10)).filter(x => !isNaN(x));

  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const numA = pa[i] || 0;
    const numB = pb[i] || 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}

export async function readManifest(
  readFile: (p: string) => Promise<string>,
  manifestPath: string
): Promise<{ version: string } | null> {
  try {
    const content = await readFile(manifestPath);
    const parsed = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.version === 'string') {
      return parsed as { version: string };
    }
    return null;
  } catch {
    // Return null for any read error (including ENOENT) or parse error
    return null;
  }
}

/**
 * Tolerant reader for the extraction-state marker. Any read error,
 * parse error, schema drift, or missing required field returns `null`
 * — which `planExtraction` treats as "no state, re-extract".
 *
 * Silent-failure note: this is intentional and safe because the fallback
 * is "do more work" (re-extract), not "silently continue with stale
 * code". We also log the decision at the caller, so a corrupt marker
 * becomes visible as a `write` action with reason `state-missing`.
 */
export async function readExtractionState(
  readFile: (p: string) => Promise<string>,
  statePath: string,
): Promise<ExtractionState | null> {
  try {
    const content = await readFile(statePath);
    const parsed = JSON.parse(content);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      parsed.schemaVersion === 1 &&
      typeof parsed.sourceHash === 'string' &&
      parsed.sourceHash.length === 64 &&
      typeof parsed.sourceManifestVersion === 'string' &&
      typeof parsed.extractedAt === 'number'
    ) {
      return parsed as ExtractionState;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Serialize + write an extraction-state marker. Caller supplies the
 * writer so the same function works in both the real main process (fs
 * promises) and tests (mocked writer).
 */
export async function writeExtractionState(
  writeFile: (p: string, content: string) => Promise<void>,
  statePath: string,
  state: ExtractionState,
): Promise<void> {
  const serialized = JSON.stringify(state, null, 2) + '\n';
  await writeFile(statePath, serialized);
}

/**
 * Walk a directory tree and return a stable sha256 of its contents.
 *
 * Stability properties (important for the "same bundle → same hash"
 * contract that makes this function safe to compare across runs and
 * across platforms):
 *   • Entries are sorted by relative path BEFORE hashing, so OS
 *     readdir ordering differences don't affect the output.
 *   • Only file contents + relative paths feed the hash — no mtime,
 *     no size, no inode.
 *   • Relative paths use '/' separators so macOS and Windows produce
 *     the same hash for the same logical tree.
 *   • Noise files (.DS_Store, Thumbs.db, .git/**, *.swp) are skipped.
 *     These appear when developers poke around in the source dir and
 *     would otherwise cause phantom re-extractions.
 *   • Directory paths themselves are NOT hashed (only file contents),
 *     so an empty directory adjustment doesn't change the hash. This
 *     matches the operational intent: "did the shipped extension code
 *     actually change?"
 */
export async function computeExtensionSourceHash(
  sourceDir: string,
  deps: {
    readdir: (p: string, opts: { withFileTypes: true }) => Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>;
    readFile: (p: string) => Promise<Buffer>;
    pathJoin: (...parts: string[]) => string;
  },
): Promise<string> {
  const entries: Array<{ relPath: string; buf: Buffer }> = [];

  async function walk(dir: string, rel: string): Promise<void> {
    const items = await deps.readdir(dir, { withFileTypes: true });
    // Sort AFTER reading so the order is deterministic regardless of
    // filesystem enumeration order (macOS HFS+, Windows NTFS, ext4 all
    // differ). localeCompare without locale is byte-wise enough for
    // our purposes — we just need a stable total order.
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of items) {
      const name = item.name;
      if (isIgnoredEntry(name)) continue;
      const full = deps.pathJoin(dir, name);
      const nextRel = rel ? `${rel}/${name}` : name;
      if (item.isDirectory()) {
        await walk(full, nextRel);
      } else if (item.isFile()) {
        entries.push({ relPath: nextRel, buf: await deps.readFile(full) });
      }
      // Symlinks / sockets / devices are ignored — the extension
      // bundle should never contain these.
    }
  }

  await walk(sourceDir, '');

  // Second sort guards against the (unlikely) case where two siblings
  // have the same name in different subtrees; it also makes the hash
  // order independent of recursion traversal order.
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const h = createHash('sha256');
  for (const { relPath, buf } of entries) {
    // Use NUL delimiters so "foo\0bar" and "fo\0obar" can't collide.
    // Also include file length as a belt-and-suspenders collision guard.
    h.update(relPath);
    h.update('\0');
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt(buf.length));
    h.update(len);
    h.update(buf);
    h.update('\0');
  }
  return h.digest('hex');
}

function isIgnoredEntry(name: string): boolean {
  if (name === '.DS_Store') return true;
  if (name === 'Thumbs.db') return true;
  if (name === '.git') return true;
  if (name === 'node_modules') return true;
  if (name.endsWith('.swp')) return true;
  return false;
}

/**
 * Decide whether to re-extract the bundled extension. Hash is the
 * authoritative signal; version-string is a secondary guard against
 * downgrades.
 *
 * Decision matrix:
 *   - existing state missing (no marker, or corrupt marker) → write
 *     (covers first install + pre-marker installs + tampered state)
 *   - source hash differs from marker → write (rebuild detected)
 *   - same hash, but existing manifest.version > new manifest.version →
 *     skip (refuse to downgrade; same behavior as the old planner)
 *   - same hash, new manifest.version > existing → write (belt & braces;
 *     hashes matching yet versions disagreeing is anomalous, prefer
 *     re-extract with clean state)
 *   - same hash, matching versions → skip
 */
export function planExtraction(args: {
  sourceDir: string;
  targetDir: string;
  existingManifest?: { version: string } | null;
  newManifest: { version: string };
  existingState?: ExtractionState | null;
  newSourceHash: string;
}): { action: 'write' | 'skip'; reason: string } {
  if (!args.existingManifest) {
    return { action: 'write', reason: 'target-missing' };
  }

  if (!args.existingState) {
    // Extracted folder exists but we have no trustworthy state marker.
    // Could be a pre-v1 install, could be a partial rename, could be
    // user tampering. Safest outcome: re-extract with a clean state.
    return { action: 'write', reason: 'state-missing' };
  }

  if (args.existingState.sourceHash !== args.newSourceHash) {
    // This is the bug-fix path the whole commit exists for: bundle
    // contents changed even if manifest.version didn't.
    return { action: 'write', reason: 'content-hash-mismatch' };
  }

  const cmp = semverCompare(args.newManifest.version, args.existingManifest.version);
  if (cmp < 0) {
    // Refuse to downgrade on matching hash (anomalous case: how did we
    // get a newer extracted copy with the exact content hash of an
    // older source? Probably a dev scenario. Preserve the extracted
    // newer copy rather than silently overwriting.)
    return { action: 'skip', reason: 'target-newer' };
  }
  if (cmp > 0) {
    // Same content hash but source claims a newer version — unusual;
    // rewrite so the marker + manifest version converge.
    return { action: 'write', reason: 'version-mismatch-on-same-hash' };
  }
  return { action: 'skip', reason: 'target-matches' };
}
