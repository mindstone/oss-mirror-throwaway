// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, flushAsync, renderHook } from '@renderer/test-utils/hookTestHarness';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import type { OperatorMetadata } from '@shared/ipc/channels/operators';
import {
  clearOperatorRegistryListCacheForTests,
  invalidateOperatorRegistryCache,
  useOperatorRegistry,
} from './useOperatorRegistry';

const useSpacesDataMock = vi.fn();

vi.mock('@renderer/hooks/useSpacesData', () => ({
  useSpacesData: (...args: unknown[]) => useSpacesDataMock(...args),
}));

const activeSpace: SpaceInfo = {
  name: 'Active Space',
  path: 'work/acme/Active',
  absolutePath: '/workspace/work/acme/Active',
  type: 'team',
  isSymlink: false,
  hasReadme: true,
  status: 'ok',
};

const inactiveSpace: SpaceInfo = {
  name: 'Inactive Space',
  path: 'work/acme/Inactive',
  absolutePath: '/workspace/work/acme/Inactive',
  type: 'team',
  isSymlink: false,
  hasReadme: true,
  status: 'ok',
};

const chiefOfStaffSpace: SpaceInfo = {
  name: 'Chief of Staff',
  path: 'Chief-of-Staff',
  absolutePath: '/workspace/Chief-of-Staff',
  type: 'chief-of-staff',
  isSymlink: false,
  hasReadme: true,
  status: 'ok',
};

function makeOperator(space: SpaceInfo, name: string, slug = 'shared-slug'): OperatorMetadata {
  return {
    id: `${space.absolutePath}::${slug}`,
    operatorSlug: slug,
    spacePath: space.absolutePath,
    sourceSpacePath: space.absolutePath,
    category: 'space',
    name,
    description: `${name} description`,
    consult_when: `Ask ${name} when relevant.`,
    kind: 'operator',
    roles: ['operator'],
    operatorFileAbsolutePath: `${space.absolutePath}/operators/${slug}/OPERATOR.md`,
    groundingPath: `${space.absolutePath}/operators/${slug}/grounding.md`,
    diaryPath: `${space.absolutePath}/operators/${slug}/diary.md`,
  };
}

type LibraryChangedListener = (event: {
  timestamp: number;
  affectsTree: boolean;
  writerKind?: 'editor' | 'agent' | 'file-watcher' | 'cloud-sync';
  changedPath?: string;
}) => void;

let libraryChangedListeners: Set<LibraryChangedListener>;

function emitLibraryChanged(event: { changedPath?: string; affectsTree?: boolean; writerKind?: 'editor' | 'agent' | 'file-watcher' | 'cloud-sync' }): void {
  for (const listener of libraryChangedListeners) {
    listener({
      timestamp: Date.now(),
      affectsTree: event.affectsTree ?? false,
      ...(event.writerKind ? { writerKind: event.writerKind } : {}),
      ...(event.changedPath !== undefined ? { changedPath: event.changedPath } : {}),
    });
  }
}

describe('useOperatorRegistry', () => {
  beforeEach(() => {
    clearOperatorRegistryListCacheForTests();
    libraryChangedListeners = new Set<LibraryChangedListener>();
    (window as unknown as { operatorsApi: { list: ReturnType<typeof vi.fn> } }).operatorsApi = {
      list: vi.fn().mockResolvedValue({ operators: [] }),
    };
    (window as unknown as { api: { onLibraryChanged: (cb: LibraryChangedListener) => () => void } }).api = {
      onLibraryChanged: (callback) => {
        libraryChangedListeners.add(callback);
        return () => {
          libraryChangedListeners.delete(callback);
        };
      },
    };
  });

  afterEach(() => {
    clearOperatorRegistryListCacheForTests();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('does not spin when coreDirectory is missing across repeated render passes', async () => {
    useSpacesDataMock.mockImplementation(() => ({
      spaces: [],
      loading: false,
      ready: false,
      error: false,
      errorMessage: undefined,
      parseWarnings: [],
      refresh: vi.fn(),
    }));

    const { result, rerender, unmount } = renderHook(
      (props: { coreDirectory?: string }) => useOperatorRegistry({ coreDirectory: props.coreDirectory }),
      { initialProps: { coreDirectory: undefined } },
    );

    const firstOperatorsRef = result.current.operators;
    for (let i = 0; i < 5; i += 1) {
      act(() => {
        rerender({ coreDirectory: undefined });
      });
    }
    await flushAsync();

    expect((window.operatorsApi.list as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(result.current.operators).toBe(firstOperatorsRef);
    expect(result.current.operators).toEqual([]);
    unmount();
  });

  it('scopes duplicate Operator slugs to the active Space plus Chief-of-Staff', async () => {
    useSpacesDataMock.mockReturnValue({
      spaces: [activeSpace, inactiveSpace, chiefOfStaffSpace],
      loading: false,
      ready: true,
      error: false,
      errorMessage: undefined,
      parseWarnings: [],
      refresh: vi.fn(),
    });

    const activeOperator = makeOperator(activeSpace, 'Active Strategist');
    const inactiveOperator = makeOperator(inactiveSpace, 'Inactive Strategist');
    const chiefOperator = makeOperator(chiefOfStaffSpace, 'Platform Critic', 'platform-critic');
    (window.operatorsApi.list as ReturnType<typeof vi.fn>).mockImplementation(async ({ spacePaths }: { spacePaths: string[] }) => ({
      operators: [activeOperator, inactiveOperator, chiefOperator].filter((operator) =>
        spacePaths.includes(operator.spacePath),
      ),
    }));

    const { result, unmount } = renderHook(() =>
      useOperatorRegistry({
        coreDirectory: '/workspace',
        activeSpacePath: activeSpace.absolutePath,
      }),
    );
    await flushAsync();

    expect(window.operatorsApi.list).toHaveBeenCalledWith({
      spacePaths: [chiefOfStaffSpace.absolutePath, activeSpace.absolutePath],
    });
    expect(result.current.operators.map((operator) => operator.name).sort()).toEqual([
      'Active Strategist',
      'Platform Critic',
    ]);
    expect(result.current.operators).not.toContainEqual(inactiveOperator);
    unmount();
  });

  it('uses discovery mode by default', async () => {
    useSpacesDataMock.mockReturnValue({
      spaces: [activeSpace, inactiveSpace, chiefOfStaffSpace],
      loading: false,
      ready: true,
      error: false,
      errorMessage: undefined,
      parseWarnings: [],
      refresh: vi.fn(),
    });

    const { result, unmount } = renderHook(() =>
      useOperatorRegistry({
        coreDirectory: '/workspace',
        activeSpacePath: activeSpace.absolutePath,
      }),
    );
    await flushAsync();

    expect(result.current.spacePaths).toEqual([chiefOfStaffSpace.absolutePath, activeSpace.absolutePath]);
    expect(window.operatorsApi.list).toHaveBeenCalledWith({
      spacePaths: [chiefOfStaffSpace.absolutePath, activeSpace.absolutePath],
    });
    unmount();
  });

  it('includes all Spaces and bundled rebel-system in panel mode', async () => {
    useSpacesDataMock.mockReturnValue({
      spaces: [activeSpace, inactiveSpace, chiefOfStaffSpace],
      loading: false,
      ready: true,
      error: false,
      errorMessage: undefined,
      parseWarnings: [],
      refresh: vi.fn(),
    });

    const { result, unmount } = renderHook(() =>
      useOperatorRegistry({
        coreDirectory: '/workspace',
        activeSpacePath: activeSpace.absolutePath,
        mode: 'panel',
      }),
    );
    await flushAsync();

    expect(result.current.spacePaths).toEqual([
      activeSpace.absolutePath,
      inactiveSpace.absolutePath,
      chiefOfStaffSpace.absolutePath,
      '/workspace/rebel-system',
    ]);
    expect(result.current.sourceSpaces.map((space) => [space.label, space.category])).toEqual([
      ['Active Space', 'space'],
      ['Inactive Space', 'space'],
      ['Chief-of-Staff', 'space'],
      ['Bundled', 'bundled'],
    ]);
    expect(window.operatorsApi.list).toHaveBeenCalledWith({
      spacePaths: [
        activeSpace.absolutePath,
        inactiveSpace.absolutePath,
        chiefOfStaffSpace.absolutePath,
        '/workspace/rebel-system',
      ],
    });
    unmount();
  });

  it('passes roleFilter to operators:list when provided', async () => {
    useSpacesDataMock.mockReturnValue({
      spaces: [activeSpace, chiefOfStaffSpace],
      loading: false,
      ready: true,
      error: false,
      errorMessage: undefined,
      parseWarnings: [],
      refresh: vi.fn(),
    });

    const { unmount } = renderHook(() =>
      useOperatorRegistry({
        coreDirectory: '/workspace',
        activeSpacePath: activeSpace.absolutePath,
        roleFilter: 'live_meeting',
      }),
    );
    await flushAsync();

    expect(window.operatorsApi.list).toHaveBeenCalledWith({
      spacePaths: [chiefOfStaffSpace.absolutePath, activeSpace.absolutePath],
      roleFilter: 'live_meeting',
    });
    unmount();
  });

  it('keeps cache entries separate by roleFilter', async () => {
    useSpacesDataMock.mockReturnValue({
      spaces: [activeSpace, chiefOfStaffSpace],
      loading: false,
      ready: true,
      error: false,
      errorMessage: undefined,
      parseWarnings: [],
      refresh: vi.fn(),
    });

    (window.operatorsApi.list as ReturnType<typeof vi.fn>).mockImplementation(async ({
      spacePaths,
      roleFilter,
    }: {
      spacePaths: string[];
      roleFilter?: 'operator' | 'live_meeting';
    }) => ({
      operators: [makeOperator(activeSpace, `${roleFilter ?? 'all'} operator`)].filter((operator) =>
        spacePaths.includes(operator.spacePath),
      ).map((operator) => ({
        ...operator,
        roles: roleFilter ? [roleFilter] : ['operator'],
      })),
    }));

    const { rerender, result, unmount } = renderHook(
      (props: { roleFilter: 'operator' | 'live_meeting' }) =>
        useOperatorRegistry({
          coreDirectory: '/workspace',
          activeSpacePath: activeSpace.absolutePath,
          roleFilter: props.roleFilter,
        }),
      { initialProps: { roleFilter: 'operator' } },
    );
    await flushAsync();
    expect(window.operatorsApi.list).toHaveBeenCalledTimes(1);
    expect(result.current.operators[0]?.roles).toEqual(['operator']);

    act(() => {
      rerender({ roleFilter: 'live_meeting' });
    });
    await flushAsync();
    expect(window.operatorsApi.list).toHaveBeenCalledTimes(2);
    expect(result.current.operators[0]?.roles).toEqual(['live_meeting']);

    act(() => {
      rerender({ roleFilter: 'operator' });
    });
    await flushAsync();
    expect(window.operatorsApi.list).toHaveBeenCalledTimes(2);
    expect(result.current.operators[0]?.roles).toEqual(['operator']);
    unmount();
  });

  it('library:changed broadcast for OPERATOR.md invalidates the cache and refetches', async () => {
    useSpacesDataMock.mockReturnValue({
      spaces: [activeSpace, chiefOfStaffSpace],
      loading: false,
      ready: true,
      error: false,
      errorMessage: undefined,
      parseWarnings: [],
      refresh: vi.fn(),
    });

    let attempt = 0;
    (window.operatorsApi.list as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      attempt += 1;
      return { operators: [makeOperator(activeSpace, `attempt-${attempt}`)] };
    });

    const { result, unmount } = renderHook(() =>
      useOperatorRegistry({
        coreDirectory: '/workspace',
        activeSpacePath: activeSpace.absolutePath,
      }),
    );
    await flushAsync();
    expect(window.operatorsApi.list).toHaveBeenCalledTimes(1);
    expect(result.current.operators[0]?.name).toBe('attempt-1');

    act(() => {
      emitLibraryChanged({
        changedPath: `${activeSpace.absolutePath}/operators/shared-slug/OPERATOR.md`,
        writerKind: 'agent',
      });
    });
    await flushAsync();
    expect(window.operatorsApi.list).toHaveBeenCalledTimes(2);
    expect(result.current.operators[0]?.name).toBe('attempt-2');

    act(() => {
      emitLibraryChanged({
        changedPath: `${activeSpace.absolutePath}/operators/shared-slug/diary.md`,
        writerKind: 'agent',
      });
    });
    await flushAsync();
    expect(window.operatorsApi.list).toHaveBeenCalledTimes(2);

    unmount();
  });

  it('invalidateOperatorRegistryCache clears every cached query and forces a refetch', async () => {
    useSpacesDataMock.mockReturnValue({
      spaces: [activeSpace, chiefOfStaffSpace],
      loading: false,
      ready: true,
      error: false,
      errorMessage: undefined,
      parseWarnings: [],
      refresh: vi.fn(),
    });

    let attempt = 0;
    (window.operatorsApi.list as ReturnType<typeof vi.fn>).mockImplementation(async ({
      roleFilter,
    }: {
      spacePaths: string[];
      roleFilter?: 'operator' | 'live_meeting';
    }) => {
      attempt += 1;
      const operator = makeOperator(activeSpace, `attempt-${attempt}`);
      return {
        operators: [{
          ...operator,
          roles: roleFilter ? [roleFilter] : ['operator'],
        }],
      };
    });

    const operatorsHook = renderHook(() =>
      useOperatorRegistry({
        coreDirectory: '/workspace',
        activeSpacePath: activeSpace.absolutePath,
        roleFilter: 'operator',
      }),
    );
    const liveHook = renderHook(() =>
      useOperatorRegistry({
        coreDirectory: '/workspace',
        activeSpacePath: activeSpace.absolutePath,
        roleFilter: 'live_meeting',
      }),
    );
    await flushAsync();
    expect(window.operatorsApi.list).toHaveBeenCalledTimes(2);
    expect(operatorsHook.result.current.operators[0]?.name).toBe('attempt-1');
    expect(liveHook.result.current.operators[0]?.name).toBe('attempt-2');

    act(() => {
      invalidateOperatorRegistryCache();
    });
    await flushAsync();

    expect(window.operatorsApi.list).toHaveBeenCalledTimes(4);
    expect(operatorsHook.result.current.operators[0]?.name).toBe('attempt-3');
    expect(liveHook.result.current.operators[0]?.name).toBe('attempt-4');

    operatorsHook.unmount();
    liveHook.unmount();
  });
});
