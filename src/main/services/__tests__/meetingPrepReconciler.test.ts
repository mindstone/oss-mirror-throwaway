import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  }),
}));

vi.mock('../spaceService', () => ({
  scanSpaces: vi.fn(),
}));

import { scanSpaces } from '../spaceService';
import type { CachedMeeting } from '../meetingCacheStore';
import {
  attachPrepPathsFromDisk,
  _testing,
} from '../meetingPrepReconciler';

const { buildPrepPathIndex, computeDateRange, toRelativePortablePath } = _testing;

function makeMeeting(overrides: Partial<CachedMeeting> & { id: string }): CachedMeeting {
  return {
    id: overrides.id,
    calendarEventId: overrides.calendarEventId ?? `${overrides.id}-event`,
    calendarSource: overrides.calendarSource ?? 'google',
    calendarId: overrides.calendarId,
    title: overrides.title ?? 'Test Meeting',
    startTime: overrides.startTime ?? '2026-04-20T09:00:00.000Z',
    endTime: overrides.endTime ?? '2026-04-20T10:00:00.000Z',
    meetingUrl: overrides.meetingUrl,
    participants: overrides.participants ?? [],
    participantEmails: overrides.participantEmails,
    prepPath: overrides.prepPath,
    colorId: overrides.colorId,
  };
}

async function writePrepDoc(
  spaceRoot: string,
  relativeDayFolder: string,
  fileName: string,
  frontmatter: Record<string, string>,
): Promise<string> {
  const folder = path.join(spaceRoot, 'memory', 'sources', relativeDayFolder);
  await fs.mkdir(folder, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const filePath = path.join(folder, fileName);
  await fs.writeFile(filePath, `---\n${fm}\n---\n\nPrep body\n`, 'utf8');
  return filePath;
}

describe('meetingPrepReconciler helpers', () => {
  describe('computeDateRange', () => {
    it('returns null for empty input', () => {
      expect(computeDateRange([])).toBeNull();
    });

    it('pads range by one day each side', () => {
      const meetings: CachedMeeting[] = [
        makeMeeting({ id: 'a', startTime: '2026-04-20T10:00:00.000Z' }),
        makeMeeting({ id: 'b', startTime: '2026-04-22T10:00:00.000Z' }),
      ];
      const range = computeDateRange(meetings);
      expect(range).not.toBeNull();
      const day = 24 * 60 * 60 * 1000;
      expect(range!.start.getTime()).toBe(new Date('2026-04-20T10:00:00.000Z').getTime() - day);
      expect(range!.end.getTime()).toBe(new Date('2026-04-22T10:00:00.000Z').getTime() + day);
    });

    it('ignores meetings with invalid startTime but returns a range when at least one is valid', () => {
      const meetings: CachedMeeting[] = [
        makeMeeting({ id: 'a', startTime: 'not-a-date' }),
        makeMeeting({ id: 'b', startTime: '2026-04-20T10:00:00.000Z' }),
      ];
      const range = computeDateRange(meetings);
      expect(range).not.toBeNull();
    });
  });

  describe('toRelativePortablePath', () => {
    it('returns forward-slash separated relative path', () => {
      const base = path.join('/tmp', 'space');
      const absolute = path.join(base, 'memory', 'sources', '2026', '04-Apr', '20', 'prep.md');
      expect(toRelativePortablePath(base, absolute)).toBe('memory/sources/2026/04-Apr/20/prep.md');
    });
  });

  describe('buildPrepPathIndex', () => {
    it('indexes by meetingId and startTimeMs when both are present', () => {
      const base = '/tmp/space';
      const docPath = path.join(base, 'memory/sources/2026/04-Apr/20/prep.md');
      const index = buildPrepPathIndex(
        [
          {
            path: docPath,
            title: 'Meeting',
            meetingStartTime: '2026-04-20T10:00:00.000Z',
            hasEnrichment: false,
            meetingId: 'google:abc_123',
          },
        ],
        base,
      );

      expect(index.byMeetingId.get('google:abc_123')).toBe('memory/sources/2026/04-Apr/20/prep.md');
      expect(index.byStartTimeMs.get(new Date('2026-04-20T10:00:00.000Z').getTime())).toBe(
        'memory/sources/2026/04-Apr/20/prep.md',
      );
    });

    it('first doc for a given key wins (duplicates ignored)', () => {
      const base = '/tmp/space';
      const index = buildPrepPathIndex(
        [
          {
            path: path.join(base, 'a.md'),
            title: 'A',
            meetingStartTime: '2026-04-20T10:00:00.000Z',
            hasEnrichment: false,
            meetingId: 'x',
          },
          {
            path: path.join(base, 'b.md'),
            title: 'B',
            meetingStartTime: '2026-04-20T10:00:00.000Z',
            hasEnrichment: false,
            meetingId: 'x',
          },
        ],
        base,
      );

      expect(index.byMeetingId.get('x')).toBe('a.md');
      expect(index.byStartTimeMs.get(new Date('2026-04-20T10:00:00.000Z').getTime())).toBe('a.md');
    });
  });
});

describe('attachPrepPathsFromDisk', () => {
  let spaceRoot: string;

  beforeEach(async () => {
    spaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prep-reconciler-'));
    vi.mocked(scanSpaces).mockResolvedValue([
      {
        name: 'Chief of Staff',
        path: '.',
        absolutePath: spaceRoot,
        type: 'chief-of-staff',
        isSymlink: false,
        hasReadme: true,
      } as unknown as Awaited<ReturnType<typeof scanSpaces>>[number],
    ]);
  });

  afterEach(async () => {
    await fs.rm(spaceRoot, { recursive: true, force: true });
    vi.mocked(scanSpaces).mockReset();
  });

  it('returns meetings unchanged when coreDirectory is falsy', async () => {
    const meetings = [makeMeeting({ id: 'a' })];
    const result = await attachPrepPathsFromDisk(meetings, '');
    expect(result).toBe(meetings);
  });

  it('returns meetings unchanged when input is empty', async () => {
    const result = await attachPrepPathsFromDisk([], spaceRoot);
    expect(result).toEqual([]);
  });

  it('attaches prepPath by meetingId when a matching prep doc exists on disk', async () => {
    await writePrepDoc(spaceRoot, '2026/04-Apr/20', '260420_1000_meeting_sync-prep.md', {
      type: 'meeting-prep',
      title: 'Team Sync',
      meetingStartTime: '2026-04-20T10:00:00.000Z',
      meetingId: 'google:abc_team-sync',
    });

    const meetings = [
      makeMeeting({
        id: 'google:abc_team-sync',
        startTime: '2026-04-20T10:00:00.000Z',
      }),
    ];

    const result = await attachPrepPathsFromDisk(meetings, spaceRoot);
    expect(result[0].prepPath).toBe('memory/sources/2026/04-Apr/20/260420_1000_meeting_sync-prep.md');
  });

  it('falls back to startTime when meetingId is missing from frontmatter (legacy docs)', async () => {
    await writePrepDoc(spaceRoot, '2026/04-Apr/20', '260420_1000_meeting_legacy-prep.md', {
      type: 'meeting-prep',
      title: 'Legacy Meeting',
      meetingStartTime: '2026-04-20T10:00:00.000Z',
    });

    const meetings = [
      makeMeeting({
        id: 'google:legacy-id',
        startTime: '2026-04-20T10:00:00.000Z',
      }),
    ];

    const result = await attachPrepPathsFromDisk(meetings, spaceRoot);
    expect(result[0].prepPath).toBe('memory/sources/2026/04-Apr/20/260420_1000_meeting_legacy-prep.md');
  });

  it('preserves existing prepPath (including skip sentinels) over disk-scanned values', async () => {
    await writePrepDoc(spaceRoot, '2026/04-Apr/20', '260420_1000_meeting_sync-prep.md', {
      type: 'meeting-prep',
      title: 'Team Sync',
      meetingStartTime: '2026-04-20T10:00:00.000Z',
      meetingId: 'google:abc_team-sync',
    });

    const meetings = [
      makeMeeting({
        id: 'google:abc_team-sync',
        startTime: '2026-04-20T10:00:00.000Z',
        prepPath: '__skipped__',
      }),
      makeMeeting({
        id: 'google:other',
        startTime: '2026-04-20T11:00:00.000Z',
        prepPath: 'memory/sources/already/linked.md',
      }),
    ];

    const result = await attachPrepPathsFromDisk(meetings, spaceRoot);
    expect(result[0].prepPath).toBe('__skipped__');
    expect(result[1].prepPath).toBe('memory/sources/already/linked.md');
  });

  it('leaves meetings untouched when no matching prep doc exists', async () => {
    await writePrepDoc(spaceRoot, '2026/04-Apr/20', '260420_1000_meeting_other-prep.md', {
      type: 'meeting-prep',
      title: 'Other',
      meetingStartTime: '2026-04-20T10:00:00.000Z',
      meetingId: 'google:other-id',
    });

    const meetings = [
      makeMeeting({
        id: 'google:no-match',
        startTime: '2026-04-22T10:00:00.000Z',
      }),
    ];

    const result = await attachPrepPathsFromDisk(meetings, spaceRoot);
    expect(result[0].prepPath).toBeUndefined();
  });

  it('returns meetings unchanged when CoS space resolution fails', async () => {
    vi.mocked(scanSpaces).mockRejectedValue(new Error('scan failed'));
    const meetings = [makeMeeting({ id: 'a' })];
    // Even when scanSpaces throws, we should fall back to coreDirectory and not throw.
    const result = await attachPrepPathsFromDisk(meetings, spaceRoot);
    expect(result).toEqual(meetings);
  });
});
