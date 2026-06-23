// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileNode } from '@shared/types';
import type { FlatFileEntry } from '@renderer/utils/librarySearch';
import * as librarySearchModule from '@renderer/utils/librarySearch';
import { invalidateLibrarySearchCache } from '@renderer/features/library/search/engine';
import { useLibraryMentions } from '../useLibraryMentions';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HookOptions = Parameters<typeof useLibraryMentions>[0];
type HookValue = ReturnType<typeof useLibraryMentions>;

const readFileMock = vi.fn();

const makeFileNode = (name: string, path: string): FileNode => ({
  name,
  path,
  kind: 'file',
});

const makeDirectoryNode = (name: string, path: string, children: FileNode[]): FileNode => ({
  name,
  path,
  kind: 'directory',
  children,
});

const makeEntry = (
  node: FileNode,
  fullPath: string,
  skillMeta?: FlatFileEntry['skillMeta'],
): FlatFileEntry => ({
  node,
  fullPath,
  ...(skillMeta ? { skillMeta } : {}),
});

const createLargeMentionIndex = (count: number): FlatFileEntry[] => {
  const entries = new Array<FlatFileEntry>(count);
  for (let index = 0; index < count; index += 1) {
    const suffix = index.toString().padStart(6, '0');
    const name = `chat-${suffix}.md`;
    entries[index] = makeEntry(
      makeFileNode(name, `/workspace/library/${name}`),
      `library/${name}`,
    );
  }
  return entries;
};

describe('useLibraryMentions', () => {
  let root: Root;
  let container: HTMLDivElement;
  let latest: HookValue;
  let options: HookOptions;

  function Probe(props: HookOptions) {
    latest = useLibraryMentions(props);
    return null;
  }

  const mountHook = (overrides: Partial<HookOptions> = {}) => {
    const libraryIndex = overrides.libraryIndex ?? [];
    const libraryIndexRef = overrides.libraryIndexRef ?? { current: libraryIndex };

    options = {
      libraryIndex,
      libraryIndexRef,
      coreDirectory: '/workspace',
      textPrompt: '',
      libraryIndexLoaded: true,
      libraryIndexLoading: false,
      refreshLibraryIndex: vi.fn(async () => {}),
      showToast: vi.fn(),
      emitLog: vi.fn(),
      ...overrides,
    };

    act(() => {
      root.render(<Probe {...options} />);
    });
  };

  beforeEach(() => {
    invalidateLibrarySearchCache();
    readFileMock.mockReset();
    readFileMock.mockResolvedValue({ content: 'file contents' });

    Object.defineProperty(window, 'libraryApi', {
      configurable: true,
      value: {
        readFile: readFileMock,
      },
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    invalidateLibrarySearchCache();
    vi.clearAllMocks();
  });

  it('reads a fresh libraryIndexRef after refresh when preparing mention attachments', async () => {
    const staleIndex = [
      makeEntry(makeFileNode('stale.md', '/workspace/stale.md'), 'stale.md'),
    ];
    const freshIndex = [
      makeEntry(makeFileNode('fresh.md', '/workspace/fresh.md'), 'fresh.md'),
    ];
    const libraryIndexRef = { current: staleIndex } as React.MutableRefObject<FlatFileEntry[] | null>;
    const refreshLibraryIndex = vi.fn(async () => {
      libraryIndexRef.current = freshIndex;
    });

    mountHook({
      libraryIndex: staleIndex,
      libraryIndexRef,
      libraryIndexLoaded: false,
      refreshLibraryIndex,
    });

    let attachments: Awaited<ReturnType<HookValue['prepareMentionAttachments']>> = [];
    await act(async () => {
      attachments = await latest.prepareMentionAttachments('Please include @`fresh.md`.');
    });

    expect(refreshLibraryIndex).toHaveBeenCalledTimes(1);
    expect(readFileMock).toHaveBeenCalledWith('/workspace/fresh.md');
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.path).toBe('/workspace/fresh.md');
    expect(attachments[0]?.relativePath).toBe('fresh.md');
  });

  it('keeps short-query early-exit behavior and safely handles nullable name/fullPath fields', () => {
    const entries: FlatFileEntry[] = [
      {
        node: makeFileNode(undefined as unknown as string, '/workspace/nullable-name.md'),
        fullPath: undefined as unknown as string,
      },
      ...Array.from({ length: 20 }, (_, index) => {
        const name = index < 18 ? `q-file-${index}.md` : `other-${index}.md`;
        return makeEntry(
          makeFileNode(name, `/workspace/${name}`),
          name,
        );
      }),
    ];

    mountHook({ libraryIndex: entries });

    expect(() => latest.mentionResultsForQuery('')).not.toThrow();
    const emptyQueryResults = latest.mentionResultsForQuery('');
    expect(emptyQueryResults).toHaveLength(16);

    expect(() => latest.mentionResultsForQuery('q')).not.toThrow();
    const oneCharResults = latest.mentionResultsForQuery('q');
    expect(oneCharResults.length).toBeLessThanOrEqual(16);
    expect(oneCharResults.every((result) => {
      const name = (result.node.name ?? '').toLowerCase();
      const fullPath = (result.fullPath ?? '').toLowerCase();
      return name.startsWith('q') || fullPath.includes('q');
    })).toBe(true);
  });

  it('preserves tiered skill ranking and directory-before-file ordering', () => {
    const spaceSkillFolderPath = '/workspace/Chief-of-Staff/skills/chat-space-skill';
    const platformSkillFolderPath = '/workspace/rebel-system/skills/chat-platform-skill';
    const otherDirectoryPath = '/workspace/docs/chat-folder';
    const otherFilePath = '/workspace/docs/chat-file.md';
    const regularFilePath = '/workspace/docs/chat-regular.md';

    const spaceSkillFolder = makeDirectoryNode(
      'chat-space-skill',
      spaceSkillFolderPath,
      [makeFileNode('SKILL.md', `${spaceSkillFolderPath}/SKILL.md`)],
    );
    const platformSkillFolder = makeDirectoryNode(
      'chat-platform-skill',
      platformSkillFolderPath,
      [makeFileNode('SKILL.md', `${platformSkillFolderPath}/SKILL.md`)],
    );
    const otherDirectory = makeDirectoryNode('chat-folder', otherDirectoryPath, []);
    const otherFile = makeFileNode('chat-file.md', otherFilePath);
    const regularFile = makeFileNode('chat-regular.md', regularFilePath);

    mountHook({
      libraryIndex: [
        makeEntry(spaceSkillFolder, 'Chief-of-Staff/skills/chat-space-skill'),
        makeEntry(makeFileNode('SKILL.md', `${spaceSkillFolderPath}/SKILL.md`), 'Chief-of-Staff/skills/chat-space-skill/SKILL.md'),
        makeEntry(platformSkillFolder, 'rebel-system/skills/chat-platform-skill'),
        makeEntry(makeFileNode('SKILL.md', `${platformSkillFolderPath}/SKILL.md`), 'rebel-system/skills/chat-platform-skill/SKILL.md'),
        makeEntry(regularFile, 'docs/chat-regular.md'),
        makeEntry(otherDirectory, 'docs/chat-folder'),
        makeEntry(otherFile, 'docs/chat-file.md'),
      ],
    });

    const results = latest.mentionResultsForQuery('chat');
    const resultPaths = results.map((result) => result.node.path);

    const spaceSkillIndex = resultPaths.indexOf(spaceSkillFolderPath);
    const platformSkillIndex = resultPaths.indexOf(platformSkillFolderPath);
    const regularFileIndex = resultPaths.indexOf(regularFilePath);
    const otherDirectoryIndex = resultPaths.indexOf(otherDirectoryPath);
    const otherFileIndex = resultPaths.indexOf(otherFilePath);

    expect(spaceSkillIndex).toBeGreaterThanOrEqual(0);
    expect(platformSkillIndex).toBeGreaterThanOrEqual(0);
    expect(regularFileIndex).toBeGreaterThanOrEqual(0);
    expect(otherDirectoryIndex).toBeGreaterThanOrEqual(0);
    expect(otherFileIndex).toBeGreaterThanOrEqual(0);

    expect(spaceSkillIndex).toBeLessThan(platformSkillIndex);
    expect(spaceSkillIndex).toBeLessThan(regularFileIndex);
    expect(platformSkillIndex).toBeLessThan(regularFileIndex);
    expect(otherDirectoryIndex).toBeLessThan(otherFileIndex);
  });

  it('filters hidden SKILL.md files out of mention autocomplete results', () => {
    const skillFolderPath = '/workspace/skills/chat-helper';
    const skillMdPath = `${skillFolderPath}/SKILL.md`;

    mountHook({
      libraryIndex: [
        makeEntry(
          makeDirectoryNode('chat-helper', skillFolderPath, [makeFileNode('SKILL.md', skillMdPath)]),
          'skills/chat-helper',
        ),
        makeEntry(makeFileNode('SKILL.md', skillMdPath), 'skills/chat-helper/SKILL.md'),
        makeEntry(makeFileNode('chat-helper-notes.md', '/workspace/chat-helper-notes.md'), 'chat-helper-notes.md'),
      ],
    });

    const results = latest.mentionResultsForQuery('chat');
    const resultNames = results.map((result) => result.node.name);
    const resultPaths = results.map((result) => result.node.path);

    expect(resultNames).not.toContain('SKILL.md');
    expect(resultPaths).not.toContain(skillMdPath);
  });

  it('defensively skips malformed entries when building mention lookup', () => {
    const validPath = '/workspace/notes.md';
    const malformedPathEntry = makeEntry(
      makeFileNode('broken.md', undefined as unknown as string),
      'broken.md',
    );
    const validEntry = makeEntry(makeFileNode('notes.md', validPath), 'notes.md');

    mountHook({
      libraryIndex: [malformedPathEntry, validEntry],
    });

    expect(() => latest.canResolveLibraryReference('notes.md')).not.toThrow();
    expect(latest.canResolveLibraryReference('notes.md')).toBe(true);

    expect(() => latest.resolveMentionedFiles('Please check @`notes.md`')).not.toThrow();
    const resolved = latest.resolveMentionedFiles('Please check @`notes.md`');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.absolutePath).toBe(validPath);
  });

  it('reuses engine Fuse cache across c → ch → cha → chat typing on a 200k index', () => {
    const entries = createLargeMentionIndex(200_000);
    const createFuseSpy = vi.spyOn(librarySearchModule, 'createLibrarySearchFuse');

    mountHook({
      libraryIndex: entries,
    });

    latest.mentionResultsForQuery('c');
    latest.mentionResultsForQuery('ch');
    latest.mentionResultsForQuery('cha');
    latest.mentionResultsForQuery('chat');

    expect(createFuseSpy).toHaveBeenCalledTimes(1);
    createFuseSpy.mockRestore();
  });
});
