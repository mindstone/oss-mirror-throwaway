/**
 * HomepageChat - Hero chat input for homepage
 *
 * Prominent input matching AutomationsPanel hero input style.
 * On submit: creates a new conversation session, navigates to sessions surface.
 * Below the input: recent conversation pills + history link when history exists.
 *
 * Uses MentionHeroInput for @mention autocomplete support (skills, files, conversations).
 */

import { useState, useCallback, useMemo, useRef } from 'react';
import { useSessionStore } from '../../agent-session/store/sessionStore';
import { MentionHeroInput, type MentionHeroInputProps } from '../../composer/components/MentionHeroInput';
import { useFileAttachments, type FileAttachment } from '../../composer/hooks/useFileAttachments';
import { useTranscriptionMic } from '../../composer/hooks/useTranscriptionMic';
import { Button, ConversationPill, useToast } from '@renderer/components/ui';
import { tracking } from '@renderer/src/tracking';
import { isBackgroundConversationSession } from '@shared/sessionKind';
import styles from './HomepageChat.module.css';

const MAX_RECENT_PILLS = 5;

/** Mention-related props passed through from HomepagePanel */
export type HomepageChatMentionProps = Pick<
  MentionHeroInputProps,
  | 'mentionResultsForQuery'
  | 'ensureLibraryIndex'
  | 'getRelativeLibraryPath'
  | 'hasWorkspace'
  | 'hasConversations'
  | 'coreDirectory'
  | 'libraryIndex'
  | 'libraryIndexLoading'
  | 'libraryIndexError'
  | 'refreshLibraryIndex'
>;

interface HomepageChatProps extends HomepageChatMentionProps {
  onSubmit: (prompt: string, attachments?: FileAttachment[]) => void;
  onNavigateToSessions: () => void;
  onOpenSession?: (sessionId: string) => void;
}

export function HomepageChat({
  onSubmit,
  onNavigateToSessions,
  onOpenSession,
  mentionResultsForQuery,
  ensureLibraryIndex,
  getRelativeLibraryPath,
  hasWorkspace,
  hasConversations,
  coreDirectory,
  libraryIndex,
  libraryIndexLoading,
  libraryIndexError,
  refreshLibraryIndex,
}: HomepageChatProps) {
  const [value, setValue] = useState('');
  const { showToast } = useToast();
  const valueRef = useRef(value);
  valueRef.current = value;

  const {
    attachments,
    addFromClipboard,
    addFromFileList,
    removeAttachment,
    clearAttachments,
    canAddMore,
    isDragging,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
  } = useFileAttachments({ onError: (msg) => showToast({ title: msg }) });

  const sessionSummaries = useSessionStore((s) => s.sessionSummaries);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const recentSessions = useMemo(() => {
    return sessionSummaries
      .filter((s) => {
        if (s.id === currentSessionId) return false;
        if (s.deletedAt) return false;
        if (s.isCorrupted) return false;
        if (s.messageCount === 0) return false;
        if (isBackgroundConversationSession(s.id)) return false;
        return true;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_RECENT_PILLS);
  }, [sessionSummaries, currentSessionId]);

  const submitPrompt = useCallback((prompt: string) => {
    const trimmed = prompt.trim();
    const currentAttachments = attachmentsRef.current.length > 0
      ? [...attachmentsRef.current]
      : undefined;
    if (!trimmed && !currentAttachments) return;
    tracking.homepage.messageSubmitted(trimmed.length, trimmed.includes('@'));
    onSubmit(trimmed, currentAttachments);
    setValue('');
    clearAttachments();
  }, [onSubmit, clearAttachments]);

  const handleSubmit = useCallback(() => {
    submitPrompt(valueRef.current);
  }, [submitPrompt]);

  const handleTranscript = useCallback((text: string) => {
    setValue((prev) => (prev ? `${prev} ${text}` : text));
  }, []);

  const handleTranscriptAndSend = useCallback((text: string) => {
    const nextValue = valueRef.current ? `${valueRef.current} ${text}` : text;
    submitPrompt(nextValue);
  }, [submitPrompt]);

  const {
    isRecording,
    isProcessing: isTranscribeProcessing,
    toggleRecording,
    stopAndSend,
    audioLevel,
  } = useTranscriptionMic({
    currentSessionId: currentSessionId ?? 'homepage-chat',
    onTranscript: handleTranscript,
    onTranscriptAndSend: handleTranscriptAndSend,
    onError: (message) => showToast({ title: message, variant: 'error' }),
  });

  const handleAddFiles = useCallback(
    async (files: FileList) => { await addFromFileList(files); },
    [addFromFileList],
  );

  const attachmentPropsForInput = useMemo(() => ({
    attachments,
    onAddFiles: handleAddFiles,
    onRemoveAttachment: removeAttachment,
    onPasteAttachment: addFromClipboard,
    canAddMore,
    isDragging,
    onDragEnter: handleDragEnter,
    onDragLeave: handleDragLeave,
    onDragOver: handleDragOver,
    onDrop: handleDrop,
  }), [attachments, handleAddFiles, removeAttachment, addFromClipboard, canAddMore, isDragging, handleDragEnter, handleDragLeave, handleDragOver, handleDrop]);

  const voiceButtonProps = useMemo(() => ({
    isRecording,
    isProcessing: isTranscribeProcessing,
    disabled: isTranscribeProcessing,
    audioLevel,
    onToggle: toggleRecording,
    onStopAndSend: stopAndSend,
  }), [isRecording, isTranscribeProcessing, audioLevel, toggleRecording, stopAndSend]);

  const handleSessionClick = useCallback(
    (sessionId: string, position: number) => {
      tracking.homepage.recentSessionClicked(position);
      onOpenSession?.(sessionId);
    },
    [onOpenSession]
  );

  const shouldShowHistoryRow = recentSessions.length > 0;

  const handleHistoryClick = useCallback(() => {
    tracking.homepage.historyLinkClicked();
    onNavigateToSessions();
  }, [onNavigateToSessions]);

  return (
    <div className={styles.chatSection}>
      {/* Hero Input — with @mention autocomplete */}
      <MentionHeroInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder="Tell me what you need..."
        ariaLabel="Message input"
        submitAriaLabel="Send message"
        attachmentProps={attachmentPropsForInput}
        voiceButtonProps={voiceButtonProps}
        mentionResultsForQuery={mentionResultsForQuery}
        ensureLibraryIndex={ensureLibraryIndex}
        getRelativeLibraryPath={getRelativeLibraryPath}
        hasWorkspace={hasWorkspace}
        hasConversations={hasConversations}
        coreDirectory={coreDirectory}
        libraryIndex={libraryIndex}
        libraryIndexLoading={libraryIndexLoading}
        libraryIndexError={libraryIndexError}
        refreshLibraryIndex={refreshLibraryIndex}
      />

      {shouldShowHistoryRow && (
        <div className={styles.pillRow}>
          {recentSessions.map((session, index) => (
            <ConversationPill
              key={session.id}
              title={session.title || 'Untitled conversation'}
              onClick={() => handleSessionClick(session.id, index)}
            />
          ))}
          {recentSessions.length >= MAX_RECENT_PILLS && (
            <span className={styles.pillOverflow}>...</span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.historyLink}
            onClick={handleHistoryClick}
          >
            View conversation history
          </Button>
        </div>
      )}
    </div>
  );
}
