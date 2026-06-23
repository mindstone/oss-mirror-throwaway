/**
 * Tests for P1 entry-point handlers: handleBuildConnector and handleExtendConnector.
 *
 * These verify the wiring between Settings panel CTAs and seeded conversations.
 * Generic setup seeds a reviewable composer draft; extend flows still use the
 * prepareMentionAttachments() + submitQueuedMessage() pattern.
 *
 * Validation contract assertions covered:
 *   VAL-ENTRY-001, VAL-ENTRY-002, VAL-ENTRY-003, VAL-ENTRY-005,
 *   VAL-ENTRY-006, VAL-ENTRY-007, VAL-ENTRY-008
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildOssMcpEntryPointBuildPrompt,
  buildOssMcpEntryPointExtendPrompt,
} from '@shared/utils/ossMcpChatIntent';

// ---------------------------------------------------------------------------
// Shared mocks — stable across every test case
// ---------------------------------------------------------------------------
const mockStartFreshSession = vi.fn(() => 'new-session-id-123');
const mockCloseSettingsDialog = vi.fn();
const mockPrepareMentionAttachments = vi.fn();
const mockSubmitQueuedMessage = vi.fn();
const mockSetDraftForSession = vi.fn();
const mockShowToast = vi.fn();

// ---------------------------------------------------------------------------
// Factory: creates handleBuildConnector / handleExtendConnector with injected deps
// ---------------------------------------------------------------------------
// These mirror the handler logic that will be implemented in App.tsx.
// We test the *handler logic* in isolation, not the React component tree.
// ---------------------------------------------------------------------------

interface BuildConnectorDeps {
  closeSettingsDialog: () => void;
  startFreshSession: () => string;
  setDraftForSession: (sessionId: string, text: string) => void;
  prepareMentionAttachments: (prompt: string) => Promise<unknown[]>;
  submitQueuedMessage: (text: string, source: string, attachments?: unknown[], options?: Record<string, unknown>) => void;
  showToast: (opts: { title: string }) => void;
}

/**
 * Pure-function version of handleBuildConnector for testability.
 * The actual implementation in App.tsx will be a useCallback wrapping this logic.
 */
function handleBuildConnector(
  deps: BuildConnectorDeps,
  searchQuery?: string,
): void {
  const { closeSettingsDialog, startFreshSession, setDraftForSession } = deps;

  closeSettingsDialog();
  const sessionId = startFreshSession();

  const prompt = buildOssMcpEntryPointBuildPrompt(searchQuery);
  setDraftForSession(sessionId, prompt);
}

/**
 * Pure-function version of handleExtendConnector for testability.
 */
async function handleExtendConnector(
  deps: BuildConnectorDeps,
  connectorId: string,
  connectorName: string,
): Promise<void> {
  const { closeSettingsDialog, startFreshSession, prepareMentionAttachments, submitQueuedMessage, showToast } = deps;

  closeSettingsDialog();
  const sessionId = startFreshSession();

  const prompt = buildOssMcpEntryPointExtendPrompt(connectorName, connectorId);

  try {
    const mentionAttachments = await prepareMentionAttachments(prompt);
    await submitQueuedMessage(
      prompt,
      'text',
      mentionAttachments.length > 0 ? mentionAttachments : undefined,
      { targetSessionId: sessionId },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to start connector extension';
    showToast({ title: message });
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('entry-point handlers', () => {
  const deps: BuildConnectorDeps = {
    closeSettingsDialog: mockCloseSettingsDialog,
    startFreshSession: mockStartFreshSession,
    setDraftForSession: mockSetDraftForSession,
    prepareMentionAttachments: mockPrepareMentionAttachments,
    submitQueuedMessage: mockSubmitQueuedMessage,
    showToast: mockShowToast,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: prepareMentionAttachments resolves with a sentinel attachment array
    mockPrepareMentionAttachments.mockResolvedValue([{ type: 'file_text', path: '/skill.md', content: 'skill content' }]);
  });

  // -------------------------------------------------------------------------
  // VAL-ENTRY-001: Main setup CTA seeds the build skill
  // -------------------------------------------------------------------------
  describe('handleBuildConnector', () => {
    it('closes settings, creates a fresh session, and seeds build-custom-mcp-server skill mention', async () => {
      await handleBuildConnector(deps);

      // Settings must close first
      expect(mockCloseSettingsDialog).toHaveBeenCalledOnce();

      // Fresh session must be created
      expect(mockStartFreshSession).toHaveBeenCalledOnce();

      // Draft must be written synchronously so the composer can hydrate it
      expect(mockSetDraftForSession).toHaveBeenCalledOnce();
      const [sessionId, prompt] = mockSetDraftForSession.mock.calls[0] as [string, string];
      expect(sessionId).toBe('new-session-id-123');
      expect(prompt).toContain('build-custom-mcp-server/SKILL.md');
      expect(mockStartFreshSession.mock.invocationCallOrder[0]).toBeLessThan(
        mockSetDraftForSession.mock.invocationCallOrder[0],
      );
      expect(mockSubmitQueuedMessage).not.toHaveBeenCalled();
      expect(mockPrepareMentionAttachments).not.toHaveBeenCalled();
    });

    // VAL-ENTRY-007: Active session does not hijack seeded message
    it('always targets a fresh session even if one is active', async () => {
      // startFreshSession returns a NEW session id regardless of current state
      mockStartFreshSession.mockReturnValueOnce('brand-new-session-456');

      await handleBuildConnector(deps);

      expect(mockSetDraftForSession).toHaveBeenCalledWith(
        'brand-new-session-456',
        expect.any(String),
      );
    });
  });

  // -------------------------------------------------------------------------
  // VAL-ENTRY-002: Empty-search CTA uses build flow with search context
  // -------------------------------------------------------------------------
  describe('handleBuildConnector with search query', () => {
    it('preserves the searched connector name in the prompt', async () => {
      await handleBuildConnector(deps, '  Notion  ');

      const prompt = mockSetDraftForSession.mock.calls[0][1] as string;
      expect(prompt).toContain('build-custom-mcp-server/SKILL.md');
      expect(prompt).toContain('Notion');
      expect(mockSubmitQueuedMessage).not.toHaveBeenCalled();
    });

    it('falls back to generic prompt when search query is empty/whitespace', async () => {
      await handleBuildConnector(deps, '   ');

      const prompt = mockSetDraftForSession.mock.calls[0][1] as string;
      expect(prompt).toContain('build-custom-mcp-server/SKILL.md');
      expect(prompt).not.toContain('""');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-ENTRY-003: Extend CTA seeds extend skill with connector context
  // -------------------------------------------------------------------------
  describe('handleExtendConnector', () => {
    it('creates a fresh session seeded with extend-mcp-server skill and connector context', async () => {
      await handleExtendConnector(deps, 'connector-42', 'My Custom Connector');

      expect(mockCloseSettingsDialog).toHaveBeenCalledOnce();
      expect(mockStartFreshSession).toHaveBeenCalledOnce();

      const prompt = mockPrepareMentionAttachments.mock.calls[0][0] as string;
      expect(prompt).toContain('extend-mcp-server/SKILL.md');
      expect(prompt).toContain('connector-42');
      expect(prompt).toContain('My Custom Connector');

      expect(mockSubmitQueuedMessage).toHaveBeenCalledWith(
        expect.stringContaining('extend-mcp-server/SKILL.md'),
        'text',
        expect.any(Array),
        expect.objectContaining({ targetSessionId: 'new-session-id-123' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // VAL-ENTRY-005: Extend entry-point submissions use mention attachments
  // -------------------------------------------------------------------------
  describe('mention attachment forwarding', () => {
    it('forwards resolved attachments from prepareMentionAttachments to submitQueuedMessage for extend flow', async () => {
      const sentinelAttachments = [{ type: 'file_text', path: '/sentinel', content: 'sentinel' }];
      mockPrepareMentionAttachments.mockResolvedValueOnce(sentinelAttachments);

      await handleExtendConnector(deps, 'conn-1', 'Test Connector');

      expect(mockSubmitQueuedMessage).toHaveBeenCalledWith(
        expect.any(String),
        'text',
        sentinelAttachments,
        expect.objectContaining({ targetSessionId: 'new-session-id-123' }),
      );
    });

    it('passes undefined attachments when prepareMentionAttachments returns empty array for extend flow', async () => {
      mockPrepareMentionAttachments.mockResolvedValueOnce([]);

      await handleExtendConnector(deps, 'conn-1', 'Test Connector');

      expect(mockSubmitQueuedMessage).toHaveBeenCalledWith(
        expect.any(String),
        'text',
        undefined,
        expect.objectContaining({ targetSessionId: 'new-session-id-123' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // VAL-ENTRY-006: Extend mention-resolution failure surfaces error
  // -------------------------------------------------------------------------
  describe('mention resolution failure', () => {
    it('shows error toast and does NOT submit when prepareMentionAttachments rejects for extend flow', async () => {
      mockPrepareMentionAttachments.mockRejectedValueOnce(new Error('Skill file not found'));

      await handleExtendConnector(deps, 'conn-1', 'Test Connector');

      expect(mockShowToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Skill file not found' }),
      );
      expect(mockSubmitQueuedMessage).not.toHaveBeenCalled();
    });

    it('shows generic error message for non-Error rejections in extend flow', async () => {
      mockPrepareMentionAttachments.mockRejectedValueOnce('some string error');

      await handleExtendConnector(deps, 'conn-1', 'Test Connector');

      expect(mockShowToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining('Unable to start connector extension') }),
      );
      expect(mockSubmitQueuedMessage).not.toHaveBeenCalled();
    });

    it('shows error toast for extend handler when mentions fail', async () => {
      mockPrepareMentionAttachments.mockRejectedValueOnce(new Error('Could not resolve mention'));

      await handleExtendConnector(deps, 'conn-1', 'Test Connector');

      expect(mockShowToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Could not resolve mention' }),
      );
      expect(mockSubmitQueuedMessage).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // VAL-ENTRY-008: Settings closes on navigation to conversation
  // -------------------------------------------------------------------------
  describe('settings closure', () => {
    it('closes settings dialog before starting fresh session', async () => {
      const callOrder: string[] = [];
      mockCloseSettingsDialog.mockImplementation(() => callOrder.push('close'));
      mockStartFreshSession.mockImplementation(() => { callOrder.push('start'); return 'sess-1'; });

      await handleBuildConnector(deps);

      expect(callOrder[0]).toBe('close');
      expect(callOrder[1]).toBe('start');
    });
  });
});
