// @vitest-environment happy-dom
import React, { act, createRef } from 'react';
import type { ComponentProps, SVGProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentSessionSidebar } from '../AgentSessionSidebar';
import type { ConversationSearchResult } from '@renderer/utils/conversationSearch';

vi.mock('../AgentSessionSidebar.module.css', () => ({
  default: new Proxy({}, { get: (_target, prop) => String(prop) }),
}));

vi.mock('@renderer/components/ui', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('@renderer/components/ui/Tabs', () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
}));

vi.mock('@renderer/components/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@renderer/components/ui/Input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock('lucide-react', () => {
  const Icon = ({ 'data-icon': dataIcon, ...props }: SVGProps<SVGSVGElement> & { 'data-icon'?: string }) => (
    <svg data-icon={dataIcon ?? 'icon'} {...props} />
  );
  return {
    Search: (props: SVGProps<SVGSVGElement>) => <Icon data-icon="search" {...props} />,
    Star: (props: SVGProps<SVGSVGElement>) => <Icon data-icon="star" {...props} />,
    Clock: (props: SVGProps<SVGSVGElement>) => <Icon data-icon="clock" {...props} />,
    Trash2: (props: SVGProps<SVGSVGElement>) => <Icon data-icon="trash-2" {...props} />,
    RotateCcw: (props: SVGProps<SVGSVGElement>) => <Icon data-icon="rotate-ccw" {...props} />,
    Loader2: (props: SVGProps<SVGSVGElement>) => <Icon data-icon="loader-2" {...props} />,
    Sparkles: (props: SVGProps<SVGSVGElement>) => <Icon data-icon="sparkles" {...props} />,
    ArrowLeft: (props: SVGProps<SVGSVGElement>) => <Icon data-icon="arrow-left" {...props} />,
    X: (props: SVGProps<SVGSVGElement>) => <Icon data-icon="x" {...props} />,
    Video: (props: SVGProps<SVGSVGElement>) => <Icon data-icon="video" {...props} />,
    MessagesSquare: (props: SVGProps<SVGSVGElement>) => <Icon data-icon="messages-square" {...props} />,
    FolderPlus: (props: SVGProps<SVGSVGElement>) => <Icon data-icon="folder-plus" {...props} />,
  };
});

vi.mock('@renderer/src/tracking', () => ({
  tracking: {
    navigation: {
      sidebarFilterChanged: vi.fn(),
    },
  },
}));

vi.mock('../store/folderStore', () => ({
  useFolders: () => [],
  useFolderMembership: () => ({}),
  useFolderCollapseState: () => ({}),
  useFolderDoneCollapseState: () => ({}),
  useFolderActions: () => ({
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolderWithUndo: vi.fn(),
    moveSessionToFolder: vi.fn(),
    removeSessionFromFolder: vi.fn(),
    toggleFolderCollapse: vi.fn(),
    toggleFolderDoneCollapse: vi.fn(),
  }),
}));

vi.mock('../VirtualizedSessionList', () => ({
  VirtualizedSessionList: () => <div data-testid="virtualized-session-list" />,
}));

vi.mock('../SessionTooltipContent', () => ({
  SessionTooltipContent: () => <div data-testid="session-tooltip-content" />,
}));

vi.mock('../SessionListItemActions', () => ({
  SessionListItemActions: () => <div data-testid="session-list-item-actions" />,
}));

vi.mock('../FolderHeaderRow', () => ({
  FolderHeaderRow: () => <div data-testid="folder-header-row" />,
}));

vi.mock('../DoneSubsectionRow', () => ({
  DoneSubsectionRow: () => <div data-testid="done-subsection-row" />,
}));

vi.mock('../MoveToFolderPopover', () => ({
  MoveToFolderPopover: () => <div data-testid="move-to-folder-popover" />,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type SidebarProps = ComponentProps<typeof AgentSessionSidebar>;

const baseResult: ConversationSearchResult = {
  sessionId: 'similar-session-1',
  sessionTitle: 'Similar Budget Review',
  sessionTimestamp: 1_720_000_000_000,
  resolvedAt: null,
  isResolved: false,
  isHistory: true,
  isCorrupted: false,
  messageCount: 3,
  matchedText: 'Similar Budget Review',
  matchedRole: 'user',
  score: 0.92,
  matches: [],
  isTitle: true,
};

function makeProps(overrides: Partial<SidebarProps> = {}): SidebarProps {
  return {
    currentSessionId: 'current-session',
    sessions: [],
    sessionSearchQuery: '',
    sessionSearchResults: [baseResult],
    findSimilarSource: { sessionId: 'source-session', title: 'My Conversation' },
    isSearching: false,
    sessionDeepSearchResults: [],
    isDeepSearching: false,
    onTriggerDeepSearch: vi.fn(),
    sessionSearchSelectedIndex: 0,
    sessionSearchInputRef: createRef<HTMLInputElement>(),
    onSearchChange: vi.fn(),
    onSearchKeyDown: vi.fn(),
    onSearchHover: vi.fn(),
    onClearSearch: vi.fn(),
    onSelectSession: vi.fn(),
    onSoftDeleteSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onTogglePin: vi.fn(),
    onToggleStar: vi.fn(),
    onRestoreSession: vi.fn(),
    onEmptyTrash: vi.fn(),
    sessionTypeFilter: 'all',
    onSessionTypeFilterChange: vi.fn(),
    recencyFilter: 'all',
    onRecencyFilterChange: vi.fn(),
    editingSessionId: null,
    editValue: '',
    editInputRef: createRef<HTMLInputElement>(),
    onStartRename: vi.fn(),
    onEditChange: vi.fn(),
    onEditKeyDown: vi.fn(),
    onEditBlur: vi.fn(),
    indexedSessionIds: new Set<string>(),
    ...overrides,
  };
}

function renderSidebarToHtml(overrides: Partial<SidebarProps> = {}): string {
  return renderToStaticMarkup(<AgentSessionSidebar {...makeProps(overrides)} />);
}

function renderSidebar(overrides: Partial<SidebarProps> = {}): {
  container: HTMLElement;
  root: Root;
  props: SidebarProps;
} {
  const props = makeProps(overrides);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<AgentSessionSidebar {...props} />);
  });

  return { container, root, props };
}

describe('AgentSessionSidebar find-similar presentation', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders the back control and wires it to clear search', () => {
    const onClearSearch = vi.fn();
    const { container, root } = renderSidebar({ onClearSearch });
    const backButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Back to all conversations'));

    expect(backButton).toBeTruthy();

    act(() => {
      backButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onClearSearch).toHaveBeenCalledTimes(1);
    expect(onClearSearch).toHaveBeenCalledWith();

    act(() => root.unmount());
  });

  it('renders the find-similar source title with contextual copy', () => {
    const html = renderSidebarToHtml({
      findSimilarSource: { sessionId: 'source-session', title: 'My Conversation' },
    });

    expect(html).toContain('Similar to “My Conversation”');
  });

  it('falls back for untitled find-similar sources without rendering empty quotes', () => {
    const html = renderSidebarToHtml({
      findSimilarSource: { sessionId: 'source-session', title: '' },
    });

    expect(html).toContain('Similar to this conversation');
    expect(html).not.toContain('Similar to “”');
  });

  it('renders the clear button with mode-aware Back aria-label in find-similar mode', () => {
    const html = renderSidebarToHtml();

    expect(html).toContain('aria-label="Back to all conversations"');
  });

  it('uses find-similar empty copy and keeps the Back control visible', () => {
    const html = renderSidebarToHtml({
      sessionSearchResults: [],
      isSearching: false,
      sessionDeepSearchResults: [],
      findSimilarSource: { sessionId: 'source-session', title: 'My Conversation' },
    });

    expect(html).toContain('Back to all conversations');
    expect(html).toContain('No similar conversations turned up.');
    expect(html).not.toContain('No conversations match &quot;&quot;');
    expect(html).not.toContain('No conversations match ""');
  });

  it('keeps the normal-search clear button labelled as Clear search', () => {
    const html = renderSidebarToHtml({
      sessionSearchQuery: 'budget',
      findSimilarSource: null,
    });

    expect(html).toContain('aria-label="Clear search"');
    expect(html).not.toContain('aria-label="Back to all conversations"');
  });
});
