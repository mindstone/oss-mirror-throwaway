import { describe, it, expect, vi } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';

const stubLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const setupModule = async () => {
  vi.resetModules();
  await initTestPlatformConfig();
  vi.doMock('electron-store', () => {
    class MemoryStore<T extends Record<string, unknown>> {
      store: T;
      constructor(options: { defaults: T }) {
        this.store = structuredClone(options.defaults);
      }
      get(key: keyof T) {
        return this.store[key];
      }
      set(key: keyof T, value: T[keyof T]) {
        this.store[key] = value;
      }
    }
    return { default: MemoryStore };
  });
  vi.doMock('@core/logger', () => ({
    createScopedLogger: () => stubLogger,
  }));

  const store = await import('../entityMetadataStore');
  store.clearStore();
  store.initForWorkspace('/workspace');
  return store;
};

describe('entityMetadataStore', () => {
  it('indexes a person entity from markdown content', async () => {
    const store = await setupModule();
    const filePath = '/workspace/work/Acme/Exec/memory/topics/people/Sarah-Chen.md';
    const relativePath = 'work/Acme/Exec/memory/topics/people/Sarah-Chen.md';

    store.indexEntity(
      filePath,
      relativePath,
      `---
entity_type: person
canonical_name: Sarah Chen
emails:
  - [external-email]
company: Acme Corp
role: VP Engineering
aliases:
  - S. Chen
  - Sarah
---

# Sarah Chen
`,
      1700000000
    );

    const entry = store.getEntity(filePath);
    expect(entry).toBeDefined();
    expect(entry?.entityType).toBe('person');
    expect(entry?.canonicalName).toBe('Sarah Chen');
    expect(entry?.emails).toEqual(['[external-email]']);
    expect(entry?.company).toBe('Acme Corp');
    expect(entry?.role).toBe('VP Engineering');
    expect(entry?.aliases).toEqual(['S. Chen', 'Sarah']);
    expect(entry?.spacePath).toBe('work/Acme/Exec');
  });

  it('indexes a company entity from markdown content', async () => {
    const store = await setupModule();
    const filePath = '/workspace/work/Acme/General/memory/topics/companies/Acme-Corp.md';

    store.indexEntity(
      filePath,
      'work/Acme/General/memory/topics/companies/Acme-Corp.md',
      `---
entity_type: company
canonical_name: Acme Corp
domain: acme.com
aliases:
  - Acme
---

# Acme Corp
`,
      1700000001
    );

    const entry = store.getEntity(filePath);
    expect(entry).toBeDefined();
    expect(entry?.entityType).toBe('company');
    expect(entry?.canonicalName).toBe('Acme Corp');
    expect(entry?.emails).toEqual([]);
    expect(entry?.aliases).toEqual(['Acme']);
  });

  it('isEntityFile returns false for non-entity markdown', async () => {
    const store = await setupModule();
    const nonEntity = `---
title: Regular note
tags:
  - notes
---

No entity frontmatter here.
`;

    expect(store.isEntityFile(nonEntity)).toBe(false);
  });

  it('isEntityFile fast path returns false when entity_type is not in first 2KB', async () => {
    const store = await setupModule();
    const content = `${'A'.repeat(2100)}\nentity_type: person\ncanonical_name: Late Marker`;

    expect(store.isEntityFile(content)).toBe(false);
  });

  it('searchEntities supports filters by name, email, company, and entity type', async () => {
    const store = await setupModule();

    store.indexEntity(
      '/workspace/memory/topics/Sarah-Chen.md',
      'memory/topics/Sarah-Chen.md',
      `---
entity_type: person
canonical_name: Sarah Chen
emails:
  - [external-email]
company: Acme Corp
aliases:
  - S. Chen
---

# Sarah
`,
      1700000002
    );

    store.indexEntity(
      '/workspace/memory/topics/Bob-Jones.md',
      'memory/topics/Bob-Jones.md',
      `---
entity_type: person
canonical_name: Bob Jones
emails:
  - [external-email]
company: Beta Corp
---

# Bob
`,
      1700000003
    );

    store.indexEntity(
      '/workspace/memory/topics/Acme-Corp.md',
      'memory/topics/Acme-Corp.md',
      `---
entity_type: company
canonical_name: Acme Corp
aliases:
  - Acme
---

# Acme
`,
      1700000004
    );

    const byName = store.searchEntities({ name: 'sarah' });
    expect(byName.totalCount).toBe(1);
    expect(byName.entities[0].canonicalName).toBe('Sarah Chen');

    const byEmail = store.searchEntities({ email: 'sarah' });
    expect(byEmail.totalCount).toBe(1);
    expect(byEmail.entities[0].canonicalName).toBe('Sarah Chen');

    const byCompany = store.searchEntities({ company: 'acme' });
    expect(byCompany.entities.some((entry) => entry.canonicalName === 'Sarah Chen')).toBe(true);
    expect(byCompany.entities.some((entry) => entry.canonicalName === 'Acme Corp')).toBe(true);

    const byEntityType = store.searchEntities({ entityType: 'company' });
    expect(byEntityType.totalCount).toBe(1);
    expect(byEntityType.entities[0].canonicalName).toBe('Acme Corp');
  });

  it('resolveByEmail performs exact email lookup', async () => {
    const store = await setupModule();

    store.indexEntity(
      '/workspace/memory/topics/Sarah-Chen.md',
      'memory/topics/Sarah-Chen.md',
      `---
entity_type: person
canonical_name: Sarah Chen
emails:
  - [external-email]
---

# Sarah
`,
      1700000005
    );

    store.indexEntity(
      '/workspace/memory/topics/Sarah-Other.md',
      'memory/topics/Sarah-Other.md',
      `---
entity_type: person
canonical_name: Sarah Other
emails:
  - [external-email]
---

# Sarah Other
`,
      1700000006
    );

    const resolved = store.resolveByEmail('[external-email]');
    expect(resolved?.canonicalName).toBe('Sarah Chen');
    expect(store.resolveByEmail('[external-email]')).toBeUndefined();
  });

  it('resolveByName performs fuzzy matching against canonical name and aliases', async () => {
    const store = await setupModule();

    store.indexEntity(
      '/workspace/memory/topics/Sarah-Chen.md',
      'memory/topics/Sarah-Chen.md',
      `---
entity_type: person
canonical_name: Sarah Chen
emails:
  - [external-email]
aliases:
  - S. Chen
---

# Sarah
`,
      1700000007
    );

    expect(store.resolveByName('sarah')?.canonicalName).toBe('Sarah Chen');
    expect(store.resolveByName('S. Chen')?.canonicalName).toBe('Sarah Chen');
    expect(store.resolveByName('unknown')).toBeUndefined();
  });

  it('removeEntity removes entry from the index', async () => {
    const store = await setupModule();
    const filePath = '/workspace/memory/topics/Sarah-Chen.md';

    store.indexEntity(
      filePath,
      'memory/topics/Sarah-Chen.md',
      `---
entity_type: person
canonical_name: Sarah Chen
emails:
  - [external-email]
---

# Sarah
`,
      1700000008
    );

    expect(store.getEntityCount()).toBe(1);
    store.removeEntity(filePath);
    expect(store.getEntityCount()).toBe(0);
    expect(store.getEntity(filePath)).toBeUndefined();
  });

  it('skips malformed frontmatter via zod validation without crashing', async () => {
    const store = await setupModule();

    expect(() => {
      store.indexEntity(
        '/workspace/memory/topics/Invalid.md',
        'memory/topics/Invalid.md',
        `---
entity_type: unknown_type
canonical_name: Test
---

# Invalid
`,
        1700000009
      );
    }).not.toThrow();

    expect(store.getEntityCount()).toBe(0);
  });

  it('indexes a person entity without emails', async () => {
    const store = await setupModule();
    const filePath = '/workspace/memory/topics/people/John-Doe.md';

    store.indexEntity(
      filePath,
      'memory/topics/people/John-Doe.md',
      `---
entity_type: person
canonical_name: John Doe
company: Acme Corp
---

# John Doe
Met at conference, will follow up.
`,
      1700000010
    );

    const entry = store.getEntity(filePath);
    expect(entry).toBeDefined();
    expect(entry?.entityType).toBe('person');
    expect(entry?.canonicalName).toBe('John Doe');
    expect(entry?.emails).toEqual([]);
    expect(entry?.company).toBe('Acme Corp');
  });

  it('stores domain field for company entities', async () => {
    const store = await setupModule();
    const filePath = '/workspace/memory/topics/companies/Acme.md';

    store.indexEntity(
      filePath,
      'memory/topics/companies/Acme.md',
      `---
entity_type: company
canonical_name: Acme Corp
domain: acme.com
aliases:
  - Acme
---

# Acme Corp
`,
      1700000011
    );

    const entry = store.getEntity(filePath);
    expect(entry).toBeDefined();
    expect(entry?.domain).toBe('acme.com');
  });

  it('removeEntity on non-existent path does not throw', async () => {
    const store = await setupModule();
    expect(() => store.removeEntity('/nonexistent/path.md')).not.toThrow();
    expect(store.getEntityCount()).toBe(0);
  });

  it('needsReindexing returns true for new or stale files', async () => {
    const store = await setupModule();
    const filePath = '/workspace/memory/topics/people/Test.md';

    expect(store.needsReindexing(filePath, 1700000000)).toBe(true);

    store.indexEntity(
      filePath,
      'memory/topics/people/Test.md',
      `---
entity_type: person
canonical_name: Test Person
---

# Test
`,
      1700000000
    );

    expect(store.needsReindexing(filePath, 1700000000)).toBe(false);
    expect(store.needsReindexing(filePath, 1700000001)).toBe(true);
  });
});

// =============================================================================
// deriveLastInteraction & noInteractionSince tests
// =============================================================================

const setupModuleWithMeetings = async (meetingEntries: Array<{
  id: string;
  startTime: string;
  participantEmails?: string[];
}>) => {
  vi.resetModules();
  await initTestPlatformConfig();
  vi.doMock('electron-store', () => {
    class MemoryStore<T extends Record<string, unknown>> {
      store: T;
      constructor(options: { defaults: T }) {
        this.store = structuredClone(options.defaults);
      }
      get(key: keyof T) {
        return this.store[key];
      }
      set(key: keyof T, value: T[keyof T]) {
        this.store[key] = value;
      }
    }
    return { default: MemoryStore };
  });
  vi.doMock('@core/logger', () => ({
    createScopedLogger: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }));

  const fullEntries = meetingEntries.map((e) => ({
    calendarEventId: e.id,
    calendarSource: 'google',
    title: `Meeting ${e.id}`,
    endTime: e.startTime,
    participants: [],
    participantEmails: e.participantEmails,
    transcriptStatus: 'captured' as const,
    botScheduled: false,
    createdAt: e.startTime,
    updatedAt: e.startTime,
    ...e,
  }));

  vi.doMock('../meetingHistoryStore', () => ({
    getAllMeetingEntries: () => fullEntries,
  }));

  const store = await import('../entityMetadataStore');
  store.clearStore();
  store.initForWorkspace('/workspace');
  return store;
};

describe('deriveLastInteraction', () => {
  it('returns correct date when meeting exists with participantEmails', async () => {
    const store = await setupModuleWithMeetings([
      { id: 'm1', startTime: '2026-03-01T10:00:00Z', participantEmails: ['[external-email]', '[external-email]'] },
      { id: 'm2', startTime: '2026-03-05T14:00:00Z', participantEmails: ['[external-email]'] },
      { id: 'm3', startTime: '2026-03-03T09:00:00Z', participantEmails: ['[external-email]'] },
    ]);

    expect(store.deriveLastInteraction('[external-email]')).toBe('2026-03-05T14:00:00Z');
    expect(store.deriveLastInteraction('[external-email]')).toBe('2026-03-03T09:00:00Z');
  });

  it('returns undefined when no meeting contains the email', async () => {
    const store = await setupModuleWithMeetings([
      { id: 'm1', startTime: '2026-03-01T10:00:00Z', participantEmails: ['[external-email]'] },
    ]);

    expect(store.deriveLastInteraction('unknown@example.com')).toBeUndefined();
  });

  it('returns undefined when meeting entries have no participantEmails', async () => {
    const store = await setupModuleWithMeetings([
      { id: 'm1', startTime: '2026-03-01T10:00:00Z' },
      { id: 'm2', startTime: '2026-03-05T14:00:00Z', participantEmails: [] },
    ]);

    expect(store.deriveLastInteraction('[external-email]')).toBeUndefined();
  });

  it('returns undefined for empty email', async () => {
    const store = await setupModuleWithMeetings([
      { id: 'm1', startTime: '2026-03-01T10:00:00Z', participantEmails: ['[external-email]'] },
    ]);

    expect(store.deriveLastInteraction('')).toBeUndefined();
    expect(store.deriveLastInteraction('  ')).toBeUndefined();
  });

  it('performs case-insensitive email matching', async () => {
    const store = await setupModuleWithMeetings([
      { id: 'm1', startTime: '2026-03-01T10:00:00Z', participantEmails: ['[external-email]'] },
    ]);

    expect(store.deriveLastInteraction('[external-email]')).toBe('2026-03-01T10:00:00Z');
  });
});

describe('noInteractionSince filter', () => {
  it('filters entities whose last interaction is before the cutoff date', async () => {
    const store = await setupModuleWithMeetings([
      { id: 'm1', startTime: '2026-02-01T10:00:00Z', participantEmails: ['[external-email]'] },
      { id: 'm2', startTime: '2026-03-05T14:00:00Z', participantEmails: ['[external-email]'] },
    ]);

    store.indexEntity(
      '/workspace/memory/topics/Sarah.md',
      'memory/topics/Sarah.md',
      `---
entity_type: person
canonical_name: Sarah Chen
emails:
  - [external-email]
company: Acme Corp
---
# Sarah
`,
      1700000000
    );

    store.indexEntity(
      '/workspace/memory/topics/Bob.md',
      'memory/topics/Bob.md',
      `---
entity_type: person
canonical_name: Bob Jones
emails:
  - [external-email]
company: Beta Corp
---
# Bob
`,
      1700000001
    );

    // Cutoff: March 1 — Sarah's last meeting was Feb 1 (before cutoff), Bob's was March 5 (after cutoff)
    const result = store.searchEntities({ noInteractionSince: '2026-03-01T00:00:00Z' });
    expect(result.totalCount).toBe(1);
    expect(result.entities[0].canonicalName).toBe('Sarah Chen');
  });

  it('includes person entities with no emails (no meeting match possible)', async () => {
    const store = await setupModuleWithMeetings([
      { id: 'm1', startTime: '2026-03-05T14:00:00Z', participantEmails: ['[external-email]'] },
    ]);

    store.indexEntity(
      '/workspace/memory/topics/NoEmail.md',
      'memory/topics/NoEmail.md',
      `---
entity_type: person
canonical_name: Jane No Email
company: Unknown Corp
---
# Jane
`,
      1700000002
    );

    const result = store.searchEntities({ noInteractionSince: '2026-03-01T00:00:00Z' });
    expect(result.totalCount).toBe(1);
    expect(result.entities[0].canonicalName).toBe('Jane No Email');
  });

  it('includes person entities not found in any meeting', async () => {
    const store = await setupModuleWithMeetings([
      { id: 'm1', startTime: '2026-03-05T14:00:00Z', participantEmails: ['[external-email]'] },
    ]);

    store.indexEntity(
      '/workspace/memory/topics/Sarah.md',
      'memory/topics/Sarah.md',
      `---
entity_type: person
canonical_name: Sarah Chen
emails:
  - [external-email]
---
# Sarah
`,
      1700000003
    );

    // Sarah has an email but no meetings — include her
    const result = store.searchEntities({ noInteractionSince: '2026-03-01T00:00:00Z' });
    expect(result.totalCount).toBe(1);
    expect(result.entities[0].canonicalName).toBe('Sarah Chen');
  });

  it('excludes company entities from noInteractionSince filter', async () => {
    const store = await setupModuleWithMeetings([]);

    store.indexEntity(
      '/workspace/memory/topics/Acme.md',
      'memory/topics/Acme.md',
      `---
entity_type: company
canonical_name: Acme Corp
---
# Acme
`,
      1700000004
    );

    store.indexEntity(
      '/workspace/memory/topics/Sarah.md',
      'memory/topics/Sarah.md',
      `---
entity_type: person
canonical_name: Sarah Chen
emails:
  - [external-email]
---
# Sarah
`,
      1700000005
    );

    // noInteractionSince only returns person entities
    const result = store.searchEntities({ noInteractionSince: '2026-03-01T00:00:00Z' });
    expect(result.entities.every((e) => e.entityType === 'person')).toBe(true);
    expect(result.totalCount).toBe(1);
    expect(result.entities[0].canonicalName).toBe('Sarah Chen');
  });

  it('combines noInteractionSince with other filters', async () => {
    const store = await setupModuleWithMeetings([
      { id: 'm1', startTime: '2026-02-01T10:00:00Z', participantEmails: ['[external-email]'] },
      { id: 'm2', startTime: '2026-02-01T10:00:00Z', participantEmails: ['[external-email]'] },
    ]);

    store.indexEntity(
      '/workspace/memory/topics/Sarah.md',
      'memory/topics/Sarah.md',
      `---
entity_type: person
canonical_name: Sarah Chen
emails:
  - [external-email]
company: Acme Corp
---
# Sarah
`,
      1700000006
    );

    store.indexEntity(
      '/workspace/memory/topics/Alice.md',
      'memory/topics/Alice.md',
      `---
entity_type: person
canonical_name: Alice Wonder
emails:
  - [external-email]
company: Other Corp
---
# Alice
`,
      1700000007
    );

    // Both have old interactions, but filter by company=Acme narrows to Sarah only
    const result = store.searchEntities({
      noInteractionSince: '2026-03-01T00:00:00Z',
      company: 'Acme',
    });
    expect(result.totalCount).toBe(1);
    expect(result.entities[0].canonicalName).toBe('Sarah Chen');
  });
});
