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

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

const mockScanSpaces = vi.fn();
const mockSuggestSpaces = vi.fn();
const mockUpdateSpaceFrontmatter = vi.fn();

function makeSpace(
  path: string,
  name: string,
  organisationName?: string,
  companyName?: string
): SpaceInfo {
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
    ...(companyName !== undefined ? { companyName } : {}),
    status: 'ok',
  } as SpaceInfo;
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

async function mountSpaces(spaces: SpaceInfo[], settingsSpaces: SpaceConfig[] = []): Promise<Mounted> {
  settingsState.value = {
    draftSettings: {
      coreDirectory: '/workspace',
      spaces: settingsSpaces,
    },
    refreshSettings: mockRefreshSettings,
  };
  mockScanSpaces.mockResolvedValue({ success: true, spaces });
  mockSuggestSpaces.mockResolvedValue({ success: true, suggestions: [] });

  const mounted = mount(<SpacesManager companyName={null} />);
  await flushEffects();
  return mounted;
}

function headingTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid="organisation-group-heading"]')]
    .map(element => element.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

function visibleText(container: HTMLElement): string {
  return container.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

describe('SpacesManager organisation grouping', () => {
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

  it('snapshots three Mindstone spaces grouped under one heading', async () => {
    mounted = await mountSpaces([
      makeSpace('work/Mindstone/Exec', 'Exec', 'Mindstone'),
      makeSpace('work/Mindstone/General', 'General', 'Mindstone'),
      makeSpace('work/Mindstone/Coaches', 'Coaches', 'Mindstone'),
    ]);

    expect({
      headings: headingTexts(mounted.container),
      text: visibleText(mounted.container),
    }).toMatchInlineSnapshot(`
      {
        "headings": [
          "Mindstone(3)",
        ],
        "text": "Work 3Connect folders from shared drives, cloud storage, or local projects. Rebel uses these spaces to understand your work context.Mindstone(3)CoachesMindstoneCoaches descriptionExecMindstoneExec descriptionGeneralMindstoneGeneral description",
      }
    `);
  });

  it('snapshots single-org single-space without an organisation heading', async () => {
    mounted = await mountSpaces([
      makeSpace('work/Mindstone/Exec', 'Exec', 'Mindstone'),
    ]);

    expect({
      headings: headingTexts(mounted.container),
      text: visibleText(mounted.container),
    }).toMatchInlineSnapshot(`
      {
        "headings": [],
        "text": "Work 1Connect folders from shared drives, cloud storage, or local projects. Rebel uses these spaces to understand your work context.ExecMindstoneExec description",
      }
    `);
  });

  it('snapshots mixed organisations with unorganised spaces trailing', async () => {
    mounted = await mountSpaces([
      makeSpace('work/Mindstone/General', 'General', 'Mindstone'),
      makeSpace('work/Acme/Sales', 'Sales', 'Acme'),
      makeSpace('work/Mindstone/Exec', 'Exec', 'Mindstone'),
      makeSpace('work/Loose', 'Loose'),
    ]);

    expect({
      headings: headingTexts(mounted.container),
      text: visibleText(mounted.container),
    }).toMatchInlineSnapshot(`
      {
        "headings": [
          "Acme(1)",
          "Mindstone(2)",
          "No organisation set(1)",
        ],
        "text": "Work 4Connect folders from shared drives, cloud storage, or local projects. Rebel uses these spaces to understand your work context.Acme(1)SalesAcmeSales descriptionMindstone(2)ExecMindstoneExec descriptionGeneralMindstoneGeneral descriptionNo organisation set(1)LooseLoose descriptionNo organisation setSet organisation to Loose",
      }
    `);
  });

  it('opens the per-card organisation editor with the path suggestion and saves via frontmatter IPC', async () => {
    mockUpdateSpaceFrontmatter.mockResolvedValue({ success: true });
    mounted = await mountSpaces([
      makeSpace('work/Mindstone/General', 'General'),
    ]);

    const setButton = [...mounted.container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('Set organisation to Mindstone'));
    expect(setButton).toBeDefined();

    await act(async () => {
      setButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const input = mounted.container.querySelector<HTMLInputElement>('input[aria-label="Organisation name"]');
    expect(input?.value).toBe('Mindstone');

    const saveButton = [...mounted.container.querySelectorAll('button')]
      .find(button => button.textContent === 'Save');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(mockUpdateSpaceFrontmatter).toHaveBeenCalledWith({
      spacePath: 'work/Mindstone/General',
      updates: {
        organisation_name: 'Mindstone',
      },
    });
    expect(mockRefreshSettings).toHaveBeenCalled();
  });

  it('refreshes organisation grouping immediately after saving an organisation', async () => {
    mockUpdateSpaceFrontmatter.mockResolvedValue({ success: true });
    mockScanSpaces
      .mockResolvedValueOnce({
        success: true,
        spaces: [
          makeSpace('work/Mindstone/General', 'General'),
          makeSpace('work/Acme/Sales', 'Sales', 'Acme'),
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        spaces: [
          makeSpace('work/Mindstone/General', 'General', 'Mindstone'),
          makeSpace('work/Acme/Sales', 'Sales', 'Acme'),
        ],
      });
    mockSuggestSpaces.mockResolvedValue({ success: true, suggestions: [] });

    mounted = mount(<SpacesManager companyName={null} />);
    await flushEffects();

    expect(headingTexts(mounted.container)).toContain('No organisation set(1)');

    const setButton = [...mounted.container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('Set organisation to Mindstone'));
    await act(async () => {
      setButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const saveButton = [...mounted.container.querySelectorAll('button')]
      .find(button => button.textContent === 'Save');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await flushEffects();

    expect(headingTexts(mounted.container)).toEqual(['Acme(1)', 'Mindstone(1)']);
  });
});
