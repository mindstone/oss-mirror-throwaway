/**
 * Unit tests for the "Direct static importers" checklist category
 * (DI-1, Stage 2 of docs/plans/260613_impact-map-completeness/PLAN.md).
 *
 * Drives the pure `buildReverseDepItems` helper with a SYNTHETIC reverseDeps map
 * + changed-file set — no git, no madge, no 45s map generation. The headline
 * assertion (a) proves the same-surface `scripts → scripts` cross-consumer
 * regression class (the resolveBaseSha postmortem) is caught: a strict
 * cross-surface filter would have dropped it, but our design lists it.
 */
import { describe, it, expect } from 'vitest';
import { buildReverseDepItems } from '../generate-boundary-checklist.js';

/** Concatenate an item's label + details into one searchable string. */
function itemText(item: { label: string; details: string[] }): string {
  return [item.label, ...item.details].join('\n');
}

describe('buildReverseDepItems', () => {
  it('(a) catches the same-surface scripts→scripts regression class (resolveBaseSha postmortem)', () => {
    const changed = new Set(['scripts/check-eslint-new-warnings.ts']);
    const reverseDeps = {
      'scripts/check-eslint-new-warnings.ts': ['scripts/lib/knip-diff-guard.ts'],
    };
    const surface = {
      'scripts/check-eslint-new-warnings.ts': 'scripts',
      'scripts/lib/knip-diff-guard.ts': 'scripts',
    };

    const items = buildReverseDepItems(changed, reverseDeps, surface);

    // A listed, pending item naming knip-diff-guard must be emitted. A
    // cross-surface-as-FILTER design would have produced NOTHING here (both
    // files are `scripts`), silently re-shipping the regression class.
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.id).toBe('revdep:scripts/check-eslint-new-warnings.ts');
    expect(item.category).toBe('reverse-dep');
    expect(item.state).toBe('pending');
    expect(itemText(item)).toContain('scripts/lib/knip-diff-guard.ts');
    // Same-surface → medium priority, but still LISTED (not dropped).
    expect(itemText(item)).toContain('Priority: medium');
  });

  it('(b) low fan-in cross-surface → high-priority item listing importers with surfaces', () => {
    const changed = new Set(['src/core/foo.ts']);
    const reverseDeps = {
      'src/core/foo.ts': [
        'src/main/services/bar.ts',
        'src/renderer/features/baz/useBaz.ts',
        'src/core/sibling.ts',
      ],
    };
    const surface = {
      'src/core/foo.ts': 'core',
      'src/main/services/bar.ts': 'main',
      'src/renderer/features/baz/useBaz.ts': 'renderer',
      'src/core/sibling.ts': 'core',
    };

    const items = buildReverseDepItems(changed, reverseDeps, surface);
    expect(items).toHaveLength(1);
    const text = itemText(items[0]);
    expect(text).toContain('Priority: high');
    expect(items[0].label).toContain('cross-boundary');
    // Each importer listed with its surface.
    expect(text).toContain('src/main/services/bar.ts (main)');
    expect(text).toContain('src/renderer/features/baz/useBaz.ts (renderer)');
    expect(text).toContain('src/core/sibling.ts (core)');
  });

  it('(c) high fan-in (>20) → collapsed summary (count + per-surface), NOT a full dump', () => {
    const importers: string[] = [];
    const surface: Record<string, string> = { 'src/core/logger.ts': 'core' };
    // 18 main importers + 7 renderer importers = 25 (> cap of 20).
    for (let i = 0; i < 18; i++) {
      const f = `src/main/m${i}.ts`;
      importers.push(f);
      surface[f] = 'main';
    }
    for (let i = 0; i < 7; i++) {
      const f = `src/renderer/r${i}.ts`;
      importers.push(f);
      surface[f] = 'renderer';
    }
    const changed = new Set(['src/core/logger.ts']);
    const reverseDeps = { 'src/core/logger.ts': importers };

    const items = buildReverseDepItems(changed, reverseDeps, surface);
    expect(items).toHaveLength(1);
    const item = items[0];
    const text = itemText(item);
    // Collapsed: count + per-surface breakdown + pointer; NO full list.
    expect(item.label).toContain('25 direct static importers');
    expect(item.label).toContain('collapsed');
    expect(text).toContain('Importer surfaces: main 18, renderer 7');
    expect(text).toContain('boundary-map.json reverseDeps');
    expect(text).toContain('Priority: info');
    // Must NOT dump the full importer list.
    expect(text).not.toContain('src/main/m0.ts');
    expect(text).not.toContain('src/renderer/r0.ts');
  });

  it('(d) same-surface low fan-in → still listed (not filtered out), medium priority', () => {
    const changed = new Set(['src/core/foo.ts']);
    const reverseDeps = {
      'src/core/foo.ts': ['src/core/a.ts', 'src/core/b.ts'],
    };
    const surface = {
      'src/core/foo.ts': 'core',
      'src/core/a.ts': 'core',
      'src/core/b.ts': 'core',
    };

    const items = buildReverseDepItems(changed, reverseDeps, surface);
    expect(items).toHaveLength(1);
    const text = itemText(items[0]);
    expect(text).toContain('Priority: medium');
    expect(text).toContain('src/core/a.ts (core)');
    expect(text).toContain('src/core/b.ts (core)');
    expect(items[0].label).not.toContain('cross-boundary');
  });

  it('(e) changed file with 0 importers → no item emitted (quiet)', () => {
    const changed = new Set(['src/core/orphan.ts', 'src/core/missing.ts']);
    const reverseDeps = {
      'src/core/orphan.ts': [], // present but empty
      // 'src/core/missing.ts' absent from the map entirely
    };
    const surface = { 'src/core/orphan.ts': 'core', 'src/core/missing.ts': 'core' };

    const items = buildReverseDepItems(changed, reverseDeps, surface);
    expect(items).toHaveLength(0);
  });

  it('exactly at the cap (20) lists in full; one over collapses', () => {
    const mk = (n: number) => {
      const importers: string[] = [];
      const surface: Record<string, string> = { 'src/core/x.ts': 'core' };
      for (let i = 0; i < n; i++) {
        const f = `src/core/c${i}.ts`;
        importers.push(f);
        surface[f] = 'core';
      }
      return { importers, surface };
    };
    const at = mk(20);
    const atItems = buildReverseDepItems(
      new Set(['src/core/x.ts']),
      { 'src/core/x.ts': at.importers },
      at.surface,
    );
    expect(itemText(atItems[0])).toContain('src/core/c0.ts'); // listed in full

    const over = mk(21);
    const overItems = buildReverseDepItems(
      new Set(['src/core/x.ts']),
      { 'src/core/x.ts': over.importers },
      over.surface,
    );
    expect(overItems[0].label).toContain('collapsed');
    expect(itemText(overItems[0])).not.toContain('src/core/c0.ts');
  });

  it('co-changed importer is annotated "already in diff" and does not drive priority', () => {
    // foo.ts changed; its only importer bar.ts is ALSO changed and same surface.
    const changed = new Set(['src/core/foo.ts', 'src/core/bar.ts']);
    const reverseDeps = { 'src/core/foo.ts': ['src/core/bar.ts'] };
    const surface = { 'src/core/foo.ts': 'core', 'src/core/bar.ts': 'core' };

    const items = buildReverseDepItems(changed, reverseDeps, surface);
    const fooItem = items.find((i) => i.id === 'revdep:src/core/foo.ts')!;
    expect(itemText(fooItem)).toContain('already in diff');
    expect(itemText(fooItem)).toContain('Priority: medium');
  });

  it('unclassified importer surface falls back to "other" without crashing', () => {
    const changed = new Set(['src/core/foo.ts']);
    const reverseDeps = { 'src/core/foo.ts': ['some/unknown/path.ts'] };
    const surface = {}; // empty classification map
    const items = buildReverseDepItems(changed, reverseDeps, surface);
    expect(items).toHaveLength(1);
    // foo.ts surface 'other', importer surface 'other' → same surface → medium.
    expect(itemText(items[0])).toContain('some/unknown/path.ts (other)');
  });
});
