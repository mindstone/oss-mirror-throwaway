/**
 * Tests for sessionMenuActions — the pure action-registry filter that both
 * SessionActionsMenu (sidebar) and ConversationActionsMenu (conversation pane)
 * rely on to decide which items to render.
 *
 * Covers FOX-3071: "Move to folder…" and "Remove from folder" must be
 * available in both contexts (sidebar + conversation), gated by the presence
 * of their callbacks and (for removeFromFolder) the `isInFolder` flag.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  getActionsForContext,
  type SessionMenuCallbacks,
} from '../sessionMenuActions';

function allCallbacks(overrides: Partial<SessionMenuCallbacks> = {}): SessionMenuCallbacks {
  return {
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onFindSimilar: vi.fn(),
    onToggleStar: vi.fn(),
    onTogglePin: vi.fn(),
    onToggleCloudContinuity: vi.fn(),
    onCopyMarkdown: vi.fn(),
    onExportMarkdown: vi.fn(),
    onCopyLink: vi.fn(),
    onShareConversation: vi.fn(),
    onRevealInSidebar: vi.fn(),
    onDiagnose: vi.fn(),
    onExportLogs: vi.fn(),
    onMoveToFolder: vi.fn() as unknown as SessionMenuCallbacks['onMoveToFolder'],
    onRemoveFromFolder: vi.fn(),
    isInFolder: true,
    ...overrides,
  };
}

describe('getActionsForContext — folder actions (FOX-3071)', () => {
  it('includes "Move to folder…" in the conversation context when onMoveToFolder is provided', () => {
    const actions = getActionsForContext('conversation', allCallbacks());
    const ids = actions.map((a) => a.id);
    expect(ids).toContain('moveToFolder');
  });

  it('includes "Remove from folder" in the conversation context when onRemoveFromFolder is provided AND isInFolder is true', () => {
    const actions = getActionsForContext('conversation', allCallbacks({ isInFolder: true }));
    const ids = actions.map((a) => a.id);
    expect(ids).toContain('removeFromFolder');
  });

  it('hides "Remove from folder" in the conversation context when isInFolder is false', () => {
    const actions = getActionsForContext(
      'conversation',
      allCallbacks({ isInFolder: false }),
    );
    const ids = actions.map((a) => a.id);
    expect(ids).not.toContain('removeFromFolder');
    expect(ids).toContain('moveToFolder');
  });

  it('hides both folder actions when no folder callbacks are provided (conversation context)', () => {
    const actions = getActionsForContext(
      'conversation',
      allCallbacks({
        onMoveToFolder: undefined,
        onRemoveFromFolder: undefined,
        isInFolder: false,
      }),
    );
    const ids = actions.map((a) => a.id);
    expect(ids).not.toContain('moveToFolder');
    expect(ids).not.toContain('removeFromFolder');
  });

  it('still includes folder actions in the sidebar context (no regression)', () => {
    const sidebarIds = getActionsForContext('sidebar', allCallbacks()).map((a) => a.id);
    expect(sidebarIds).toContain('moveToFolder');
    expect(sidebarIds).toContain('removeFromFolder');
  });

  it('orders "Move to folder…" right after "Find similar" in both contexts (UX parity)', () => {
    for (const context of ['sidebar', 'conversation'] as const) {
      const ids = getActionsForContext(context, allCallbacks()).map((a) => a.id);
      const findIdx = ids.indexOf('findSimilar');
      const moveIdx = ids.indexOf('moveToFolder');
      expect(findIdx).toBeGreaterThanOrEqual(0);
      expect(moveIdx).toBe(findIdx + 1);
    }
  });

  it('sidebar-specific items ("Move to folder…", "Remove from folder") are not sidebar-only anymore', () => {
    // Regression guard: if someone reverts availability to 'sidebar' on either
    // action, this test fails — which is the FOX-3071 regression direction.
    const conversationIds = getActionsForContext('conversation', allCallbacks()).map((a) => a.id);
    expect(conversationIds).toEqual(expect.arrayContaining(['moveToFolder', 'removeFromFolder']));
  });
});

describe('getActionsForContext — conversation-only items', () => {
  it('"Reveal in sidebar" is still hidden from the sidebar context', () => {
    const sidebarIds = getActionsForContext('sidebar', allCallbacks()).map((a) => a.id);
    expect(sidebarIds).not.toContain('revealInSidebar');
  });
});
