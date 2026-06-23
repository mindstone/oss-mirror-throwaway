import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findTranscriptByStableId } from '../transcriptStorage';

describe('findTranscriptByStableId provider matcher', () => {
  it('matches legacy source_system: local when provider is desktop_sdk', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-source-dedup-'));
    const transcriptDir = path.join(tmpRoot, 'memory', 'sources', '2026', '05-May', '19');
    const transcriptPath = path.join(
      transcriptDir,
      '260519_1200_meeting_desktop_sdk_fixture.md',
    );

    await fs.mkdir(transcriptDir, { recursive: true });
    await fs.writeFile(
      transcriptPath,
      [
        '---',
        'source_type: meeting',
        'source_system: local',
        'source_uid: desktop-session-legacy',
        '---',
        '',
        '# Legacy Desktop Transcript',
      ].join('\n'),
      'utf-8',
    );

    try {
      const found = await findTranscriptByStableId(
        tmpRoot,
        'desktop-session-legacy',
        'desktop_sdk',
        new Date('2026-05-19T12:00:00.000Z'),
      );

      expect(found).toBe(transcriptPath);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('skips stray month-level files and still finds transcript in day folder', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-source-dedup-nondir-'));
    const monthFolder = path.join(tmpRoot, 'memory', 'sources', '2025', '12-Dec');
    const dayFolder = path.join(monthFolder, '24');
    const transcriptPath = path.join(dayFolder, '251224_1700_meeting_recall_follow-up.md');

    await fs.mkdir(dayFolder, { recursive: true });
    // Simulate a normal markdown source file accidentally placed at month level.
    await fs.writeFile(path.join(monthFolder, '00-stray-month-entry.md'), '# stray month file', 'utf-8');
    await fs.writeFile(
      transcriptPath,
      [
        '---',
        'source_type: meeting',
        'source_system: recall',
        'source_uid: recall-bot-123',
        '---',
        '',
        '# Transcript',
      ].join('\n'),
      'utf-8',
    );

    try {
      const found = await findTranscriptByStableId(tmpRoot, 'recall-bot-123', 'recall');
      expect(found).toBe(transcriptPath);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
