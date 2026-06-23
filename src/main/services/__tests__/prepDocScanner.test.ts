import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockWarn } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    warn: mockWarn,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { findPrepDocPaths, scanPrepDocsInRange } from '../prepDocScanner';

function prepDoc(frontmatter: string, body = 'Prep content'): string {
  return `---\n${frontmatter.trim()}\n---\n\n${body}\n`;
}

async function writeSourceFile(
  coreDirectory: string,
  dayFolder: string,
  fileName: string,
  content: string,
): Promise<string> {
  const folderPath = path.join(coreDirectory, 'memory', 'sources', dayFolder);
  await fs.mkdir(folderPath, { recursive: true });
  const filePath = path.join(folderPath, fileName);
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

describe('prepDocScanner', () => {
  let coreDirectory: string;

  beforeEach(async () => {
    coreDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'prep-doc-scanner-'));
    mockWarn.mockReset();
  });

  afterEach(async () => {
    await fs.rm(coreDirectory, { recursive: true, force: true });
  });

  it('scans only prep docs in the requested date range folders', async () => {
    await writeSourceFile(
      coreDirectory,
      '2026/04-Apr/09',
      '260409_1000_meeting_in-range-prep.md',
      prepDoc(`
type: meeting-prep
title: In range
meetingStartTime: 2026-04-09T10:00:00.000Z
goal_alignment:
  - goal: Launch Q2 strategy
    space: Personal
meeting_utility: productive
enriched_at: 2026-04-09T09:00:00.000Z
enriched_by: focus-weekly-prep
      `),
    );

    await writeSourceFile(
      coreDirectory,
      '2026/04-Apr/12',
      '260412_1200_meeting_out-of-range-prep.md',
      prepDoc(`
type: meeting-prep
title: Out of range
meetingStartTime: 2026-04-12T12:00:00.000Z
goal_alignment:
  - goal: Build pipeline
    space: Work
meeting_utility: productive
enriched_at: 2026-04-12T11:00:00.000Z
enriched_by: focus-weekly-prep
      `),
    );

    const result = scanPrepDocsInRange(
      coreDirectory,
      new Date('2026-04-09T00:00:00.000Z'),
      new Date('2026-04-10T23:59:59.999Z'),
    );

    expect(result.size).toBe(1);
    expect(result.has('2026-04-09T10:00:00.000Z')).toBe(true);
    expect(result.has('2026-04-12T12:00:00.000Z')).toBe(false);
  });

  it('parses enriched prep docs including nested goal_alignment arrays', async () => {
    await writeSourceFile(
      coreDirectory,
      '2026/04-Apr/10',
      '260410_0900_meeting_strategy-prep.md',
      prepDoc(`
type: meeting-prep
title: Strategy sync
meetingStartTime: 2026-04-10T09:00:00.000Z
goal_alignment:
  - goal: Launch Q2 strategy
    space: Personal
  - goal: Hire senior designer
    space: Mindstone
meeting_utility: productive
enriched_at: 2026-04-10T08:30:00.000Z
enriched_by: focus-monthly-review
      `),
    );

    const result = scanPrepDocsInRange(
      coreDirectory,
      new Date('2026-04-10T00:00:00.000Z'),
      new Date('2026-04-10T23:59:59.999Z'),
    );

    expect(result.get('2026-04-10T09:00:00.000Z')).toEqual({
      goalAlignment: [
        { goal: 'Launch Q2 strategy', space: 'Personal' },
        { goal: 'Hire senior designer', space: 'Mindstone' },
      ],
      meetingUtility: 'productive',
      enrichedAt: '2026-04-10T08:30:00.000Z',
      enrichedBy: 'focus-monthly-review',
    });
  });

  it('skips non-prep markdown files', async () => {
    await writeSourceFile(
      coreDirectory,
      '2026/04-Apr/09',
      '260409_1000_meeting_plain.md',
      prepDoc(`
type: meeting-prep
title: Not a prep suffix
meetingStartTime: 2026-04-09T10:00:00.000Z
goal_alignment:
  - goal: Launch Q2 strategy
    space: Personal
meeting_utility: productive
enriched_at: 2026-04-09T09:00:00.000Z
enriched_by: focus-weekly-prep
      `),
    );

    await writeSourceFile(
      coreDirectory,
      '2026/04-Apr/09',
      '260409_1100_meeting_actual-prep.md',
      prepDoc(`
type: meeting-prep
title: Actual prep file
meetingStartTime: 2026-04-09T11:00:00.000Z
goal_alignment:
  - goal: Launch Q2 strategy
    space: Personal
meeting_utility: productive
enriched_at: 2026-04-09T10:30:00.000Z
enriched_by: focus-weekly-prep
      `),
    );

    const map = scanPrepDocsInRange(
      coreDirectory,
      new Date('2026-04-09T00:00:00.000Z'),
      new Date('2026-04-09T23:59:59.999Z'),
    );
    const metadata = findPrepDocPaths(
      coreDirectory,
      new Date('2026-04-09T00:00:00.000Z'),
      new Date('2026-04-09T23:59:59.999Z'),
    );

    expect(map.size).toBe(1);
    expect(map.has('2026-04-09T11:00:00.000Z')).toBe(true);
    expect(metadata).toHaveLength(1);
    expect(metadata[0]?.meetingStartTime).toBe('2026-04-09T11:00:00.000Z');
  });

  it('treats prep docs without enrichment fields as non-enriched', async () => {
    const prepPath = await writeSourceFile(
      coreDirectory,
      '2026/04-Apr/11',
      '260411_0900_meeting_unenriched-prep.md',
      prepDoc(`
type: meeting-prep
title: Unenriched prep
meetingStartTime: 2026-04-11T09:00:00.000Z
created: 2026-04-10T18:30:00.000Z
      `),
    );

    const map = scanPrepDocsInRange(
      coreDirectory,
      new Date('2026-04-11T00:00:00.000Z'),
      new Date('2026-04-11T23:59:59.999Z'),
    );
    const metadata = findPrepDocPaths(
      coreDirectory,
      new Date('2026-04-11T00:00:00.000Z'),
      new Date('2026-04-11T23:59:59.999Z'),
    );

    expect(map.size).toBe(0);
    expect(metadata).toEqual([
      {
        path: prepPath,
        title: 'Unenriched prep',
        meetingStartTime: '2026-04-11T09:00:00.000Z',
        hasEnrichment: false,
      },
    ]);
  });

  it('handles malformed YAML per file, logs warning, and continues scanning', async () => {
    await writeSourceFile(
      coreDirectory,
      '2026/04-Apr/09',
      '260409_0900_meeting_broken-prep.md',
      `---
type: meeting-prep
title: "Broken prep
meetingStartTime: 2026-04-09T09:00:00.000Z
---
Broken content
`,
    );

    await writeSourceFile(
      coreDirectory,
      '2026/04-Apr/09',
      '260409_1000_meeting_valid-prep.md',
      prepDoc(`
type: meeting-prep
title: Valid prep
meetingStartTime: 2026-04-09T10:00:00.000Z
goal_alignment:
  - goal: Launch Q2 strategy
    space: Personal
meeting_utility: productive
enriched_at: 2026-04-09T09:30:00.000Z
enriched_by: focus-weekly-prep
      `),
    );

    const result = scanPrepDocsInRange(
      coreDirectory,
      new Date('2026-04-09T00:00:00.000Z'),
      new Date('2026-04-09T23:59:59.999Z'),
    );

    expect(result.size).toBe(1);
    expect(result.has('2026-04-09T10:00:00.000Z')).toBe(true);
    expect(mockWarn).toHaveBeenCalled();
  });

  it('handles missing memory/sources directories gracefully', () => {
    const map = scanPrepDocsInRange(
      coreDirectory,
      new Date('2026-04-09T00:00:00.000Z'),
      new Date('2026-04-10T23:59:59.999Z'),
    );
    const metadata = findPrepDocPaths(
      coreDirectory,
      new Date('2026-04-09T00:00:00.000Z'),
      new Date('2026-04-10T23:59:59.999Z'),
    );

    expect(map.size).toBe(0);
    expect(metadata).toEqual([]);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('findPrepDocPaths returns title/start-time metadata and enrichment status', async () => {
    const enrichedPath = await writeSourceFile(
      coreDirectory,
      '2026/04-Apr/13',
      '260413_0900_meeting_enriched-prep.md',
      prepDoc(`
type: meeting-prep
title: Enriched prep
meetingStartTime: 2026-04-13T09:00:00.000Z
goal_alignment:
  - goal: Improve retention
    space: Mindstone
meeting_utility: blocker
enriched_at: 2026-04-13T08:30:00.000Z
enriched_by: focus-weekly-prep
      `),
    );

    const plainPath = await writeSourceFile(
      coreDirectory,
      '2026/04-Apr/13',
      '260413_1300_meeting_plain-prep.md',
      prepDoc(`
type: meeting-prep
title: Plain prep
meetingStartTime: 2026-04-13T13:00:00.000Z
created: 2026-04-13T07:00:00.000Z
      `),
    );

    const metadata = findPrepDocPaths(
      coreDirectory,
      new Date('2026-04-13T00:00:00.000Z'),
      new Date('2026-04-13T23:59:59.999Z'),
    );

    expect(metadata).toEqual([
      {
        path: enrichedPath,
        title: 'Enriched prep',
        meetingStartTime: '2026-04-13T09:00:00.000Z',
        hasEnrichment: true,
      },
      {
        path: plainPath,
        title: 'Plain prep',
        meetingStartTime: '2026-04-13T13:00:00.000Z',
        hasEnrichment: false,
      },
    ]);
  });
});
