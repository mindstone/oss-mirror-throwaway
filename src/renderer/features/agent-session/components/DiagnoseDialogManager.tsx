/**
 * DiagnoseDialogManager
 *
 * Owns the diagnose-conversation state, handlers, and dialog JSX.
 * Extracted from App.tsx to remove 3 useState, 2 useCallback, and dialog
 * JSX from the main render path.
 *
 * State communicated back to App.tsx:
 * - `handleStartDiagnose` via useImperativeHandle (consumed by ConversationActionsMenu
 *   and AgentSessionSidebar in App.tsx)
 */

import { forwardRef, memo, useCallback, useImperativeHandle, useState } from 'react';
import type { ToastMessage } from '@renderer/contexts';
import type { AgentSessionSummary, AnyAttachmentPayload } from '@shared/types';
import { fireAndForget } from '@shared/utils/fireAndForget';
import type { FlowSurface } from '@renderer/features/flow-panels/FlowPanelsProvider';
import { getSessionStoreState } from '../store';
import { DiagnoseDialog } from './DiagnoseDialog';

// ─── Public ref handle ──────────────────────────────────────────────────────
export interface DiagnoseDialogManagerRef {
  handleStartDiagnose: (sessionId: string) => void;
}

// ─── Props ──────────────────────────────────────────────────────────────────
export interface DiagnoseDialogManagerProps {
  sessionSummaries: AgentSessionSummary[];
  currentSessionId: string;
  currentSessionTitle: string | null;
  resetSessionState: () => string;
  setActiveSurface: (s: FlowSurface) => void;
  setShowConversation: (b: boolean) => void;
  showToast: (message: ToastMessage) => void;
  submitQueuedMessage: (
    text: string,
    source?: 'text' | 'voice',
    attachments?: AnyAttachmentPayload[],
    options?: { targetSessionId?: string },
  ) => void;
}

// ─── Component ──────────────────────────────────────────────────────────────
const DiagnoseDialogManagerInner = forwardRef<DiagnoseDialogManagerRef, DiagnoseDialogManagerProps>(
  function DiagnoseDialogManager(
    {
      sessionSummaries,
      currentSessionId,
      currentSessionTitle,
      resetSessionState,
      setActiveSurface,
      setShowConversation,
      showToast,
      submitQueuedMessage,
    },
    ref,
  ) {
    // ─── State ────────────────────────────────────────────────────────────
    const [diagnosePickerOpen, setDiagnosePickerOpen] = useState(false);
    const [diagnoseSessionId, setDiagnoseSessionId] = useState<string | null>(null);
    const [diagnoseSessionTitle, setDiagnoseSessionTitle] = useState<string>('Conversation');

    // ─── Handlers ─────────────────────────────────────────────────────────

    // Start diagnosing a conversation (opens quick picker)
    const handleStartDiagnose = useCallback(
      (sessionId: string) => {
        const summary = sessionSummaries.find((s) => s.id === sessionId);
        const title = sessionId === currentSessionId
          ? currentSessionTitle ?? 'Conversation'
          : summary?.title ?? 'Conversation';
        setDiagnoseSessionId(sessionId);
        setDiagnoseSessionTitle(title);
        setDiagnosePickerOpen(true);
      },
      [sessionSummaries, currentSessionId, currentSessionTitle],
    );

    // Execute diagnosis after user provides optional description
    const handleDiagnoseConfirm = useCallback(
      async (userDescription: string) => {
        if (!diagnoseSessionId) return;

        try {
          // Get diagnostic summary from main process
          const result = await window.sessionsApi.getDiagnosticSummary({ sessionId: diagnoseSessionId });
          if (!result.summary) {
            showToast({ title: result.error || 'Could not load conversation data' });
            return;
          }

          const summary = result.summary;

          // Try to load the diagnose-conversation skill for comprehensive guidance
          let skillContent: string | null = null;
          try {
            const skillResult = await window.libraryApi.readFile(
              'rebel-system/skills/operations/diagnose-conversation/SKILL.md',
            );
            if (skillResult?.content) {
              // Strip YAML frontmatter if present
              skillContent = skillResult.content.replace(/^---[\s\S]*?---\n*/m, '').trim();
            }
          } catch {
            // Skill file not available - continue without it
          }

          // Build the diagnostic prompt with optional user context
          const userContext = userDescription
            ? `\n\nThe user describes the problem as: ${JSON.stringify(userDescription)}`
            : '';

          // Build log file hint - logs are stored per-turn, need to search by turnId
          // Dedupe turn IDs and prioritize error turns
          const errorTurnIds = summary.recentMessages.filter((m) => m.hasErrors).map((m) => m.turnId);
          const allTurnIds = [...new Set(summary.recentMessages.map((m) => m.turnId).filter(Boolean))];
          const relevantTurnIds = errorTurnIds.length > 0 ? errorTurnIds : allTurnIds;

          const logHint =
            summary.paths.sessionLogsDir && relevantTurnIds.length > 0
              ? `Session logs directory: ${summary.paths.sessionLogsDir}. Use LS to list files, then Read matching ones. Files are named "<timestamp>-turn-<turnId>.log". Relevant turn IDs: ${relevantTurnIds.join(', ')}`
              : 'Session logs are not available';

          // Build final prompt - include skill instructions if available
          const skillSection = skillContent
            ? `\n<diagnose-skill>\n${skillContent}\n</diagnose-skill>\n\nFollow the skill instructions above for your analysis approach and output format.`
            : '\nAnalyze this conversation and tell me what went wrong.';

          const diagnosticPrompt = `Help me understand what went wrong in my conversation "${summary.sessionTitle}".${userContext}

Rebel conversation ID: ${summary.sessionId}
Rebel conversation link: ${summary.rebelConversationLink}

<diagnostic-context>
${JSON.stringify(summary, null, 2)}
</diagnostic-context>
${skillSection}

You can use Read to investigate:
- ${logHint}`;

          // Start a new conversation with the diagnostic prompt
          const sessionId = resetSessionState();
          setActiveSurface('sessions');
          setShowConversation(true);

          // Update the session title
          getSessionStoreState().setCurrentSessionMeta({ currentSessionTitle: `Diagnosing: ${summary.sessionTitle}` });

          // CRITICAL: Pass targetSessionId explicitly because submitQueuedMessage's currentSessionId
          // closure is stale after resetSessionState() - React hasn't re-rendered yet.
          fireAndForget(submitQueuedMessage(diagnosticPrompt, 'text', undefined, { targetSessionId: sessionId }), 'diagnoseConversation');

          showToast({ title: 'Starting diagnosis...' });
        } catch (err) {
          console.error('[App] Diagnose conversation failed:', err);
          showToast({ title: 'Failed to start diagnosis' });
        }
      },
      [diagnoseSessionId, resetSessionState, setActiveSurface, setShowConversation, showToast, submitQueuedMessage],
    );

    // ─── Expose handleStartDiagnose via ref ───────────────────────────────
    useImperativeHandle(
      ref,
      () => ({
        handleStartDiagnose,
      }),
      [handleStartDiagnose],
    );

    // ─── Render ───────────────────────────────────────────────────────────
    return (
      <DiagnoseDialog
        open={diagnosePickerOpen}
        onOpenChange={setDiagnosePickerOpen}
        sessionTitle={diagnoseSessionTitle}
        onConfirm={handleDiagnoseConfirm}
      />
    );
  },
);

export const DiagnoseDialogManager = memo(DiagnoseDialogManagerInner);
