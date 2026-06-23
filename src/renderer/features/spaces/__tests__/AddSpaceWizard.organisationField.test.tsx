// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateSpaceOptions, SpaceInfo } from '@shared/ipc/schemas/library';
import { AddSpaceWizard } from '../components/AddSpaceWizard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

const mockSettingsGet = vi.fn();
const mockSettingsUpdate = vi.fn();
const mockChooseDirectory = vi.fn();
const mockCheckSymlink = vi.fn();
const mockAnalyzePath = vi.fn();
const mockGenerateDescription = vi.fn();
const mockUpdateSpaceFrontmatter = vi.fn();
const mockUpdateSpaceAssociatedAccounts = vi.fn();
const mockFetchSpaces = vi.hoisted(() => vi.fn());
const mockGetSpacesSnapshotFor = vi.hoisted(() => vi.fn());
const mockInvalidateSpaces = vi.hoisted(() => vi.fn());

 
vi.mock('@renderer/hooks/useSpacesData', () => ({
  fetchSpaces: mockFetchSpaces,
  getSpacesSnapshotFor: mockGetSpacesSnapshotFor,
  invalidateSpaces: mockInvalidateSpaces,
}));

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

async function flushEffects(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function getOrganisationInput(): HTMLInputElement {
  const input = document.body.querySelector<HTMLInputElement>('#space-organisation');
  expect(input).toBeInstanceOf(HTMLInputElement);
  return input as HTMLInputElement;
}

function getAssociatedAccountsTextarea(): HTMLTextAreaElement {
  const textarea = document.body.querySelector<HTMLTextAreaElement>('#space-emails');
  expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
  return textarea as HTMLTextAreaElement;
}

function makeSpace(path: string, organisationName?: string): SpaceInfo {
  return {
    name: path.split('/').pop() ?? path,
    path,
    absolutePath: `/workspace/${path}`,
    type: 'project',
    isSymlink: false,
    hasReadme: true,
    description: 'Existing sibling',
    sharing: 'restricted',
    ...(organisationName !== undefined ? { organisationName } : {}),
    status: 'ok',
  } as SpaceInfo;
}

async function renderCreateWizard({
  selectedPath,
  workspaceRelativePath,
  spaces = [],
  onComplete = vi.fn(),
  defaultUserEmail,
  existingFrontmatter,
}: {
  selectedPath: string;
  workspaceRelativePath: string;
  spaces?: SpaceInfo[];
  onComplete?: (spaceConfig: CreateSpaceOptions) => void;
  defaultUserEmail?: string | null;
  existingFrontmatter?: {
    description?: string;
    space_type?: 'personal' | 'company' | 'team' | 'project' | 'operator' | 'other';
    sharing?: 'private' | 'restricted' | 'company-wide' | 'public';
    organisation_name?: string;
    emails?: string[];
  };
}): Promise<Mounted> {
  mockSettingsGet.mockResolvedValue({ coreDirectory: '/workspace' });
  mockChooseDirectory.mockResolvedValue(selectedPath);
  mockCheckSymlink.mockResolvedValue({ isSymlink: false });
  mockAnalyzePath.mockResolvedValue({
    storageProvider: 'local',
    inferredSharing: 'restricted',
    inferredCategory: 'work',
    isInsideWorkspace: true,
    workspaceRelativePath,
    hasExistingFrontmatter: Boolean(existingFrontmatter),
    existingFrontmatter,
  });
  mockFetchSpaces.mockResolvedValue(undefined);
  mockGetSpacesSnapshotFor.mockReturnValue({
    spaces,
    ready: true,
    error: false,
    parseWarnings: [],
  });
  mockGenerateDescription.mockResolvedValue({ description: 'Generated description', source: 'haiku' });

  const mounted = mount(
    <AddSpaceWizard
      open
      onOpenChange={vi.fn()}
      onComplete={onComplete}
      onCancel={vi.fn()}
      mode="create"
      defaultUserEmail={defaultUserEmail}
    />
  );
  await flushEffects();
  return mounted;
}

describe('AddSpaceWizard organisation field', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    Object.defineProperty(window, 'settingsApi', {
      configurable: true,
      value: {
        get: mockSettingsGet,
        update: mockSettingsUpdate,
        chooseDirectory: mockChooseDirectory,
      },
    });
    Object.defineProperty(window, 'libraryApi', {
      configurable: true,
      value: {
        checkSymlink: mockCheckSymlink,
        analyzePath: mockAnalyzePath,
        generateSpaceDescription: mockGenerateDescription,
        updateSpaceFrontmatter: mockUpdateSpaceFrontmatter,
        updateSpaceAssociatedAccounts: mockUpdateSpaceAssociatedAccounts,
      },
    });
    Object.defineProperty(window, 'appApi', {
      configurable: true,
      value: {
        revealPath: vi.fn(),
      },
    });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('defaults Organisation from the path heuristic when there are no sibling spaces', async () => {
    mounted = await renderCreateWizard({
      selectedPath: '/workspace/work/Mindstone/NewProject',
      workspaceRelativePath: 'work/Mindstone/NewProject',
    });

    expect(getOrganisationInput().value).toBe('Mindstone');
  });

  it('defaults Organisation from a sibling space before using the path heuristic', async () => {
    mounted = await renderCreateWizard({
      selectedPath: '/workspace/work/Acme/NewProject',
      workspaceRelativePath: 'work/Acme/NewProject',
      spaces: [makeSpace('work/Acme/General', 'Mindstone')],
    });

    expect(mockFetchSpaces).toHaveBeenCalledWith('/workspace', { force: true });
    expect(mockGetSpacesSnapshotFor).toHaveBeenCalledWith('/workspace');
    expect(getOrganisationInput().value).toBe('Mindstone');
  });

  it('leaves Organisation empty when neither sibling data nor path heuristic exists', async () => {
    mounted = await renderCreateWizard({
      selectedPath: '/workspace/Loose/NewProject',
      workspaceRelativePath: 'Loose/NewProject',
    });

    expect(getOrganisationInput().value).toBe('');
  });

  it('passes Organisation through when creating the space', async () => {
    const onComplete = vi.fn();
    mounted = await renderCreateWizard({
      selectedPath: '/workspace/work/Mindstone/NewProject',
      workspaceRelativePath: 'work/Mindstone/NewProject',
      onComplete,
    });

    const createButton = [...document.body.querySelectorAll('button')]
      .find(button => button.textContent === 'Create Space');
    expect(createButton).toBeDefined();

    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      organisation: 'Mindstone',
      associatedAccounts: [],
    }));
  });

  it('defaults add-existing Associated Accounts to the current user and keeps the field editable', async () => {
    const onComplete = vi.fn();
    mounted = await renderCreateWizard({
      selectedPath: '/workspace/work/AcmeCorp/Shared',
      workspaceRelativePath: 'work/AcmeCorp/Shared',
      defaultUserEmail: '[external-email]',
      existingFrontmatter: {
        description: 'Shared Acme Corp space',
        space_type: 'company',
        sharing: 'restricted',
        organisation_name: 'Acme Corp',
        emails: ['[external-email]'],
      },
      onComplete,
    });

    const textarea = getAssociatedAccountsTextarea();
    expect(textarea.value).toBe('[external-email]');
    expect(textarea.readOnly).toBe(false);

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      valueSetter?.call(textarea, '[external-email]');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const addButton = [...document.body.querySelectorAll('button')]
      .find(button => button.textContent === 'Add Space');
    expect(addButton).toBeDefined();

    await act(async () => {
      addButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      skipFrontmatterWrite: true,
      associatedAccounts: ['[external-email]'],
    }));
    expect(onComplete).toHaveBeenCalledWith(expect.not.objectContaining({
      emails: expect.any(Array),
    }));
  });

  it('defaults add-existing Associated Accounts to explicit local none when current user email is unavailable', async () => {
    const onComplete = vi.fn();
    mounted = await renderCreateWizard({
      selectedPath: '/workspace/work/AcmeCorp/Shared',
      workspaceRelativePath: 'work/AcmeCorp/Shared',
      defaultUserEmail: null,
      existingFrontmatter: {
        description: 'Shared Acme Corp space',
        space_type: 'company',
        sharing: 'restricted',
        emails: ['[external-email]'],
      },
      onComplete,
    });

    expect(getAssociatedAccountsTextarea().value).toBe('');

    const addButton = [...document.body.querySelectorAll('button')]
      .find(button => button.textContent === 'Add Space');
    expect(addButton).toBeDefined();

    await act(async () => {
      addButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      associatedAccounts: [],
    }));
  });

  it('saves Organisation through the edit-space wizard frontmatter path', async () => {
    mockUpdateSpaceFrontmatter.mockResolvedValue({ success: true });
    mockUpdateSpaceAssociatedAccounts.mockResolvedValue({ success: true });
    mockSettingsGet.mockResolvedValue({
      coreDirectory: '/workspace',
      spaces: [{
        name: 'General',
        path: 'work/Mindstone/General',
        type: 'project',
        isSymlink: false,
        createdAt: 123,
      }],
    });
    const onComplete = vi.fn();
    const existingSpace = {
      ...makeSpace('work/Mindstone/General', 'Mindstone'),
      associatedAccounts: ['[Mindstone-email]'],
    };

    mounted = mount(
      <AddSpaceWizard
        open
        onOpenChange={vi.fn()}
        onComplete={onComplete}
        onCancel={vi.fn()}
        mode="edit"
        existingSpace={existingSpace}
      />
    );
    await flushEffects(2);

    const input = getOrganisationInput();
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(input, 'Acme');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const associatedAccounts = getAssociatedAccountsTextarea();
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      valueSetter?.call(associatedAccounts, '[Mindstone-email]');
      associatedAccounts.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const saveButton = [...document.body.querySelectorAll('button')]
      .find(button => button.textContent === 'Save Changes');
    expect(saveButton).toBeDefined();

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(mockUpdateSpaceFrontmatter).toHaveBeenCalledWith({
      spacePath: 'work/Mindstone/General',
      updates: expect.objectContaining({
        organisation_name: 'Acme',
      }),
    });
    expect(mockUpdateSpaceFrontmatter).toHaveBeenCalledWith({
      spacePath: 'work/Mindstone/General',
      updates: expect.not.objectContaining({
        emails: expect.any(Array),
      }),
    });
    expect(mockUpdateSpaceAssociatedAccounts).toHaveBeenCalledWith({
      spacePath: 'work/Mindstone/General',
      associatedAccounts: ['[Mindstone-email]'],
    });
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ organisation: 'Acme' }));
  });

  it('surfaces edit-space frontmatter failures without invalidating or completing', async () => {
    mockUpdateSpaceFrontmatter.mockResolvedValue({ success: false, error: 'mocked write failure' });
    const onComplete = vi.fn();
    const existingSpace = makeSpace('work/Mindstone/General', 'Mindstone');

    mounted = mount(
      <AddSpaceWizard
        open
        onOpenChange={vi.fn()}
        onComplete={onComplete}
        onCancel={vi.fn()}
        mode="edit"
        existingSpace={existingSpace}
      />
    );
    await flushEffects(2);

    const saveButton = [...document.body.querySelectorAll('button')]
      .find(button => button.textContent === 'Save Changes');
    expect(saveButton).toBeDefined();

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(mockUpdateSpaceFrontmatter).toHaveBeenCalledWith({
      spacePath: 'work/Mindstone/General',
      updates: expect.objectContaining({
        organisation_name: 'Mindstone',
      }),
    });
    expect(mockInvalidateSpaces).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('mocked write failure');
  });
});
