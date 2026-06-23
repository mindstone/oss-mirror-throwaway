import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_CONDITIONS } from '../src/core/sentry/knownConditions';
import type { ConditionMeta } from '../src/core/sentry/knownConditions';

export interface SnapshotEntry {
  addedAt: string;
  /** Delivery policy — snapshotted so re-levels/sink flips are a reviewable diff (see check-known-conditions.ts `level-or-sink-mismatch`). */
  level?: string;
  sink?: string;
  deprecatedAt?: string;
  removableAfter?: string;
  expectedDegradedUntil?: string;
}

export function mergeSnapshot(
  existing: Record<string, SnapshotEntry>,
  registry: Record<string, ConditionMeta>,
): { merged: Record<string, SnapshotEntry>; preservedTombstones: string[] } {
  const merged: Record<string, SnapshotEntry> = { ...existing };

  for (const [condition, meta] of Object.entries(registry)) {
    const snapEntry: SnapshotEntry = { addedAt: meta.addedAt, level: meta.level };
    if (meta.sink) snapEntry.sink = meta.sink;
    if (meta.deprecatedAt) snapEntry.deprecatedAt = meta.deprecatedAt;
    if (meta.removableAfter) snapEntry.removableAfter = meta.removableAfter;
    if (meta.expectedDegraded) snapEntry.expectedDegradedUntil = meta.expectedDegraded.until;
    merged[condition] = snapEntry;
  }

  const sorted: Record<string, SnapshotEntry> = {};
  for (const condition of Object.keys(merged).sort()) {
    sorted[condition] = merged[condition];
  }

  const preservedTombstones = Object.keys(existing).filter((key) => !(key in registry));
  return { merged: sorted, preservedTombstones };
}

function regenerate() {
  const snapshotPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'known-conditions.snapshot.json');

  const existing: Record<string, SnapshotEntry> = fs.existsSync(snapshotPath)
    ? JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
    : {};

  const { merged, preservedTombstones } = mergeSnapshot(existing, KNOWN_CONDITIONS);

  const dataDir = path.dirname(snapshotPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  fs.writeFileSync(snapshotPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');

  if (preservedTombstones.length > 0) {
    console.log(
      `Regenerated snapshot at ${snapshotPath} (preserved ${preservedTombstones.length} historical entries no longer in registry: ${preservedTombstones.join(', ')}). ` +
      `To prune a historical entry, delete it from the snapshot file manually AFTER its removableAfter has passed — the regenerate script intentionally never drops entries to preserve append-only enforcement.`,
    );
  } else {
    console.log(`Regenerated snapshot at ${snapshotPath}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  regenerate();
}
