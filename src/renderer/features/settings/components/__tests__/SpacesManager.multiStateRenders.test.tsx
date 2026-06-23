// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import type { SpaceConfig } from '@shared/types';
import { SpacesManager } from '../SpacesManager';
import { __resetSpacesCacheForTests } from '@renderer/hooks/useSpacesData';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockShowToast = vi.hoisted(() => vi.fn());
const mockRefreshSettings = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const settingsState = vi.hoisted(() => ({
  value: {
    draftSettings: {
      coreDirectory: '/workspace',
      companyName: 'Acme',
      spaces: [] as SpaceConfig[],
    },
    refreshSettings: mockRefreshSettings,
  },
}));

 
vi.mock('@renderer/contexts/AppContext', () => ({
  useAppContext: () => ({ showToast: mockShowToast }),
}));

 
vi.mock('@renderer/features/settings/SettingsProvider', () => ({
  useSettingsSafe: () => settingsState.value,
}));

 
vi.mock('@renderer/contexts/NavigationContext', () => ({
  useNavigationSafe: () => ({ navigate: mockNavigate }),
}));

 
vi.mock('@renderer/hooks/useFeatureGate', () => ({
  useFeatureGate: () => ({ isFeatureEnabled: () => true }),
}));

 
vi.mock('@renderer/features/spaces', () => ({
  AddSpaceWizard: () => null,
}));

 
vi.mock('@renderer/features/agent-session/components/CollapsibleSection', () => ({
  CollapsibleSection: ({
    label,
    count,
    children,
    'data-testid': testId,
  }: {
    label: string;
    count: number;
    children: React.ReactNode;
    'data-testid'?: string;
  }) => (
    <section data-testid={testId}>
      <h2>{label} {count}</h2>
      {children}
    </section>
  ),
}));

const mockScanSpaces = vi.fn();
const mockSuggestSpaces = vi.fn();
const mockUpdateSpaceFrontmatter = vi.fn();

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

function makeSpace(path: string, name: string, organisationName?: string): SpaceInfo {
  return {
    name,
    path,
    absolutePath: `/workspace/${path}`,
    type: 'project',
    isSymlink: false,
    hasReadme: true,
    description: `${name} description`,
    sharing: 'restricted',
    ...(organisationName !== undefined ? { organisationName } : {}),
    status: 'ok',
  } as SpaceInfo;
}

function makeSpaceConfig(path: string, name: string, companyName: string): SpaceConfig {
  return {
    name,
    path,
    type: 'project',
    isSymlink: false,
    companyName,
    createdAt: 1,
  } as SpaceConfig;
}

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(ui);
  });

  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountSpaces(
  spaces: SpaceInfo[],
  settingsSpaces: SpaceConfig[],
  parseWarnings: Array<{ path: string; message: string }> = [],
): Promise<Mounted> {
  settingsState.value = {
    draftSettings: {
      coreDirectory: '/workspace',
      companyName: 'Acme',
      spaces: settingsSpaces,
    },
    refreshSettings: mockRefreshSettings,
  };
  mockScanSpaces.mockResolvedValue({ success: true, spaces, parseWarnings });
  mockSuggestSpaces.mockResolvedValue({ success: true, suggestions: [] });

  const mounted = mount(<SpacesManager companyName="Acme" />);
  await flushEffects();
  return mounted;
}

function headingTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid="organisation-group-heading"]')]
    .map(element => element.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

describe('SpacesManager multi-state organisation rendering', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    __resetSpacesCacheForTests();
    Object.defineProperty(window, 'libraryApi', {
      configurable: true,
      value: {
        scanSpaces: mockScanSpaces,
        suggestSpaces: mockSuggestSpaces,
        updateSpaceFrontmatter: mockUpdateSpaceFrontmatter,
        migrateLegacyAgentsMd: vi.fn(),
        removeSpace: vi.fn(),
        moveSpace: vi.fn(),
        renameSpace: vi.fn(),
      },
    });
    Object.defineProperty(window, 'appApi', {
      configurable: true,
      value: {
        revealPath: vi.fn(),
        openPath: vi.fn(),
      },
    });
    Object.defineProperty(window, 'settingsApi', {
      configurable: true,
      value: {
        chooseDirectory: vi.fn(),
      },
    });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    __resetSpacesCacheForTests();
    vi.clearAllMocks();
  });

  it('groups legacy settings-only spaces via companyName fallback', async () => {
    mounted = await mountSpaces(
      [
        makeSpace('work/Acme/General', 'General'),
        makeSpace('work/Acme/Exec', 'Exec'),
      ],
      [
        makeSpaceConfig('work/Acme/General', 'General', 'Acme'),
        makeSpaceConfig('work/Acme/Exec', 'Exec', 'Acme'),
      ],
    );

    expect(headingTexts(mounted.container)).toEqual(['Acme(2)']);
  });

  it('groups under frontmatter organisation when settings companyName disagrees', async () => {
    mounted = await mountSpaces(
      [
        makeSpace('work/Acme/General', 'General', 'Acme Inc'),
        makeSpace('work/Acme/Exec', 'Exec', 'Acme Inc'),
      ],
      [
        makeSpaceConfig('work/Acme/General', 'General', 'Acme'),
        makeSpaceConfig('work/Acme/Exec', 'Exec', 'Acme'),
      ],
    );

    expect(headingTexts(mounted.container)).toEqual(['Acme Inc(2)']);
  });

  it('surfaces README frontmatter parse warnings returned by scanSpaces', async () => {
    mounted = await mountSpaces(
      [makeSpace('work/Acme/General', 'General', 'Acme')],
      [makeSpaceConfig('work/Acme/General', 'General', 'Acme')],
      [{ path: 'work/Acme/Broken', message: 'YAML parse error' }],
    );

    expect(mounted.container.textContent).toContain('Spaces with configuration issues');
    expect(mounted.container.textContent).toContain('work/Acme/Broken');
    expect(mounted.container.textContent).toContain('YAML parse error');
  });
});
