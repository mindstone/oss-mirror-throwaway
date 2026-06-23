import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * Stage 4a/4b — chokidar/readdirp SOURCE-CONTRACT pins.
 *
 * The watcher's cloud-symlink ignore matcher (workspaceWatcherService) relies on
 * two upstream control-flow facts that the GPT reviews
 * (260619_102941 F2 / 260619_131151 F2) established by reading the installed
 * dependency source — facts the unit tests (which drive `anymatch` directly)
 * cannot prove, because they don't exercise chokidar/readdirp's real call order:
 *
 *   1. chokidar invokes the `ignored` FUNCTION matcher with the entry's lstat as
 *      the 2nd arg (`_isntIgnored(path, entry.stats)`), watching with
 *      `{ alwaysStat: true, lstat: true }`. This is what lets the matcher detect
 *      NESTED symlinks (`stats.isSymbolicLink()`) at descent time — the Stage 4a
 *      fix. If a chokidar upgrade dropped the stats arg, the nested branch would
 *      silently go dead and cloud symlinks would be followed again.
 *
 *   2. readdirp classifies a symlink's type via `fs.realpath(full)` in
 *      `_getEntryType()` BEFORE it runs the `directoryFilter` (our ignore
 *      matcher). This is the RESIDUAL the matcher cannot close: the one blocking
 *      `realpath` per cloud symlink happens before we get a vote. The threadpool
 *      buffer (Stage 4b) + the Stage 2 liveness guard are the mitigation; the
 *      robust "don't realpath cloud symlinks" interception is SPUN OUT (see
 *      docs/plans/260619_turn-hang-bugmode/PLAN.md).
 *
 * These are PINNED-BEHAVIOR tests over the installed `node_modules` source. If an
 * upstream chokidar/readdirp bump changes either control flow, these fail with a
 * pointer to re-verify the matcher (1) or re-evaluate the residual/buffer (2) —
 * rather than a silent prod regression. They assert SOURCE SUBSTRINGS (cheap,
 * version-robust to formatting) on the exact lines the reviews cited.
 */

const require = createRequire(import.meta.url);

function readDep(relPath: string): string {
  const resolved = require.resolve(relPath);
  return readFileSync(resolved, 'utf8');
}

describe('chokidar/readdirp source contract — Stage 4a matcher relies on stats; Stage 4b residual is pre-filter realpath', () => {
  it('chokidar watches readdirp with { alwaysStat: true, lstat: true } (matcher gets an lstat per entry)', () => {
    const chokidar = readDep('chokidar/index.js');
    // index.js:941 — `_readdirp` builds options with alwaysStat + lstat so every
    // entry carries an lstat that flows to the ignore matcher.
    expect(chokidar).toContain('alwaysStat: true');
    expect(chokidar).toContain('lstat: true');
  });

  it('chokidar passes entry.stats to the ignore matcher (filterDir → _isntIgnored(path, entry.stats))', () => {
    const chokidar = readDep('chokidar/index.js');
    // index.js:276 — filterDir delegates to _isntIgnored WITH the entry stats; this
    // is the 2nd arg our function matcher reads as `stats.isSymbolicLink()`.
    expect(chokidar).toContain('this.fsw._isntIgnored(this.entryPath(entry), entry.stats)');
  });

  it('chokidar wires readdirp directoryFilter to filterDir (our matcher is consulted at descent)', () => {
    const handler = readDep('chokidar/lib/nodefs-handler.js');
    // nodefs-handler.js:470 — the directoryFilter readdirp calls IS chokidar's
    // filterDir, which consults our ignore matcher.
    expect(handler).toContain('directoryFilter: entry => wh.filterDir(entry)');
  });

  it('readdirp resolves symlink type via realpath BEFORE the directoryFilter (the residual ordering)', () => {
    const readdirp = readDep('readdirp/index.js');
    // index.js:131-132 — _getEntryType is awaited BEFORE _directoryFilter in _read.
    // We assert the ordering textually: the _getEntryType call precedes the
    // _directoryFilter call in the read loop.
    const getEntryTypeIdx = readdirp.indexOf('const entryType = await this._getEntryType(entry);');
    const directoryFilterIdx = readdirp.indexOf("entryType === 'directory' && this._directoryFilter(entry)");
    expect(getEntryTypeIdx).toBeGreaterThan(-1);
    expect(directoryFilterIdx).toBeGreaterThan(-1);
    expect(getEntryTypeIdx).toBeLessThan(directoryFilterIdx);
  });

  it('readdirp _getEntryType realpaths a symlink target (the blocking syscall the buffer/Stage-2 mitigate)', () => {
    const readdirp = readDep('readdirp/index.js');
    // index.js:209-212 — for a symlink entry, readdirp awaits realpath(full). On a
    // dead cloud mount this blocks in the kernel with no timeout → a parked libuv
    // worker, BEFORE our matcher can exclude it. If this disappears (upstream stops
    // realpathing symlinks), the residual is closed and the spun-out follow-up can
    // be reconsidered.
    expect(readdirp).toContain('stats.isSymbolicLink()');
    expect(readdirp).toContain('const entryRealPath = await realpath(full);');
  });
});
