// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileNode } from '@shared/types';
import { flattenFileTree } from '@renderer/utils/librarySearch';
import * as librarySearchModule from '@renderer/utils/librarySearch';
import * as railSearchModule from '../useLibraryRailSearch';
import { invalidateLibrarySearchCache } from '@renderer/features/library/search/engine';
import { deriveTruncationSignal } from '@renderer/features/library/search/useTruncationSignal';
import type { SkillsScanResult } from '../useSkillsIndex';
import { useLibraryRailSearch } from '../useLibraryRailSearch';

const { recordRendererBreadcrumbMock } = vi.hoisted(() => ({
  recordRendererBreadcrumbMock: vi.fn(),
}));

vi.mock('@renderer/src/sentry', () => ({
  recordRendererBreadcrumb: (breadcrumb: unknown) => recordRendererBreadcrumbMock(breadcrumb),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type RailHookProps = Parameters<typeof useLibraryRailSearch>[0];
type RailHookValue = ReturnType<typeof useLibraryRailSearch>;

type MountedHook = {
  rerender: (nextProps: RailHookProps) => void;
  unmount: () => void;
};

let latest: RailHookValue;

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

const createDefaultProps = (overrides: Partial<RailHookProps> = {}): RailHookProps => ({
  nodes: [],
  expandedDirectories: {},
  libraryRootAbsolute: '/workspace',
  skillsData: null,
  ...overrides,
});

const flushRailDebounce = (ms = 130): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

function Probe(props: RailHookProps) {
  latest = useLibraryRailSearch(props);
  return null;
}

function mountHook(initialProps: RailHookProps): MountedHook {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(React.createElement(Probe, initialProps));
  });

  return {
    rerender: (nextProps) => {
      act(() => {
        root.render(React.createElement(Probe, nextProps));
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function collectTreePaths(nodes: FileNode[] | null | undefined): string[] {
  const paths: string[] = [];
  const visit = (nodeList: FileNode[] | undefined) => {
    if (!nodeList || nodeList.length === 0) return;
    for (const node of nodeList) {
      paths.push(node.path);
      if (node.kind === 'directory') {
        visit(node.children);
      }
    }
  };
  visit(nodes ?? undefined);
  return paths;
}

function createSingleFileChain(segments: string[], fileName: string): FileNode[] {
  const filePath = `/workspace/${segments.join('/')}/${fileName}`;
  let node: FileNode = makeFileNode(fileName, filePath);

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const directoryPath = `/workspace/${segments.slice(0, index + 1).join('/')}`;
    node = makeDirectoryNode(segments[index], directoryPath, [node]);
  }

  return [node];
}

function createBulkEntryTree(totalEntries: number, prefix = 'entry'): FileNode[] {
  const fileCount = Math.max(totalEntries - 1, 0);
  const children = new Array<FileNode>(fileCount);

  for (let index = 0; index < fileCount; index += 1) {
    const suffix = index.toString().padStart(6, '0');
    const name = `${prefix}-${suffix}.md`;
    children[index] = makeFileNode(name, `/workspace/bulk/${name}`);
  }

  return [makeDirectoryNode('bulk', '/workspace/bulk', children)];
}

function createRailCapRegressionFixture(): FileNode[] {
  const unrelatedFiles = new Array<FileNode>(7_494);
  for (let index = 0; index < unrelatedFiles.length; index += 1) {
    const name = `unrelated-${index.toString().padStart(4, '0')}.md`;
    unrelatedFiles[index] = makeFileNode(name, `/workspace/Workspace/bulk/${name}`);
  }

  const chatgptFile = makeFileNode(
    'chatgpt.png',
    '/workspace/Workspace/projects/research/assets/chatgpt.png',
  );

  return [
    makeDirectoryNode('Workspace', '/workspace/Workspace', [
      makeDirectoryNode('projects', '/workspace/Workspace/projects', [
        makeDirectoryNode('research', '/workspace/Workspace/projects/research', [
          makeDirectoryNode('assets', '/workspace/Workspace/projects/research/assets', [
            chatgptFile,
          ]),
        ]),
      ]),
      makeDirectoryNode('bulk', '/workspace/Workspace/bulk', unrelatedFiles),
    ]),
  ];
}

function createSkillDescriptionFixture(): { nodes: FileNode[]; skillsData: SkillsScanResult } {
  return {
    nodes: [
      makeDirectoryNode('skills', '/workspace/skills', [
        makeDirectoryNode('web-capture', '/workspace/skills/web-capture', [
          makeFileNode('SKILL.md', '/workspace/skills/web-capture/SKILL.md'),
        ]),
      ]),
    ],
    skillsData: {
      totalCount: 1,
      groups: [
        {
          source: 'workspace',
          label: 'Workspace',
          type: 'workspace',
          count: 1,
          categories: {
            capture: [
              {
                name: 'web-capture',
                relativePath: 'skills/web-capture/SKILL.md',
                absolutePath: '/workspace/skills/web-capture/SKILL.md',
                category: 'capture',
                hasFrontmatter: true,
                frontmatter: {
                  description: 'capture sources from the web',
                },
              },
            ],
          },
        },
      ],
    },
  };
}

describe('useLibraryRailSearch', () => {
  let mounted: MountedHook | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    invalidateLibrarySearchCache();
    recordRendererBreadcrumbMock.mockReset();
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    invalidateLibrarySearchCache();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('finds chatgpt.png in the deterministic 7,500-entry regression fixture', () => {
    const nodes = createRailCapRegressionFixture();
    const flattenedEntries = flattenFileTree(nodes);
    expect(flattenedEntries).toHaveLength(7_500);
    const chatgptTraversalIndex = flattenedEntries.findIndex(
      (entry) => entry.node.path === '/workspace/Workspace/projects/research/assets/chatgpt.png',
    );
    expect(chatgptTraversalIndex).toBeGreaterThan(5_000);

    mounted = mountHook(createDefaultProps({ nodes }));

    act(() => {
      latest.setQuery('chatgpt');
    });
    flushRailDebounce();

    const chatgptResult = latest.matches.find((match) => match.node.path.endsWith('/chatgpt.png'));
    expect(chatgptResult).toBeDefined();
    expect(chatgptResult?.parentRelativePath).toBe('Workspace/projects/research/assets');
    expect(chatgptResult?.matches.length ?? 0).toBeGreaterThan(0);
  });

  it('matches deep chatgpt.png paths for non-slash queries (Fuse distance edge case)', () => {
    const segments = [
      'deeply',
      'nested',
      'workspace',
      'example',
      'alpha',
      'beta',
      'gamma',
      'delta',
      'epsilon',
      'zeta',
      'eta',
      'theta',
      'iota',
      'kappa',
    ];
    const nodes = createSingleFileChain(segments, 'chatgpt.png');
    const [entry] = flattenFileTree(nodes).filter((candidate) => candidate.node.path.endsWith('/chatgpt.png'));
    expect((entry?.fullPath.length ?? 0)).toBeGreaterThanOrEqual(60);

    mounted = mountHook(createDefaultProps({ nodes }));

    act(() => {
      latest.setQuery('chatgpt');
    });
    flushRailDebounce();

    expect(latest.matches.some((match) => match.node.path.endsWith('/chatgpt.png'))).toBe(true);
  });

  it('matches path-fragment queries like assets/chatgpt via slash-triggered path matching', () => {
    const nodes = createRailCapRegressionFixture();
    mounted = mountHook(createDefaultProps({ nodes }));

    act(() => {
      latest.setQuery('assets/chatgpt');
    });
    flushRailDebounce();

    expect(latest.matches.map((match) => match.node.path)).toContain(
      '/workspace/Workspace/projects/research/assets/chatgpt.png',
    );
  });

  it('matches skill folders by skillMeta.description in rail search', () => {
    const { nodes, skillsData } = createSkillDescriptionFixture();

    mounted = mountHook(createDefaultProps({ nodes, skillsData }));

    act(() => {
      latest.setQuery('source');
    });
    flushRailDebounce();

    expect(latest.hasMatches).toBe(false);
    expect(latest.matches).toEqual([]);
    expect(collectTreePaths(latest.filteredNodes)).toContain('/workspace/skills/web-capture');
  });

  it('returns hasMatches=false with empty matches when only a skill folder description matches', () => {
    const { nodes, skillsData } = createSkillDescriptionFixture();
    mounted = mountHook(createDefaultProps({ nodes, skillsData }));

    act(() => {
      latest.setQuery('source');
    });
    flushRailDebounce();

    expect(latest.hasMatches).toBe(false);
    expect(latest.matches).toEqual([]);
  });

  it('plumbs engine-cap truncation state through the rail hook', () => {
    const nodes = createBulkEntryTree(100_001, 'entry');
    mounted = mountHook(createDefaultProps({ nodes }));

    act(() => {
      latest.setQuery('entry');
    });
    flushRailDebounce();

    expect(latest.truncated).toBe(true);
    expect(latest.truncationReason).toBe('engine-cap');
    expect(recordRendererBreadcrumbMock).toHaveBeenCalledWith(expect.objectContaining({
      message: 'library_search.engine_cap_fired',
      data: expect.objectContaining({
        surface: 'rail',
      }),
    }));
  });

  it('keeps truncation signal stable across debounced typing bursts over a 200k index', () => {
    const nodes = createBulkEntryTree(200_000, 'entry');
    mounted = mountHook(createDefaultProps({ nodes }));

    const kinds: string[] = [];
    for (const query of ['c', 'ch', 'cha', 'chat', 'chatg']) {
      act(() => {
        latest.setQuery(query);
      });
      flushRailDebounce();
      kinds.push(
        deriveTruncationSignal(latest.searchOutcome, false).kind,
      );
    }

    expect(kinds).toEqual(['engine-cap', 'engine-cap', 'engine-cap', 'engine-cap', 'engine-cap']);
  });

  it('reuses the Fuse cache across c → ch → cha bursts on a 200k source index', () => {
    const createFuseSpy = vi.spyOn(librarySearchModule, 'createLibrarySearchFuse');
    const nodes = createBulkEntryTree(200_000, 'entry');
    mounted = mountHook(createDefaultProps({ nodes }));

    act(() => {
      latest.setQuery('c');
    });
    flushRailDebounce();

    act(() => {
      latest.setQuery('ch');
    });
    flushRailDebounce();

    act(() => {
      latest.setQuery('cha');
    });
    flushRailDebounce();

    expect(createFuseSpy).toHaveBeenCalledTimes(1);
    createFuseSpy.mockRestore();
  }, 20_000);

  it('builds ancestor path map once across 10 sequential queries on a 1,000-node tree', () => {
    const buildAncestorPathMapSpy = vi.spyOn(railSearchModule.railSearchInternals, 'buildAncestorPathMap');
    const nodes = createBulkEntryTree(1_000, 'entry');
    mounted = mountHook(createDefaultProps({ nodes }));

    const queries = ['e', 'en', 'ent', 'entr', 'entry', 'entry-0', 'entry-00', 'entry-000', 'entry-0000', 'entry-00000'];
    for (const query of queries) {
      act(() => {
        latest.setQuery(query);
      });
      flushRailDebounce();
    }

    expect(buildAncestorPathMapSpy).toHaveBeenCalledTimes(1);
    buildAncestorPathMapSpy.mockRestore();
  });

  it('keeps effectiveExpandedDirectories aligned with matched-path ancestors', () => {
    const nodes = [
      ...createSingleFileChain(['projects', 'research', 'assets'], 'chatgpt.png'),
      makeDirectoryNode('pinned', '/workspace/pinned', [
        makeFileNode('keep.md', '/workspace/pinned/keep.md'),
      ]),
    ];
    mounted = mountHook(createDefaultProps({
      nodes,
      expandedDirectories: { '/workspace/pinned': true },
    }));

    act(() => {
      latest.setQuery('chatgpt');
    });
    flushRailDebounce();

    expect(latest.effectiveExpandedDirectories['/workspace/pinned']).toBe(true);
    expect(latest.effectiveExpandedDirectories['/workspace/projects']).toBe(true);
    expect(latest.effectiveExpandedDirectories['/workspace/projects/research']).toBe(true);
    expect(latest.effectiveExpandedDirectories['/workspace/projects/research/assets']).toBe(true);
  });

  it('respects the 120ms debounce window (no fire at 60ms, fire at 130ms)', () => {
    const nodes = createSingleFileChain(['projects', 'research'], 'chatgpt.png');
    mounted = mountHook(createDefaultProps({ nodes }));

    act(() => {
      latest.setQuery('chatgpt');
    });

    flushRailDebounce(60);
    expect(latest.debouncedQuery).toBe('');
    expect(latest.isSearchActive).toBe(false);
    expect(latest.matches).toHaveLength(0);

    flushRailDebounce(70);
    expect(latest.debouncedQuery).toBe('chatgpt');
    expect(latest.isSearchActive).toBe(true);
    expect(latest.matches.some((match) => match.node.path.endsWith('/chatgpt.png'))).toBe(true);
  });

  it('preserves empty-tree + empty-query defaults and hidden-file toggle behavior', () => {
    mounted = mountHook(createDefaultProps({ nodes: [] }));

    expect(latest.query).toBe('');
    expect(latest.debouncedQuery).toBe('');
    expect(latest.isSearchActive).toBe(false);
    expect(latest.matches).toEqual([]);
    expect(latest.filteredNodes).toBeNull();
    expect(latest.hasMatches).toBe(true);
    expect(latest.truncated).toBe(false);
    expect(latest.truncationReason).toBeNull();

    act(() => {
      latest.setQuery('secret');
    });
    flushRailDebounce();

    expect(latest.hasMatches).toBe(false);
    expect(latest.matches).toEqual([]);
    expect(latest.filteredNodes).toEqual([]);

    const hiddenFileNodes = createSingleFileChain(['hidden'], '.secret.md');
    mounted.rerender(createDefaultProps({ nodes: hiddenFileNodes }));
    expect(latest.matches.map((match) => match.node.path)).toContain('/workspace/hidden/.secret.md');
    expect(latest.hasMatches).toBe(true);

    mounted.rerender(createDefaultProps({ nodes: [] }));
    expect(latest.matches).toEqual([]);
    expect(latest.hasMatches).toBe(false);
  });

  it('guards malformed skillsData.groups and keeps rail search stable without metadata', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { nodes } = createSkillDescriptionFixture();
    const malformedSkillsData = { groups: 'not-an-array' } as unknown as SkillsScanResult;
    mounted = mountHook(createDefaultProps({ nodes, skillsData: malformedSkillsData }));

    expect(() => {
      act(() => {
        latest.setQuery('source');
      });
      flushRailDebounce();
    }).not.toThrow();

    expect(latest.hasMatches).toBe(false);
    expect(latest.matches).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      '[useLibraryRailSearch] Expected skillsData.groups to be an array; skipping skill metadata join.',
    );
    warnSpy.mockRestore();
  });
});
