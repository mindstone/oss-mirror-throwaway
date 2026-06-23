import { describe, expect, it } from 'vitest';
import type { MemoryHistoryEntry } from '@shared/types';
import { memoryHistoryToCardEntries } from './memoryHistoryToCardEntries';

const MEMORY_HISTORY_FIXTURE: MemoryHistoryEntry[] = [
  {
    id: 'm-1',
    timestamp: 1716500000000,
    sessionId: 'session-1',
    turnId: 'turn-1',
    entity: 'Chief-of-Staff',
    visibility: 'private',
    action: 'created',
    summary: 'Remember to prep Monday planning notes before lunch.',
    filePath: 'Chief-of-Staff/memory/planning.md',
    sessionTitle: 'Weekly planning',
  },
  {
    id: 'm-2',
    timestamp: 1716501000000,
    sessionId: 'session-2',
    turnId: 'turn-2',
    entity: 'Mindstone',
    visibility: 'shared',
    action: 'updated',
    summary: 'Absolute path memory entry',
    filePath: '/workspace/work/Mindstone/memory/team.md',
  },
];

describe('memoryHistoryToCardEntries', () => {
  it('maps memory history entries to typed card entries', () => {
    const entries = memoryHistoryToCardEntries(MEMORY_HISTORY_FIXTURE, [], '/workspace');
    expect(entries).toHaveLength(2);

    expect(entries[0]).toMatchObject({
      id: 'm-1',
      kind: 'memory',
      name: 'planning.md',
      relativePath: 'Chief-of-Staff/memory/planning.md',
      path: '/workspace/Chief-of-Staff/memory/planning.md',
      sourceSessionId: 'session-1',
      sourceTurnId: 'turn-1',
      sourceSessionTitle: 'Weekly planning',
      createdAt: 1716500000000,
      entity: 'Chief-of-Staff',
      visibility: 'private',
    });
    expect(entries[0]?.tags).toEqual(['Chief-of-Staff', 'private']);

    expect(entries[1]).toMatchObject({
      id: 'm-2',
      path: '/workspace/work/Mindstone/memory/team.md',
      visibility: 'shared',
    });
  });

  it('returns empty array for empty input', () => {
    expect(memoryHistoryToCardEntries([], [], '/workspace')).toEqual([]);
    expect(memoryHistoryToCardEntries(null, [], '/workspace')).toEqual([]);
  });

  it('uses optional precomputed tags when provided', () => {
    const entriesWithTags = [
      {
        ...MEMORY_HISTORY_FIXTURE[0],
        tags: ['alpha', 'beta', 'gamma'],
      } as MemoryHistoryEntry,
    ];

    const entries = memoryHistoryToCardEntries(entriesWithTags, [], '/workspace');

    expect(entries[0]?.tags).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('filters out non-memory assets (source captures, skill files) while keeping curated memory files', () => {
    const mixedFixture: MemoryHistoryEntry[] = [
      {
        id: 'source-1',
        timestamp: 1716502000000,
        sessionId: 'session-3',
        turnId: 'turn-3',
        entity: 'Chief-of-Staff',
        visibility: 'private',
        action: 'created',
        summary: 'Captured source transcript',
        filePath: 'Chief-of-Staff/memory/sources/2026/05-May/22/capture.md',
      },
      {
        id: 'source-2',
        timestamp: 1716503000000,
        sessionId: 'session-4',
        turnId: 'turn-4',
        entity: 'Chief-of-Staff',
        visibility: 'private',
        action: 'updated',
        summary: 'Windows path source capture',
        filePath: 'Chief-of-Staff\\Memory\\Sources\\2026\\05-May\\22\\capture-2.md',
      },
      {
        id: 'skill-1',
        timestamp: 1716503500000,
        sessionId: 'session-skill',
        turnId: 'turn-skill',
        entity: 'Chief-of-Staff',
        visibility: 'private',
        action: 'created',
        summary: 'Trade-off finder skill — should NOT appear in memory',
        filePath: 'chief-of-staff/skills/use-case-finder/trade-off-finder/SKILL.md',
      },
      {
        id: 'skill-2',
        timestamp: 1716503600000,
        sessionId: 'session-skill-2',
        turnId: 'turn-skill-2',
        entity: 'Mindstone',
        visibility: 'shared',
        action: 'updated',
        summary: 'Shared skill — should NOT appear in memory',
        filePath: 'Mindstone\\Skills\\writing\\brief\\SKILL.md',
      },
      {
        id: 'memory-1',
        timestamp: 1716504000000,
        sessionId: 'session-5',
        turnId: 'turn-5',
        entity: 'Chief-of-Staff',
        visibility: 'private',
        action: 'created',
        summary: 'Curated person memory',
        filePath: 'Chief-of-Staff/memory/people/alex.md',
      },
      {
        id: 'memory-2',
        timestamp: 1716505000000,
        sessionId: 'session-6',
        turnId: 'turn-6',
        entity: 'Mindstone',
        visibility: 'shared',
        action: 'updated',
        summary: 'Curated project memory',
        filePath: 'Mindstone/memory/projects/rebel.md',
      },
    ];

    const entries = memoryHistoryToCardEntries(mixedFixture, [], '/workspace');
    expect(entries.map((entry) => entry.id)).toEqual(['memory-1', 'memory-2']);
  });

  it('degrades gracefully for legacy malformed entries with missing entity or summary', () => {
    const malformedFixture = [
      {
        id: 'missing-entity',
        timestamp: 1716506000000,
        sessionId: 'session-7',
        turnId: 'turn-7',
        visibility: 'private',
        action: 'created',
        summary: 'Entity was absent in legacy persisted data.',
        filePath: 'memory/missing-entity.md',
      },
      {
        id: 'blank-entity',
        timestamp: 1716507000000,
        sessionId: 'session-8',
        turnId: 'turn-8',
        entity: '',
        visibility: 'shared',
        action: 'updated',
        summary: 'Entity was blank in legacy persisted data.',
        filePath: 'memory/blank-entity.md',
      },
      {
        id: 'missing-summary',
        timestamp: 1716508000000,
        sessionId: 'session-9',
        turnId: 'turn-9',
        entity: 'Mindstone',
        visibility: 'private',
        action: 'created',
        filePath: 'memory/missing-summary.md',
      },
    ] as unknown as MemoryHistoryEntry[];

    expect(() => memoryHistoryToCardEntries(malformedFixture, [], '/workspace')).not.toThrow();

    const entries = memoryHistoryToCardEntries(malformedFixture, [], '/workspace');
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.entity)).toEqual(['Memory', 'Memory', 'Mindstone']);
    expect(entries.map((entry) => entry.snippet)).toEqual([
      'Entity was absent in legacy persisted data.',
      'Entity was blank in legacy persisted data.',
      'Memory entry',
    ]);
    expect(entries[0]?.tags).toEqual(['Memory', 'private']);
    expect(entries[1]?.tags).toEqual(['Memory', 'shared']);
  });
});
