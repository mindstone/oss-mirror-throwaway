import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { basename, extname, isAbsolute, join, normalize, relative } from 'pathe';
import {
  getFileCategory,
  getImageMimeType,
  isMarkdownPath,
} from '@renderer/utils/documentUtils';
import { writeFileOrFail } from '@renderer/utils/libraryWrites';
import type { FileCategory } from '@renderer/utils/documentUtils';
import { debounce } from '@shared/utils/debounce';
import {
  ACTIONABLE_WRITE_ERRNOS,
  WriteFailureError,
  classifySafeError,
  errnoToUserMessage,
  writeErrorToUserMessage,
  type SafeErrorClassifier,
} from '@shared/utils/documentIoErrorClassification';
import { formatSaveTimestamp } from '@renderer/utils/formatters';
import { useTimeoutRef } from '@renderer/hooks/useTimeoutRef';
import { getMediaProtocolUrl } from '../utils/protocolUrls';
import { tracking } from '@renderer/src/tracking';
import { sha256HexUtf8 } from '@renderer/utils/sha256Hex';
import type { EmitLogFn } from '@renderer/contexts';
import { stripAnnotationComment } from '../../library/utils/annotationPersistence';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ImageLoadState = {
  loading: boolean;
  error: string | null;
  dataUrl: string | null;
  dimensions: { width: number; height: number } | null;
};

export type MediaLoadState = {
  loading: boolean;
  error: string | null;
  mediaUrl: string | null;
};

/**
 * A function that merges the current annotation block into the document
 * content. Provided by the annotation hook's `captureIntoContent`.
 */
export type CaptureIntoContentFn = (content: string) => string;

export interface SharedSkillSaveProtection {
  skillRelativePath: string;
  authorLabel: string;
  copy: string;
}

export interface PendingApprovalInfo {
  type: 'staged-file';
  id: string;
  summary: string;
  spaceName: string;
  fileName: string;
  realPath: string;
  stagedAt: number;
}

type LibraryChangeWriterKind = 'editor' | 'agent' | 'file-watcher' | 'cloud-sync';

type LibraryChangedPayload = {
  timestamp: number;
  affectsTree: boolean;
  writerKind?: LibraryChangeWriterKind;
  changedPath?: string;
};

type ReadFileBase64Payload = string | {
  base64: string;
  mtimeMs: number;
  size: number;
};

const readFileBase64ToString = (payload: ReadFileBase64Payload): string =>
  typeof payload === 'string' ? payload : payload.base64;

export interface DocumentWriteConflict {
  /** Content currently on disk (from the external writer) */
  diskContent: string;
  /** Hash of the disk content */
  diskHash: string;
  /** When the conflict was detected */
  detectedAt: number;
  /** Writer identity from the latest library:changed payload, when available. */
  writerKind?: LibraryChangeWriterKind;
}

export interface UseDocumentFileIOOptions {
  documentPath: string | null;
  showToast?: (options: {
    title: string;
    description?: string;
    variant?: 'default' | 'error';
  }) => void;
  /**
   * Structured log sink. When provided, flush-on-clear write failures
   * are surfaced via `emitLog({ level: 'error', ... })` so the issue is
   * observable without relying on the caller to re-log. Defaults to a
   * `console.error` fallback so the failure is never silent. See
   * `docs/plans/260417_centralize_annotations_and_fix_document_send_clear.md`.
   */
  emitLog?: EmitLogFn;
  sharedSkillSaveProtection?: SharedSkillSaveProtection | null;
  /** Called after a successful annotation write (debounced or immediate) completes.
   *  Wire to `editorResult.annotations.commitAnnotationBlock` so the annotation
   *  hook knows the block on disk is up-to-date. */
  onAnnotationWriteCommitted?: (writtenContent: string) => void;
}

export interface UseDocumentFileIOResult {
  // Content state
  content: string | null;
  loading: boolean;
  error: string | null;
  fileCategory: FileCategory;
  isMarkdownFile: boolean;
  fileName: string;

  // Image/media state
  imageState: ImageLoadState;
  mediaState: MediaLoadState;
  setMediaState: React.Dispatch<React.SetStateAction<MediaLoadState>>;

  // Edit mode
  isEditing: boolean;
  editContent: string;
  isDirty: boolean;
  isSaving: boolean;
  justSaved: boolean;
  statusText: string;
  setEditContent: (content: string) => void;
  setIsEditing: (editing: boolean) => void;
  conflictState: DocumentWriteConflict | null;

  // Save operations
  save: () => Promise<void>;
  /**
   * Persists pending edits (debounced annotations + edit-content)
   * before destructive navigation. Rejects when any underlying write
   * fails — callers MUST await and abort the destructive action on
   * rejection. Class B telemetry + toast are emitted at the failure site;
   * the rejection is the propagation signal, not a second user-facing
   * message.
   *
   * See `docs/plans/260429_document_io_class_a_batch_1_data_loss_propagation.md`.
   */
  flush: () => Promise<void>;
  persistCurrentContentNow: () => Promise<void>;
  resolveConflict: (resolution: 'keep-editor' | 'keep-disk') => Promise<void>;
  cancelLoad: () => void;
  prepareForExternalCommit: () => boolean;
  cancelExternalCommit: () => void;

  // Paths
  absolutePath: string | null;
  relativePath: string | null;

  // Annotation persistence coordination
  handleAnnotationContentChange: (newContent: string) => void;
  handleEditorBodyChange: (full: string) => void;
  applyExternalCommittedContent: (content: string) => void;
  /**
   * Immediately persists pending annotations to disk (cancels the
   * 500ms debounce). Rejects when the write fails — callers
   * (handleOpenLinkedFile, handleOpenInLibrary) MUST await and abort
   * navigation on rejection. Class B telemetry + toast already fire
   * at the failure site (gated by `shouldSurfaceFailure` for stale-doc /
   * unmount); the rejection is the propagation signal, not a second
   * user-facing message.
   *
   * See `docs/plans/260429_document_io_class_a_batch_1_data_loss_propagation.md`.
   */
  persistAnnotationsNow: (captureIntoContent: CaptureIntoContentFn) => Promise<void>;
  /**
   * Immediately write `content` to disk, bypassing the 500ms annotation
   * debounce. Used by the per-message `onCommit` closure in
   * `DocumentFooter` to flush the post-clear annotation state synchronously
   * — otherwise an in-flight debounced write could land AFTER the clear
   * and resurrect the annotations.
   *
   * Fails loud: on write error the hook emits an `error`-level log via
   * the `emitLog` option (or `console.error` fallback) AND rejects the
   * returned promise so the caller can branch on failure. No silent
   * `.catch(() => ...)`.
   */
  flushAnnotationWriteNow: (content: string) => Promise<void>;
  sharedSkillSaveProtection: SharedSkillSaveProtection | null;
  needsSharedSkillSaveConfirmation: boolean;
  confirmSharedSkillDirectSave: () => Promise<void>;

  // Pending approval state (staged file detected instead of ENOENT error)
  pendingApproval: PendingApprovalInfo | null;
  approvePending: () => Promise<boolean>;
  denyPending: () => Promise<boolean>;

  /**
   * Ref for registering a capture function that merges annotations from
   * ProseMirror state into content. Used by flush() and unmount cleanup
   * to bypass the async React state pipeline.
   *
   * Set this from the consumer (UnifiedDocumentEditor) — do NOT null it
   * on cleanup, as unmount flush needs it after child cleanups run.
   */
  captureIntoContentRef: React.MutableRefObject<CaptureIntoContentFn | null>;
}

// ---------------------------------------------------------------------------
// Internal state types
// ---------------------------------------------------------------------------

type LoadState = {
  loading: boolean;
  error: string | null;
  content: string | null;
};

const INITIAL_LOAD_STATE: LoadState = { loading: false, error: null, content: null };
const INITIAL_IMAGE_STATE: ImageLoadState = { loading: false, error: null, dataUrl: null, dimensions: null };
const INITIAL_MEDIA_STATE: MediaLoadState = { loading: false, error: null, mediaUrl: null };

const AUTO_SAVE_DELAY = 1400;
const ANNOTATION_DEBOUNCE_DELAY = 500;
const JUST_SAVED_DURATION = 2000;
const WRITE_CONFLICT_MESSAGE = 'This shared skill changed elsewhere. Reload it before saving again.';

function isMissingFileError(message: string): boolean {
  return /\bENOENT\b|no such file or directory/i.test(message);
}

function formatDocumentLoadError(message: string): string {
  if (isMissingFileError(message)) {
    return 'This file is not available. It may have been moved, deleted, or the write did not finish. Close this tab and generate it again if you still need it.';
  }
  return message;
}

/**
 * Compare document bodies ignoring trailing annotation blocks.
 * Annotations are a persistence detail, not user edits — they should
 * not prevent the editor from accepting external file changes.
 */
export function isEditorBodyUnchanged(editorContent: string, previousDiskContent: string): boolean {
  return stripAnnotationComment(editorContent).trim() === stripAnnotationComment(previousDiskContent).trim();
}

/**
 * Privacy-safe document scope classifier for telemetry. Distinguishes
 * shared-skill-guarded paths (CAS-enforced via sharedSkillMutationService)
 * from workspace-relative and absolute paths, without leaking the path itself.
 */
type DocumentScope = 'shared-skill-guarded' | 'workspace-relative' | 'absolute' | 'unknown';

function classifyDocumentScope(path: string | null, isSharedSkillGuarded: boolean): DocumentScope {
  if (!path) return 'unknown';
  if (isSharedSkillGuarded) return 'shared-skill-guarded';
  return isAbsolute(path) ? 'absolute' : 'workspace-relative';
}

/**
 * Privacy-safe file-extension classifier for telemetry. Returns the lowercased
 * extension without the leading dot, or `'none'` when no extension is present.
 * Extensions are not user content — useful for distinguishing markdown vs
 * code-file conflict patterns without leaking filenames.
 */
function classifyFileExtension(path: string | null): string {
  if (!path) return 'unknown';
  const ext = extname(path).toLowerCase().replace(/^\./, '');
  return ext.length > 0 ? ext : 'none';
}

function toWorkspaceRelativeIfInside(targetPath: string, workspaceRoot: string | null): string {
  const normalizedTargetPath = normalize(targetPath);
  if (!workspaceRoot || !isAbsolute(normalizedTargetPath)) {
    return normalizedTargetPath;
  }

  const normalizedWorkspaceRoot = normalize(workspaceRoot);
  const workspaceRelative = normalize(relative(normalizedWorkspaceRoot, normalizedTargetPath));
  if (!workspaceRelative || workspaceRelative === '.' || workspaceRelative.startsWith('..')) {
    return normalizedTargetPath;
  }
  return workspaceRelative;
}

function isSameDocumentPath(currentPath: string, changedPath: string, workspaceRoot: string | null): boolean {
  const normalizedCurrentPath = normalize(currentPath);
  const normalizedChangedPath = normalize(changedPath);
  if (normalizedCurrentPath === normalizedChangedPath) {
    return true;
  }

  return (
    toWorkspaceRelativeIfInside(normalizedCurrentPath, workspaceRoot)
    === toWorkspaceRelativeIfInside(normalizedChangedPath, workspaceRoot)
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Encapsulates the full document file lifecycle — loading (text, image, media),
 * saving, auto-save, external change detection, edit mode, stale write
 * prevention, and annotation persistence coordination.
 *
 * Unifies the file I/O from DocumentPreviewDrawer and useLibraryDocuments into
 * a single hook for the unified document editor.
 */
export function useDocumentFileIO({
  documentPath,
  showToast,
  emitLog,
  sharedSkillSaveProtection,
  onAnnotationWriteCommitted,
}: UseDocumentFileIOOptions): UseDocumentFileIOResult {
  // -------------------------------------------------------------------------
  // Core state
  // -------------------------------------------------------------------------
  const [loadState, setLoadState] = useState<LoadState>(INITIAL_LOAD_STATE);
  const [imageState, setImageState] = useState<ImageLoadState>(INITIAL_IMAGE_STATE);
  const [mediaState, setMediaState] = useState<MediaLoadState>(INITIAL_MEDIA_STATE);

  // Pending approval state (staged file matched on ENOENT)
  const [pendingApproval, setPendingApproval] = useState<PendingApprovalInfo | null>(null);
  const [loadTrigger, setLoadTrigger] = useState(0);

  // Edit mode
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [externalCommitInFlight, setExternalCommitInFlight] = useState(false);
  const [conflictState, setConflictState] = useState<DocumentWriteConflict | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | undefined>(undefined);
  const [sharedSkillSaveConfirmedForPath, setSharedSkillSaveConfirmedForPath] = useState<string | null>(null);
  const justSavedTimer = useTimeoutRef();

  // Settings (for absolutePath computation).
  // Stored as both ref (for use in non-reactive paths like load effect) and state
  // (for reactive `absolutePath` memo). The ref is authoritative; state syncs on fetch.
  const coreDirectoryRef = useRef<string | null>(null);
  const [coreDirectory, setCoreDirectory] = useState<string | null>(null);

  // Abort controller for in-flight loads
  const abortControllerRef = useRef<AbortController | null>(null);

  // Stale write prevention — prevents writes to a path that has since changed
  const currentDocPathRef = useRef<string | null>(documentPath);
  const docGenerationRef = useRef(0);

  // Annotation capture function — set by the consumer so flush() and
  // unmount cleanup can read annotations directly from ProseMirror state,
  // bypassing the async React setState pipeline that causes stale editContent.
  const captureIntoContentRef = useRef<CaptureIntoContentFn | null>(null);

  // Annotation debounce coordination
  const pendingAnnotationWriteRef = useRef(false);
  const latestAnnotationContentRef = useRef<string | null>(null);
  // Tracks the in-flight debounced annotation write so flush() can await it
  // and propagate rejection to the caller. Cleared in the inner fn's
  // .finally() so a fresh debounce starts clean.
  const debouncedWritePromiseRef = useRef<Promise<void> | null>(null);
  // Sticky "last annotation write failed" flag. Set by the debounced
  // catch (or persistAnnotationsNow catch) so a later flush() rejects
  // even when the failed write completed BEFORE the user clicked
  // navigate-away. Cleared by any successful write or document switch.
  // Class A Batch 1: closes the silent-loss path where a failed write
  // settles, clears its in-flight promise, then a fresh flush() sees
  // nothing pending and resolves cleanly. Behavioral Safety review
  // 2026-04-29.
  const annotationWriteFailedRef = useRef<Error | null>(null);
  const missedLibraryChangeRef = useRef(false);
  const missedLibraryChangePayloadRef = useRef<LibraryChangedPayload | undefined>(undefined);
  const debouncedWriteGenRef = useRef(0);

  // Ref-stable access to onAnnotationWriteCommitted (avoids stale closure)
  const onAnnotationWriteCommittedRef = useRef(onAnnotationWriteCommitted);
  onAnnotationWriteCommittedRef.current = onAnnotationWriteCommitted;

  // Re-read function ref — populated by the external change detection effect
  // so annotation completion paths can drain the missed-notification flag.
  const reloadFromDiskRef = useRef<((libraryChange?: LibraryChangedPayload) => void) | null>(null);

  // Refs for unmount dirty-content persistence (bypasses stale closure)
  const editContentRef = useRef(editContent);
  editContentRef.current = editContent;
  const isEditingRef = useRef(isEditing);
  isEditingRef.current = isEditing;
  const isSavingRef = useRef(isSaving);
  isSavingRef.current = isSaving;
  const externalCommitInFlightRef = useRef(externalCommitInFlight);
  externalCommitInFlightRef.current = externalCommitInFlight;
  const conflictStateRef = useRef<DocumentWriteConflict | null>(null);
  conflictStateRef.current = conflictState;
  const loadedContentRef = useRef(loadState.content);
  loadedContentRef.current = loadState.content;
  const externalCommitEpochRef = useRef(0);
  const sharedSkillSaveProtectionRef = useRef<SharedSkillSaveProtection | null>(sharedSkillSaveProtection ?? null);
  sharedSkillSaveProtectionRef.current = sharedSkillSaveProtection ?? null;
  const sharedSkillSaveConfirmedForPathRef = useRef<string | null>(sharedSkillSaveConfirmedForPath);
  sharedSkillSaveConfirmedForPathRef.current = sharedSkillSaveConfirmedForPath;
  const lastTrackedSharedSkillPromptPathRef = useRef<string | null>(null);
  /** SHA-256 hex of content the editor buffer is confirmed synced to (used as CAS baseline). */
  const lastSyncedBufferHashRef = useRef<string | null>(null);
  /** SHA-256 hex of content most recently observed on disk, even if buffer sync was skipped. */
  const lastObservedDiskHashRef = useRef<string | null>(null);
  /** Monotonic counter incremented on resolveConflict — stale async conflict callbacks check this to avoid resurrecting resolved conflicts. */
  const conflictEpochRef = useRef(0);

  // Lifecycle guard — flipped to false in the unmount-cleanup effect below.
  // Used by `shouldSurfaceFailure` to gate user-visible toasts and any
  // emitLog calls that could fire after the hook has unmounted.
  const isMountedRef = useRef(true);

  // Toast dedupe window for the one site that needs it: debounced annotation
  // writes (every 500ms when typing in preview mode). Single ref per mount;
  // reset to 0 on documentPath change so the window does not carry across
  // documents. See `useEffect` that resets per-document state.
  const lastAnnotationToastAtRef = useRef<number>(0);
  // Auto-save should stay quiet for non-actionable/unknown failures, but
  // disk-full / permission-style failures need one calm, useful toast per
  // failure streak. Reset on successful writes, explicit save(), and document
  // switch so the next actionable failure is visible again.
  const autoSaveActionableFailureRef = useRef<string | null>(null);

  function buildWriteFilePayload(writePath: string, content: string): { path: string; content: string; baseContentHash?: string } {
    return {
      path: writePath,
      content,
      ...(lastSyncedBufferHashRef.current ? { baseContentHash: lastSyncedBufferHashRef.current } : {}),
    };
  }

  const isConflictBlocking = useCallback((): boolean => {
    return conflictStateRef.current !== null;
  }, []);

  // -------------------------------------------------------------------------
  // Telemetry: structured emitLog events for document-write conflict
  // detection / resolution. Stable event codes for Sentry correlation.
  // Privacy: NEVER log absolute paths, basenames, content bodies, or hashes.
  // Use derived classifiers (fileCategory, fileExtension, documentScope)
  // and low-cardinality enums only.
  // See `docs/plans/finished/260427_document_write_conflict_resolution.md` Stage 5.
  // -------------------------------------------------------------------------
  const emitLogRef = useRef<EmitLogFn | undefined>(emitLog);
  emitLogRef.current = emitLog;
  // Mirror `showToast` into a ref so closures created at first render
  // (e.g. the debouncedWriteRef closure) can call the *current* parent
  // toast handler without capturing the original prop value.
  const showToastRef = useRef<UseDocumentFileIOOptions['showToast']>(showToast);
  showToastRef.current = showToast;
  const emitConflictTelemetry = useCallback((
    payload: {
      level: 'info' | 'warn' | 'error';
      message: string;
      event:
        | 'document_editor.conflict.detected'
        | 'document_editor.conflict.resolved'
        | 'document_editor.conflict.write_rejected'
        | 'document_editor.conflict.resolve_write_failed'
        | 'document_editor.conflict.materialize_failed';
      trigger?: 'library-changed' | 'auto-save-cas' | 'resolve-keep-editor';
      writerKind?: LibraryChangeWriterKind | 'unknown';
      resolution?: 'keep-editor' | 'keep-disk';
      conflictAgeMs?: number;
      bufferHashEqualsDiskHash?: boolean;
      hasCasBaseline?: boolean;
    },
  ) => {
    const sink = emitLogRef.current;
    if (!sink) return;
    sink({
      level: payload.level,
      message: payload.message,
      context: {
        event: payload.event,
        component: 'useDocumentFileIO',
        ...(payload.trigger ? { trigger: payload.trigger } : {}),
        writerKind: payload.writerKind ?? 'unknown',
        fileCategory: documentPath ? getFileCategory(documentPath) : 'unknown',
        fileExtension: classifyFileExtension(documentPath),
        documentScope: classifyDocumentScope(
          documentPath,
          sharedSkillSaveProtectionRef.current !== null,
        ),
        ...(payload.resolution ? { resolution: payload.resolution } : {}),
        ...(typeof payload.conflictAgeMs === 'number' ? { conflictAgeMs: payload.conflictAgeMs } : {}),
        ...(typeof payload.bufferHashEqualsDiskHash === 'boolean'
          ? { bufferHashEqualsDiskHash: payload.bufferHashEqualsDiskHash }
          : {}),
        ...(typeof payload.hasCasBaseline === 'boolean'
          ? { hasCasBaseline: payload.hasCasBaseline }
          : {}),
      },
    });
  }, [documentPath]);

  // -------------------------------------------------------------------------
  // Telemetry: structured emitLog events for document-IO failures.
  // Sibling helper to `emitConflictTelemetry` — separate event-code domain
  // (settings/load/write/annotation/approval) and separate context fields
  // (`operation`, `action`, `errorClassifier`). Privacy-safe by construction:
  // accepts only a low-cardinality `errorClassifier`, never raw `err.message`.
  // See `docs/plans/260428_document_io_silent_failure_sweep_class_b.md`.
  // -------------------------------------------------------------------------
  type DocumentIOEvent =
    | 'document_editor.settings_fetch_failed'
    | 'document_editor.load_recovery_failed'
    | 'document_editor.write_failed'
    | 'document_editor.annotation_write_failed'
    | 'document_editor.approval_action_failed';

  const emitDocumentIOTelemetry = useCallback((
    payload: {
      level: 'warn' | 'error';
      message: string;
      event: DocumentIOEvent;
      operation?: 'auto-save' | 'debounce' | 'persist-now' | 'flush' | 'flush-on-dispatch';
      action?: 'approve' | 'deny';
      errorClassifier?: SafeErrorClassifier;
    },
  ) => {
    const sink = emitLogRef.current;
    if (!sink) return;
    sink({
      level: payload.level,
      message: payload.message,
      context: {
        event: payload.event,
        component: 'useDocumentFileIO',
        fileCategory: documentPath ? getFileCategory(documentPath) : 'unknown',
        fileExtension: classifyFileExtension(documentPath),
        documentScope: classifyDocumentScope(
          documentPath,
          sharedSkillSaveProtectionRef.current !== null,
        ),
        ...(payload.operation ? { operation: payload.operation } : {}),
        ...(payload.action ? { action: payload.action } : {}),
        ...(payload.errorClassifier
          ? {
              errorName: payload.errorClassifier.errorName,
              errorKind: payload.errorClassifier.errorKind,
              ...(payload.errorClassifier.errorCode
                ? { errorCode: payload.errorClassifier.errorCode }
                : {}),
            }
          : {}),
      },
    });
  }, [documentPath]);

  // -------------------------------------------------------------------------
  // Lifecycle: track mounted state so async catches can avoid firing toasts
  // after unmount. `shouldSurfaceFailure` is the central guard — pair it
  // with a `pathAtCallTime` snapshot captured BEFORE the await to ensure
  // failures from a previous document never surface in the new one.
  // -------------------------------------------------------------------------
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const shouldSurfaceFailure = useCallback((pathAtCallTime: string | null): boolean => {
    if (!isMountedRef.current) return false;
    // For mount-time failures (settings, load) `pathAtCallTime` may match
    // the documentPath at the time the operation started. We only suppress
    // when documentPath has changed under us mid-flight.
    if (pathAtCallTime !== null && currentDocPathRef.current !== pathAtCallTime) return false;
    return true;
  }, []);

  // -------------------------------------------------------------------------
  // Derived values
  // -------------------------------------------------------------------------
  const fileCategory = documentPath ? getFileCategory(documentPath) : 'unsupported' as FileCategory;
  const isMarkdownFile = documentPath ? isMarkdownPath(documentPath) : false;
  const fileName = documentPath ? basename(documentPath) : '';
  const isDirty = isEditing && editContent !== loadState.content;

  const absolutePath = useMemo(() => {
    if (!documentPath) return null;
    if (isAbsolute(documentPath)) return documentPath;
    if (!coreDirectory) return null;
    return join(coreDirectory, documentPath);
  }, [documentPath, coreDirectory]);

  const relativePath = useMemo(() => {
    if (!documentPath) return null;
    if (isAbsolute(documentPath) && coreDirectory) {
      return relative(coreDirectory, documentPath);
    }
    return documentPath;
  }, [documentPath, coreDirectory]);

  const needsSharedSkillSaveConfirmation = useMemo(() => {
    if (!documentPath || !sharedSkillSaveProtection) {
      return false;
    }

    return sharedSkillSaveConfirmedForPath !== documentPath;
  }, [documentPath, sharedSkillSaveProtection, sharedSkillSaveConfirmedForPath]);

  useEffect(() => {
    if (!needsSharedSkillSaveConfirmation || !documentPath || !sharedSkillSaveProtection) {
      return;
    }
    if (lastTrackedSharedSkillPromptPathRef.current === documentPath) {
      return;
    }
    lastTrackedSharedSkillPromptPathRef.current = documentPath;
    tracking.skillCollaboration.nudgeShown({
      skillId: sharedSkillSaveProtection.skillRelativePath,
      surface: 'direct_editor',
    });
  }, [documentPath, needsSharedSkillSaveConfirmation, sharedSkillSaveProtection]);

  // -------------------------------------------------------------------------
  // Status text (matches useLibraryDocuments pattern)
  // -------------------------------------------------------------------------
  const statusText = useMemo(() => {
    if (isSaving) return 'Saving changes\u2026';
    if (isDirty) return 'Unsaved changes';
    if (loadState.loading) return 'Loading file\u2026';
    if (loadState.error) return loadState.error;
    return formatSaveTimestamp(lastSavedAt);
  }, [isSaving, isDirty, loadState.loading, loadState.error, lastSavedAt]);

  // -------------------------------------------------------------------------
  // Fetch coreDirectory once on mount.
  // Note: this effect MUST be mount-only. We deliberately inline the
  // emit-via-ref pattern instead of depending on `emitDocumentIOTelemetry`
  // (which is `useCallback([documentPath])` and would otherwise force
  // this effect to re-run on every document switch — risk of a transient
  // settings rejection clearing `coreDirectory` after it had succeeded).
  // -------------------------------------------------------------------------
  useEffect(() => {
    window.settingsApi.get().then((settings) => {
      const dir = settings.coreDirectory ?? null;
      coreDirectoryRef.current = dir;
      setCoreDirectory(dir);
    }).catch((err) => {
      coreDirectoryRef.current = null;
      setCoreDirectory(null);
      // Guard against post-unmount + emit inline using the always-current
      // emitLog ref to keep this effect mount-only.
      if (!isMountedRef.current) return;
      const sink = emitLogRef.current;
      if (!sink) return;
      const c = classifySafeError(err);
      sink({
        level: 'warn',
        message: 'Failed to fetch app settings on mount',
        context: {
          event: 'document_editor.settings_fetch_failed',
          component: 'useDocumentFileIO',
          fileCategory: 'unknown',
          fileExtension: 'unknown',
          documentScope: 'unknown',
          errorName: c.errorName,
          errorKind: c.errorKind,
          ...(c.errorCode ? { errorCode: c.errorCode } : {}),
        },
      });
    });
  }, []);

  // -------------------------------------------------------------------------
  // Debounced annotation write (500ms, preview-mode only)
  // -------------------------------------------------------------------------
  const drainMissedLibraryChange = () => {
    if (missedLibraryChangeRef.current) {
      missedLibraryChangeRef.current = false;
      const queuedLibraryChange = missedLibraryChangePayloadRef.current;
      missedLibraryChangePayloadRef.current = undefined;
      reloadFromDiskRef.current?.(queuedLibraryChange);
    }
  };

  const debouncedWriteRef = useRef<ReturnType<typeof debounce<[string, string]>> | null>(null);
  if (!debouncedWriteRef.current) {
    debouncedWriteRef.current = debounce((path: string, content: string) => {
      if (externalCommitInFlightRef.current || isConflictBlocking()) {
        pendingAnnotationWriteRef.current = false;
        drainMissedLibraryChange();
        return;
      }
      if (
        sharedSkillSaveProtectionRef.current
        && sharedSkillSaveConfirmedForPathRef.current !== path
      ) {
        pendingAnnotationWriteRef.current = false;
        drainMissedLibraryChange();
        return;
      }
      const writePromise = writeFileOrFail(buildWriteFilePayload(path, content));
      const tracked = writePromise
        .then((response) => {
          if (response.result === 'conflict') {
            throw new Error(WRITE_CONFLICT_MESSAGE);
          }
          if (response.currentHash) {
            lastSyncedBufferHashRef.current = response.currentHash;
            lastObservedDiskHashRef.current = response.currentHash;
          }
          if (externalCommitInFlightRef.current) return;
          if (docGenerationRef.current !== debouncedWriteGenRef.current) return;
          if (currentDocPathRef.current !== path) return;
          onAnnotationWriteCommittedRef.current?.(content);
          latestAnnotationContentRef.current = content;
          pendingAnnotationWriteRef.current = false;
          // Successful write clears the sticky failure flag so a later
          // flush() resolves cleanly.
          annotationWriteFailedRef.current = null;
          autoSaveActionableFailureRef.current = null;
          drainMissedLibraryChange();
          setLoadState(prev => ({ ...prev, content }));
        })
        .catch((err) => {
          pendingAnnotationWriteRef.current = false;
          // Mark the sticky failure flag so a later flush() rejects even if
          // this catch returns and the in-flight ref clears in .finally().
          // Class A Batch 1.
          annotationWriteFailedRef.current = err instanceof Error ? err : new Error(String(err));
          drainMissedLibraryChange();
          // Surface the failure as observability + user-visible toast.
          // Toast is deduped within a 5s window because the debounced
          // write fires every 500ms while typing — under a recurring
          // failure (e.g. network share dropout) we'd otherwise spam
          // the user with up to 10 toasts before the window clears.
          // emitLog still fires every time (full Sentry breadcrumb
          // history). See planning doc 260428.
          //
          // This callback is created once at first render via
          // `if (!debouncedWriteRef.current)`, so it cannot reference the
          // memoised `emitDocumentIOTelemetry`/`showToast` (those would be
          // stale). Instead read the always-current refs and emit inline.
          if (isMountedRef.current && currentDocPathRef.current === path) {
            const sink = emitLogRef.current;
            if (sink) {
              sink({
                level: 'error',
                message: 'Debounced annotation write failed',
                context: {
                  event: 'document_editor.annotation_write_failed',
                  component: 'useDocumentFileIO',
                  operation: 'debounce',
                  fileCategory: getFileCategory(path),
                  fileExtension: classifyFileExtension(path),
                  documentScope: classifyDocumentScope(
                    path,
                    sharedSkillSaveProtectionRef.current !== null,
                  ),
                  ...((): Record<string, string> => {
                    const c = classifySafeError(err);
                    return {
                      errorName: c.errorName,
                      errorKind: c.errorKind,
                      ...(c.errorCode ? { errorCode: c.errorCode } : {}),
                    };
                  })(),
                },
              });
            }
            const showToastFn = showToastRef.current;
            if (showToastFn && Date.now() - lastAnnotationToastAtRef.current > 5_000) {
              showToastFn({
                ...writeErrorToUserMessage(err),
                variant: 'error',
              });
              lastAnnotationToastAtRef.current = Date.now();
            }
          }
          throw err;
        })
        .finally(() => {
          if (debouncedWritePromiseRef.current === tracked) {
            debouncedWritePromiseRef.current = null;
          }
        });
      debouncedWritePromiseRef.current = tracked;
      // Suppress unhandled rejection on the typing-burst path when no caller
      // awaits. flush() awaits this same tracked promise when navigation needs
      // to fail closed.
      void tracked.catch(() => {
        // awaited by flush() if needed
      });
    }, ANNOTATION_DEBOUNCE_DELAY);
  }

  // Unmount: flush all pending writes (debounce + dirty edit content).
  // Uses refs for latest values to avoid stale closures.
  // captureIntoContentRef merges annotations from ProseMirror state into
  // editContent before writing — the capture function fails gracefully
  // (returns content unchanged) if the editor is already destroyed.
  useEffect(() => {
    return () => {
      if (externalCommitInFlightRef.current) {
        debouncedWriteRef.current?.cancel();
      } else {
        debouncedWriteRef.current?.flush();
      }

      const path = currentDocPathRef.current;
      if (externalCommitInFlightRef.current || isConflictBlocking()) {
        return;
      }
      if (
        sharedSkillSaveProtectionRef.current
        && sharedSkillSaveConfirmedForPathRef.current !== path
      ) {
        return;
      }

      if (path && isEditingRef.current && editContentRef.current) {
        let contentToWrite = editContentRef.current;
        // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: read at cleanup time, not setup time
        const capture = captureIntoContentRef.current;
        if (capture) {
          contentToWrite = capture(contentToWrite);
        }
        if (contentToWrite === loadedContentRef.current) {
          return;
        }
        void writeFileOrFail(buildWriteFilePayload(path, contentToWrite))
          .then((response) => {
            if (response.result === 'conflict') {
              throw new Error(WRITE_CONFLICT_MESSAGE);
            }
            if (response.currentHash) {
              lastSyncedBufferHashRef.current = response.currentHash;
              lastObservedDiskHashRef.current = response.currentHash;
            }
            autoSaveActionableFailureRef.current = null;
          })
          .catch(() => {});
      }
    };
  }, [isConflictBlocking]);

  // -------------------------------------------------------------------------
  // Reset refs and flush on document path change
  // -------------------------------------------------------------------------
  useEffect(() => {
    currentDocPathRef.current = documentPath;
    docGenerationRef.current++;
    pendingAnnotationWriteRef.current = false;
    externalCommitEpochRef.current += 1;
    externalCommitInFlightRef.current = false;
    conflictStateRef.current = null;
    conflictEpochRef.current += 1;
    lastSyncedBufferHashRef.current = null;
    lastObservedDiskHashRef.current = null;
    debouncedWritePromiseRef.current = null;
    latestAnnotationContentRef.current = null;
    // Clear sticky failure flag on doc switch — a failure on doc A
    // must not block doc B navigation.
    annotationWriteFailedRef.current = null;
    sharedSkillSaveConfirmedForPathRef.current = null;
    // Reset the per-document toast dedupe window so a failure on doc A
    // does not suppress the first toast on doc B.
    lastAnnotationToastAtRef.current = 0;
    autoSaveActionableFailureRef.current = null;
    setConflictState(null);
    setSharedSkillSaveConfirmedForPath(null);
    setExternalCommitInFlight(false);
    setPendingApproval(null);
    return () => {
      if (externalCommitInFlightRef.current) {
        debouncedWriteRef.current?.cancel();
      } else {
        debouncedWriteRef.current?.flush();
      }
    };
  }, [documentPath]);

  // -------------------------------------------------------------------------
  // Load content based on file category
  // -------------------------------------------------------------------------
  useEffect(() => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    if (!documentPath) {
      setLoadState(INITIAL_LOAD_STATE);
      setImageState(INITIAL_IMAGE_STATE);
      setMediaState(INITIAL_MEDIA_STATE);
      return () => { controller.abort(); };
    }

    // Reset all states for the new document
    setLoadState(INITIAL_LOAD_STATE);
    setImageState(INITIAL_IMAGE_STATE);
    setMediaState(INITIAL_MEDIA_STATE);

    setIsEditing(false);
    setEditContent('');
    setLastSavedAt(undefined);

    const category = getFileCategory(documentPath);

    // Tutorials, HTML, and PDF files are rendered via iframe — no text content loading needed
    if (category === 'tutorial' || category === 'html') {
      return () => { controller.abort(); };
    }

    // PDFs — serve over the privileged rebel-media:// protocol, exactly like
    // video/audio below. The rebel-media handler returns an `application/pdf`
    // response that is fetchable regardless of the renderer's origin. A
    // renderer-owned `blob:` URL is origin-scoped, and under the packaged
    // `file://` origin the in-app PDF preview rendered blank. The precise
    // mechanism (whether Chromium's out-of-process PDF viewer truly cannot fetch
    // a `blob:file://…` source) is runtime-UNCONFIRMED, but the protocol path is
    // the robust fix either way. See docs/plans/260619_pdf-viewer-blank/PLAN.md.
    if (category === 'pdf') {
      setMediaState({ loading: true, error: null, mediaUrl: null });

      const resolvePdf = async (): Promise<string> => {
        const dir = coreDirectoryRef.current;
        if (dir) return getMediaProtocolUrl(documentPath, dir);
        const settings = await window.settingsApi.get();
        const settingsDir = settings.coreDirectory;
        if (!settingsDir) throw new Error('No workspace configured');
        coreDirectoryRef.current = settingsDir;
        setCoreDirectory(settingsDir);
        return getMediaProtocolUrl(documentPath, settingsDir);
      };

      resolvePdf()
        .then((mediaUrl) => {
          if (controller.signal.aborted) return;
          setMediaState({ loading: false, error: null, mediaUrl });
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          const message = err instanceof Error ? err.message : 'Failed to load PDF';
          setMediaState({ loading: false, error: formatDocumentLoadError(message), mediaUrl: null });
        });
      return () => { controller.abort(); };
    }

    if (category === 'unsupported') {
      setLoadState({
        loading: false,
        error: 'Preview not supported for this file type.',
        content: null,
      });
      return () => { controller.abort(); };
    }

    // Images — load as base64 data URL and extract dimensions
    if (category === 'image') {
      setImageState({ loading: true, error: null, dataUrl: null, dimensions: null });
      window.libraryApi.readFileBase64(documentPath)
        .then((base64Payload) => {
          if (controller.signal.aborted) return;
          const base64Data = readFileBase64ToString(base64Payload);
          const mimeType = getImageMimeType(documentPath);
          const dataUrl = `data:${mimeType};base64,${base64Data}`;

          const img = new Image();
          img.onload = () => {
            if (controller.signal.aborted) return;
            setImageState({
              loading: false,
              error: null,
              dataUrl,
              dimensions: { width: img.naturalWidth, height: img.naturalHeight },
            });
          };
          img.onerror = () => {
            if (controller.signal.aborted) return;
            setImageState({ loading: false, error: 'Failed to decode image', dataUrl: null, dimensions: null });
          };
          img.src = dataUrl;
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          const message = err instanceof Error ? err.message : 'Failed to load image';
          setImageState({ loading: false, error: formatDocumentLoadError(message), dataUrl: null, dimensions: null });
        });
      return () => { controller.abort(); };
    }

    // Video / Audio — resolve to rebel-media:// URL for streaming
    if (category === 'video' || category === 'audio') {
      setMediaState({ loading: true, error: null, mediaUrl: null });

      const resolveMedia = async (): Promise<string> => {
        const dir = coreDirectoryRef.current;
        if (dir) return getMediaProtocolUrl(documentPath, dir);
        const settings = await window.settingsApi.get();
        const settingsDir = settings.coreDirectory;
        if (!settingsDir) throw new Error('No workspace configured');
        coreDirectoryRef.current = settingsDir;
        setCoreDirectory(settingsDir);
        return getMediaProtocolUrl(documentPath, settingsDir);
      };

      resolveMedia()
        .then((mediaUrl) => {
          if (controller.signal.aborted) return;
          setMediaState({ loading: false, error: null, mediaUrl });
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          const message = err instanceof Error ? err.message : 'Failed to load media';
          setMediaState({ loading: false, error: message, mediaUrl: null });
        });
      return () => { controller.abort(); };
    }

    // Text files — read content and auto-enter edit mode
    setLoadState({ loading: true, error: null, content: null });
    setPendingApproval(null);
    window.libraryApi.readFile(documentPath)
      .then((result) => {
        if (controller.signal.aborted) return;
        setLoadState({ loading: false, error: null, content: result.content });
        setLastSavedAt(result.updatedAt);
        setEditContent(result.content);
        setIsEditing(true);
        void sha256HexUtf8(result.content).then((h) => {
          lastSyncedBufferHashRef.current = h;
          lastObservedDiskHashRef.current = h;
        });
      })
      .catch(async (err) => {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : 'Failed to load document';

        if (isMissingFileError(message) && documentPath) {
          try {
            const result = await window.api.getStagedFiles();
            if (controller.signal.aborted) return;
            const stagedFiles = Array.isArray(result)
              ? result
              : (result as { files: Array<{ id: string; realPath: string; spaceName: string; summary: string; stagedAt: number }> }).files ?? [];
            const normalizedDocPath = normalize(documentPath);
            const match = stagedFiles.find(f => normalize(f.realPath) === normalizedDocPath);
            if (match) {
              setPendingApproval({
                type: 'staged-file',
                id: match.id,
                summary: match.summary,
                spaceName: match.spaceName,
                fileName: basename(match.realPath),
                realPath: match.realPath,
                stagedAt: match.stagedAt,
              });
              setLoadState({ loading: false, error: null, content: null });
              return;
            }
          } catch (recoveryErr) {
            // Existing UX: fall through to the load error toast set below.
            // Surface the recovery-IPC failure as telemetry so on-call can
            // see ENOENT-with-broken-staging vs plain ENOENT.
            if (shouldSurfaceFailure(documentPath)) {
              emitDocumentIOTelemetry({
                level: 'warn',
                message: 'Staged-file recovery lookup failed during ENOENT fallback',
                event: 'document_editor.load_recovery_failed',
                errorClassifier: classifySafeError(recoveryErr),
              });
            }
          }
        }

        setLoadState({ loading: false, error: formatDocumentLoadError(message), content: null });
      });

    return () => { controller.abort(); };

  }, [documentPath, loadTrigger, emitDocumentIOTelemetry, shouldSurfaceFailure]);

  // -------------------------------------------------------------------------
  // External change detection (file watcher)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!documentPath || fileCategory !== 'text') return;

    let isActive = true;
    const currentPath = documentPath;

    const reloadFromDisk = (libraryChange?: LibraryChangedPayload) => {
      // Capture epoch BEFORE async read so stale reads can't bypass resolution.
      const epochAtReload = conflictEpochRef.current;

      window.libraryApi.readFile(currentPath)
        .then((result) => {
          if (!isActive || conflictEpochRef.current !== epochAtReload) return;

          const contentHashPromise = sha256HexUtf8(result.content);
          void contentHashPromise.then((h) => {
            if (!isActive) return;
            lastObservedDiskHashRef.current = h;
          });

          if (conflictStateRef.current) {
            // Conflict already active — update disk snapshot if epoch still matches.
            void contentHashPromise.then((h) => {
              if (!isActive || conflictEpochRef.current !== epochAtReload) return;
              // Preserve a more specific writer when a file-watcher echo follows an agent/cloud-sync write.
              const existingWriter = conflictStateRef.current?.writerKind;
              const incomingWriter = libraryChange?.writerKind;
              const resolvedWriter = (incomingWriter === 'file-watcher' && existingWriter && existingWriter !== 'file-watcher')
                ? existingWriter
                : (incomingWriter ?? existingWriter);
              const updated: DocumentWriteConflict = {
                diskContent: result.content,
                diskHash: h,
                detectedAt: conflictStateRef.current?.detectedAt ?? Date.now(),
                writerKind: resolvedWriter,
              };
              conflictStateRef.current = updated;
              setConflictState(updated);
            });
            return;
          }

          const prevContent = loadedContentRef.current;
          setLoadState((prev) => {
            if (!prev.loading && prev.error === null && prev.content === result.content) {
              return prev;
            }
            return { loading: false, error: null, content: result.content };
          });

          // Sync editContent when the editor hasn't been manually modified,
          // preventing auto-save from reverting external writes (e.g., Edit tool).
          // Uses trimmed comparison to tolerate TipTap markdown normalization
          // (trailing newlines, whitespace) that can cause editContent to diverge
          // from loadState.content without any actual user typing.
          if (
            prevContent !== null &&
            isEditingRef.current &&
            isEditorBodyUnchanged(editContentRef.current, prevContent as string)
          ) {
            editContentRef.current = result.content;
            setEditContent(result.content);
            void contentHashPromise.then((h) => {
              if (!isActive) return;
              lastSyncedBufferHashRef.current = h;
            });
          } else if (
            prevContent !== null &&
            isEditingRef.current &&
            !isEditorBodyUnchanged(editContentRef.current, prevContent as string)
          ) {
            // Skip false conflicts when the disk content hasn't actually changed
            // from what we last loaded — e.g. unrelated library:changed events.
            if (isEditorBodyUnchanged(result.content, prevContent as string)) {
              return;
            }
            void contentHashPromise.then((h) => {
              if (!isActive || conflictEpochRef.current !== epochAtReload) return;
              const conflict: DocumentWriteConflict = {
                diskContent: result.content,
                diskHash: h,
                detectedAt: Date.now(),
                writerKind: libraryChange?.writerKind,
              };
              conflictStateRef.current = conflict;
              setConflictState(conflict);
              emitConflictTelemetry({
                level: 'warn',
                message: 'Document write conflict detected',
                event: 'document_editor.conflict.detected',
                trigger: 'library-changed',
                writerKind: libraryChange?.writerKind,
                bufferHashEqualsDiskHash: lastSyncedBufferHashRef.current === h,
                hasCasBaseline: lastSyncedBufferHashRef.current !== null,
              });
            });
          }
        })
        .catch((err) => {
          if (!isActive) return;
          const message = err instanceof Error ? err.message : 'Failed to reload document';
          setLoadState(prev => ({ ...prev, error: message }));
        });
    };

    reloadFromDiskRef.current = reloadFromDisk;

    const unsubscribe = window.api.onLibraryChanged((libraryChange) => {
      const change = libraryChange ?? { timestamp: Date.now(), affectsTree: false };
      if (
        change.writerKind === 'editor'
        && change.changedPath
        && isSameDocumentPath(currentPath, change.changedPath, coreDirectoryRef.current)
      ) {
        return;
      }

      if (pendingAnnotationWriteRef.current) {
        missedLibraryChangeRef.current = true;
        missedLibraryChangePayloadRef.current = change;
        return;
      }
      reloadFromDisk(change);
    });

    return () => {
      isActive = false;
      reloadFromDiskRef.current = null;
      missedLibraryChangePayloadRef.current = undefined;
      unsubscribe();
    };
  }, [documentPath, fileCategory, emitConflictTelemetry]);

  // -------------------------------------------------------------------------
  // Auto-save (1400ms after last edit when dirty)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (
      !isEditing
      || !isDirty
      || isSaving
      || externalCommitInFlight
      || !documentPath
      || needsSharedSkillSaveConfirmation
      || conflictState
    ) {
      return undefined;
    }

    const scheduledEpoch = externalCommitEpochRef.current;
    const handle = window.setTimeout(() => {
      if (externalCommitEpochRef.current !== scheduledEpoch) return;
      if (isConflictBlocking()) return;

      const generation = docGenerationRef.current;
      const writePath = documentPath;

      void (async () => {
        isSavingRef.current = true;
        setIsSaving(true);
        try {
          const response = await writeFileOrFail(buildWriteFilePayload(writePath, editContent));
          if (externalCommitEpochRef.current !== scheduledEpoch) return;
          if (docGenerationRef.current !== generation) return;
          if (currentDocPathRef.current !== writePath) return;

          // CAS conflict — main process refused the write because the disk
          // hash diverged from baseContentHash. Materialize the conflict
          // banner directly rather than waiting for the corresponding
          // library:changed broadcast (which may be delayed or missed).
          // Stage 2 completeness gap; the existing reload path covers the
          // common case but a missed broadcast would otherwise leave the
          // user retrying silently on every edit.
          if (response.result === 'conflict') {
            // Re-check conflict state under lock — a concurrent
            // library:changed reload may have already materialized.
            if (isConflictBlocking()) return;
            try {
              const disk = await window.libraryApi.readFile(writePath);
              if (externalCommitEpochRef.current !== scheduledEpoch) return;
              if (docGenerationRef.current !== generation) return;
              if (currentDocPathRef.current !== writePath) return;
              if (isConflictBlocking()) return;
              const diskHash = await sha256HexUtf8(disk.content);
              if (externalCommitEpochRef.current !== scheduledEpoch) return;
              if (docGenerationRef.current !== generation) return;
              if (currentDocPathRef.current !== writePath) return;
              if (isConflictBlocking()) return;
              lastObservedDiskHashRef.current = diskHash;
              const conflict: DocumentWriteConflict = {
                diskContent: disk.content,
                diskHash,
                detectedAt: Date.now(),
                writerKind: undefined, // unknown — CAS detected the divergence, not a watcher event
              };
              conflictStateRef.current = conflict;
              setConflictState(conflict);
              emitConflictTelemetry({
                level: 'warn',
                message: 'Document write conflict detected',
                event: 'document_editor.conflict.detected',
                trigger: 'auto-save-cas',
                writerKind: 'unknown',
                bufferHashEqualsDiskHash: response.currentHash === diskHash,
                hasCasBaseline: lastSyncedBufferHashRef.current !== null,
              });
            } catch {
              // CAS conflict was real but we couldn't read disk to populate
              // the banner. The next library:changed event will retry.
              // Surface the failure as telemetry so users / on-call can see
              // we know about the gap.
              emitConflictTelemetry({
                level: 'warn',
                message: 'Document write conflict materialization failed',
                event: 'document_editor.conflict.materialize_failed',
                trigger: 'auto-save-cas',
                hasCasBaseline: lastSyncedBufferHashRef.current !== null,
              });
            }
            return;
          }

          if (response.currentHash) {
            lastSyncedBufferHashRef.current = response.currentHash;
            lastObservedDiskHashRef.current = response.currentHash;
          }
          autoSaveActionableFailureRef.current = null;
          setLoadState(prev => ({ ...prev, content: editContent }));
          setLastSavedAt(response.updatedAt ?? Date.now());
          setJustSaved(true);
          justSavedTimer.set(() => setJustSaved(false), JUST_SAVED_DURATION);
        } catch (err) {
          // Auto-save generally fails quietly (the status bar keeps showing
          // "Unsaved changes"), but actionable filesystem errors need one
          // user-visible nudge per failure streak so users do not trust a
          // broken auto-save for the rest of the afternoon.
          const errorClassifier = classifySafeError(err);
          if (shouldSurfaceFailure(writePath)) {
            emitDocumentIOTelemetry({
              level: 'warn',
              message: 'Auto-save write failed',
              event: 'document_editor.write_failed',
              operation: 'auto-save',
              errorClassifier,
            });
            if (
              err instanceof WriteFailureError
              && errorClassifier.errorKind === 'fs'
              && errorClassifier.errorCode
              && ACTIONABLE_WRITE_ERRNOS.has(errorClassifier.errorCode)
            ) {
              if (autoSaveActionableFailureRef.current === errorClassifier.errorCode) {
                emitLogRef.current?.({
                  level: 'debug',
                  message: 'Auto-save actionable failure toast suppressed by failure streak',
                  context: {
                    event: 'document_editor.write_failed',
                    component: 'useDocumentFileIO',
                    operation: 'auto-save',
                    dedupe: 'actionable-failure-streak',
                    fileCategory: getFileCategory(writePath),
                    fileExtension: classifyFileExtension(writePath),
                    documentScope: classifyDocumentScope(
                      writePath,
                      sharedSkillSaveProtectionRef.current !== null,
                    ),
                    errorName: errorClassifier.errorName,
                    errorKind: errorClassifier.errorKind,
                    errorCode: errorClassifier.errorCode,
                  },
                });
              } else {
                autoSaveActionableFailureRef.current = errorClassifier.errorCode;
                showToastRef.current?.({
                  ...errnoToUserMessage(errorClassifier.errorCode),
                  variant: 'error',
                });
              }
            }
          }
        } finally {
          isSavingRef.current = false;
          setIsSaving(false);
        }
      })();
    }, AUTO_SAVE_DELAY);

    return () => window.clearTimeout(handle);
  }, [isEditing, isDirty, isSaving, externalCommitInFlight, documentPath, editContent, justSavedTimer, needsSharedSkillSaveConfirmation, conflictState, emitConflictTelemetry, isConflictBlocking, emitDocumentIOTelemetry, shouldSurfaceFailure]);

  // -------------------------------------------------------------------------
  // Annotation content change handler
  // In edit mode: updates editContent. In preview mode: debounced disk write.
  // -------------------------------------------------------------------------
  const handleAnnotationContentChange = useCallback((newContent: string) => {
    if (isEditing) {
      editContentRef.current = newContent;
      setEditContent(newContent);
    } else if (documentPath) {
      latestAnnotationContentRef.current = newContent;
      pendingAnnotationWriteRef.current = true;
      debouncedWriteGenRef.current = docGenerationRef.current;
      debouncedWriteRef.current?.(documentPath, newContent);
    }
  }, [isEditing, documentPath]);

  // Editor body text change handler — only fires in edit mode.
  // Updates ref immediately so the file watcher's external-change guard
  // sees the latest content without waiting for the next React render.
  const handleEditorBodyChange = useCallback((full: string) => {
    editContentRef.current = full;
    setEditContent(full);
  }, []);

  // Atomically replace both the saved baseline and the editable buffer after
  // an external commit (for example, a history restore) so follow-up auto-save
  // does not immediately re-write the same content.
  const applyExternalCommittedContent = useCallback((content: string) => {
    externalCommitEpochRef.current += 1;
    externalCommitInFlightRef.current = false;
    setExternalCommitInFlight(false);
    editContentRef.current = content;
    setEditContent(content);
    setLoadState(prev => ({ ...prev, loading: false, error: null, content }));
    setLastSavedAt(Date.now());
    void sha256HexUtf8(content).then((h) => {
      lastSyncedBufferHashRef.current = h;
      lastObservedDiskHashRef.current = h;
    });
  }, []);

  const prepareForExternalCommit = useCallback(() => {
    if (isSavingRef.current || pendingAnnotationWriteRef.current || externalCommitInFlightRef.current) {
      return false;
    }

    externalCommitEpochRef.current += 1;
    pendingAnnotationWriteRef.current = false;
    debouncedWriteRef.current?.cancel();
    externalCommitInFlightRef.current = true;
    setExternalCommitInFlight(true);
    return true;
  }, []);

  const cancelExternalCommit = useCallback(() => {
    externalCommitInFlightRef.current = false;
    setExternalCommitInFlight(false);
  }, []);

  const confirmSharedSkillDirectSave = useCallback(async () => {
    if (!documentPath || !sharedSkillSaveProtection) {
      return;
    }
    if (isConflictBlocking()) {
      return;
    }

    tracking.skillCollaboration.nudgeDecision({
      skillId: sharedSkillSaveProtection.skillRelativePath,
      surface: 'direct_editor',
      decision: 'confirmed',
    });

    sharedSkillSaveConfirmedForPathRef.current = documentPath;
    setSharedSkillSaveConfirmedForPath(documentPath);

    let contentToWrite = isEditingRef.current ? editContentRef.current : loadedContentRef.current;
    if (!contentToWrite) {
      return;
    }

    if (isMarkdownFile && captureIntoContentRef.current) {
      contentToWrite = captureIntoContentRef.current(contentToWrite);
    }

    const hasPendingChanges = contentToWrite !== loadedContentRef.current || pendingAnnotationWriteRef.current;
    if (!hasPendingChanges || externalCommitInFlightRef.current) {
      pendingAnnotationWriteRef.current = false;
      drainMissedLibraryChange();
      return;
    }

    const generation = docGenerationRef.current;
    const writePath = documentPath;

    isSavingRef.current = true;
    setIsSaving(true);
    try {
      const response = await writeFileOrFail(buildWriteFilePayload(writePath, contentToWrite));
      if (response.result === 'conflict') {
        throw new Error(WRITE_CONFLICT_MESSAGE);
      }
      if (docGenerationRef.current !== generation) return;
      if (currentDocPathRef.current !== writePath) return;

      if (response?.currentHash) {
        lastSyncedBufferHashRef.current = response.currentHash;
        lastObservedDiskHashRef.current = response.currentHash;
      }
      autoSaveActionableFailureRef.current = null;
      pendingAnnotationWriteRef.current = false;
      drainMissedLibraryChange();
      onAnnotationWriteCommittedRef.current?.(contentToWrite);
      editContentRef.current = contentToWrite;
      setEditContent(contentToWrite);
      setLoadState(prev => ({ ...prev, content: contentToWrite }));
      setLastSavedAt(response?.updatedAt ?? Date.now());
      setJustSaved(true);
      justSavedTimer.set(() => setJustSaved(false), JUST_SAVED_DURATION);
    } catch (err) {
      showToast?.({
        ...writeErrorToUserMessage(err),
        variant: 'error',
      });
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }, [documentPath, isMarkdownFile, isConflictBlocking, justSavedTimer, sharedSkillSaveProtection, showToast]);

  // -------------------------------------------------------------------------
  // flushAnnotationWriteNow — immediate disk write bypassing the 500ms
  // annotation debounce. Used by the per-message `onCommit` closure in
  // `DocumentFooter` so that after clearing staged annotations from
  // ProseMirror state we synchronously flush the post-clear content to
  // disk. If we relied on the debounce, the load effect could resurrect
  // the just-cleared annotations on a subsequent reload.
  //
  // Fails loud: emits `error`-level emitLog AND rejects the returned
  // promise. No silent `.catch(() => ...)`.
  // -------------------------------------------------------------------------
  const flushAnnotationWriteNow = useCallback(async (content: string): Promise<void> => {
    if (!documentPath) {
      return;
    }
    if (isConflictBlocking()) {
      return;
    }
    if (externalCommitInFlightRef.current) {
      // An external commit is in flight (e.g. history restore). Leave
      // the file untouched — the external commit is the authoritative
      // write. The onCommit closure accepts this as a successful noop;
      // in-memory annotation state has already been cleared.
      return;
    }
    if (
      sharedSkillSaveProtectionRef.current
      && sharedSkillSaveConfirmedForPathRef.current !== documentPath
    ) {
      // Shared skill direct-save not yet confirmed — respect the guard
      // and skip the flush. Matches the debounced-write branch above.
      return;
    }

    // Cancel any pending debounced annotation write. We're writing now,
    // and letting the debounced call fire after would double-write
    // (harmlessly, but wastefully).
    debouncedWriteRef.current?.cancel();
    pendingAnnotationWriteRef.current = true;

    const generation = docGenerationRef.current;
    const writePath = documentPath;

    try {
      latestAnnotationContentRef.current = content;
      const result = await writeFileOrFail(buildWriteFilePayload(writePath, content));
      if (result.result === 'conflict') {
        throw new Error(WRITE_CONFLICT_MESSAGE);
      }
      if (result.currentHash) {
        lastSyncedBufferHashRef.current = result.currentHash;
        lastObservedDiskHashRef.current = result.currentHash;
      }
      autoSaveActionableFailureRef.current = null;
      if (docGenerationRef.current === generation && currentDocPathRef.current === writePath) {
        onAnnotationWriteCommittedRef.current?.(content);
        setLoadState((prev) => ({ ...prev, content }));
      }
    } catch (err) {
      const errorClassifier = classifySafeError(err);
      if (shouldSurfaceFailure(writePath)) {
        emitDocumentIOTelemetry({
          level: 'error',
          message: 'Failed to flush annotation write on dispatch',
          event: 'document_editor.annotation_write_failed',
          operation: 'flush-on-dispatch',
          errorClassifier,
        });
      }
      if (!emitLogRef.current) {
        // Fallback when no structured log sink is wired: at minimum
        // surface the failure to the developer console. Still not
        // silent — a `console.error` is observable. Per AMD.6 this
        // remains unconditional when no sink is wired, even if stale-doc
        // suppression prevents user-facing telemetry.
        console.error('[useDocumentFileIO] Failed to flush annotation write', {
          errorClassifier,
        });
      }
      throw err;
    } finally {
      pendingAnnotationWriteRef.current = false;
      drainMissedLibraryChange();
    }
  }, [documentPath, emitDocumentIOTelemetry, isConflictBlocking, shouldSurfaceFailure]);

  const persistCurrentContentNow = useCallback(async (): Promise<void> => {
    if (!documentPath) {
      throw new Error('No document is open.');
    }
    if (externalCommitInFlightRef.current) {
      throw new Error('Document is busy. Try again in a moment.');
    }
    if (isConflictBlocking()) {
      throw new Error('Resolve the document conflict before saving.');
    }
    if (needsSharedSkillSaveConfirmation) {
      throw new Error('Confirm direct edits before saving this shared skill.');
    }

    let contentToWrite = editContentRef.current;
    if (isMarkdownFile && captureIntoContentRef.current) {
      contentToWrite = captureIntoContentRef.current(contentToWrite);
    }

    const generation = docGenerationRef.current;
    const writePath = documentPath;

    isSavingRef.current = true;
    setIsSaving(true);
    try {
      const response = await writeFileOrFail(buildWriteFilePayload(writePath, contentToWrite));
      if (response.result === 'conflict') {
        throw new Error(WRITE_CONFLICT_MESSAGE);
      }
      if (docGenerationRef.current !== generation || currentDocPathRef.current !== writePath) {
        throw new Error('Document changed before the image update could be saved.');
      }

      if (response.currentHash) {
        lastSyncedBufferHashRef.current = response.currentHash;
        lastObservedDiskHashRef.current = response.currentHash;
      }
      autoSaveActionableFailureRef.current = null;
      pendingAnnotationWriteRef.current = false;
      onAnnotationWriteCommittedRef.current?.(contentToWrite);
      editContentRef.current = contentToWrite;
      setEditContent(contentToWrite);
      setLoadState(prev => ({ ...prev, content: contentToWrite }));
      setLastSavedAt(response.updatedAt ?? Date.now());
      setJustSaved(true);
      justSavedTimer.set(() => setJustSaved(false), JUST_SAVED_DURATION);
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
      drainMissedLibraryChange();
    }
  }, [documentPath, isMarkdownFile, isConflictBlocking, justSavedTimer, needsSharedSkillSaveConfirmation]);

  // -------------------------------------------------------------------------
  // persistAnnotationsNow — immediate flush of annotations to disk
  // Accepts caller's captureIntoContent (from annotation hook).
  // -------------------------------------------------------------------------
  const persistAnnotationsNow = useCallback(async (captureIntoContent: CaptureIntoContentFn) => {
    if (
      !isMarkdownFile
      || !documentPath
      || externalCommitInFlightRef.current
      || needsSharedSkillSaveConfirmation
      || isConflictBlocking()
    ) {
      return;
    }

    const generation = docGenerationRef.current;
    debouncedWriteRef.current?.cancel();

    const currentContent = isEditing ? editContent : loadState.content;
    if (!currentContent) return;

    const newContent = captureIntoContent(currentContent);
    if (newContent === currentContent) return;

    latestAnnotationContentRef.current = newContent;
    pendingAnnotationWriteRef.current = true;
    const writePath = documentPath;
    try {
      const annResult = await writeFileOrFail(buildWriteFilePayload(writePath, newContent));
      if (annResult.result === 'conflict') {
        throw new Error(WRITE_CONFLICT_MESSAGE);
      }
      if (annResult.currentHash) {
        lastSyncedBufferHashRef.current = annResult.currentHash;
        lastObservedDiskHashRef.current = annResult.currentHash;
      }
      autoSaveActionableFailureRef.current = null;
      if (docGenerationRef.current === generation) {
        onAnnotationWriteCommittedRef.current?.(newContent);
        setLoadState(prev => ({ ...prev, content: newContent }));
      }
      // Successful write clears the sticky failure flag.
      annotationWriteFailedRef.current = null;
    } catch (err) {
      // Mark sticky flag so a later flush() rejects even if no consumer
      // awaits this rethrow (defense in depth — callers SHOULD await,
      // but the flag closes the gap if a future caller forgets).
      annotationWriteFailedRef.current = err instanceof Error ? err : new Error(String(err));
      if (shouldSurfaceFailure(writePath)) {
        emitDocumentIOTelemetry({
          level: 'error',
          message: 'Failed to persist annotations (immediate)',
          event: 'document_editor.annotation_write_failed',
          operation: 'persist-now',
          errorClassifier: classifySafeError(err),
        });
        showToast?.({
          ...writeErrorToUserMessage(err),
          variant: 'error',
        });
      }
      // Class A Batch 1: rethrow so destructive-navigation callers
      // (handleOpenLinkedFile, handleOpenInLibrary) can abort. Toast
      // and telemetry already fired (or were intentionally suppressed
      // by shouldSurfaceFailure) at this site; the rejection is the
      // propagation signal, not a second user-facing message.
      throw err;
    } finally {
      pendingAnnotationWriteRef.current = false;
      drainMissedLibraryChange();
    }
  }, [isMarkdownFile, documentPath, isEditing, editContent, loadState.content, needsSharedSkillSaveConfirmation, isConflictBlocking, emitDocumentIOTelemetry, shouldSurfaceFailure, showToast]);

  // -------------------------------------------------------------------------
  // save — explicit save (e.g. Cmd+S)
  // -------------------------------------------------------------------------
  const save = useCallback(async () => {
    autoSaveActionableFailureRef.current = null;
    if (!isEditing || !isDirty || isSaving || externalCommitInFlightRef.current || !documentPath || isConflictBlocking()) return;
    if (needsSharedSkillSaveConfirmation) {
      showToast?.({ title: 'Confirm direct edits before saving this shared skill.' });
      return;
    }

    const generation = docGenerationRef.current;
    const writePath = documentPath;

    isSavingRef.current = true;
    setIsSaving(true);
    try {
      const response = await writeFileOrFail(buildWriteFilePayload(writePath, editContent));
      if (response.result === 'conflict') {
        throw new Error(WRITE_CONFLICT_MESSAGE);
      }
      if (docGenerationRef.current !== generation) return;
      if (currentDocPathRef.current !== writePath) return;

      if (response?.currentHash) {
        lastSyncedBufferHashRef.current = response.currentHash;
        lastObservedDiskHashRef.current = response.currentHash;
      }
      autoSaveActionableFailureRef.current = null;
      setLoadState(prev => ({ ...prev, content: editContent }));
      setLastSavedAt(response?.updatedAt ?? Date.now());
      setJustSaved(true);
      justSavedTimer.set(() => setJustSaved(false), JUST_SAVED_DURATION);
    } catch (err) {
      showToast?.({
        ...writeErrorToUserMessage(err),
        variant: 'error',
      });
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }, [isEditing, isDirty, isSaving, documentPath, editContent, showToast, justSavedTimer, needsSharedSkillSaveConfirmation, isConflictBlocking]);

  // -------------------------------------------------------------------------
  // flush — immediately persists all pending writes (auto-save + debounce)
  // Used before tab switches or navigation away.
  // Captures annotations from ProseMirror state via captureIntoContentRef
  // to bypass the async React setState pipeline (editContent may be stale).
  // -------------------------------------------------------------------------
  const flush = useCallback(async () => {
    if (externalCommitInFlightRef.current || needsSharedSkillSaveConfirmation || isConflictBlocking()) return;

    // Reset toast dedupe so a recent typing-burst toast does not suppress
    // feedback for this single destructive-navigation action.
    lastAnnotationToastAtRef.current = 0;

    // Flush debounced annotation write and await any in-flight write that
    // the debounced inner fn captured so rejection propagates to callers.
    debouncedWriteRef.current?.flush();
    const inflightAnnotation = debouncedWritePromiseRef.current;
    if (inflightAnnotation) {
      await inflightAnnotation;
    }

    // Sticky-flag check (Class A Batch 1, Behavioral Safety review):
    // even if there's no in-flight write to await, a previously-failed
    // debounced write that settled BEFORE this flush() call leaves the
    // sticky failure flag set. Reject so the destructive navigation
    // aborts and the user retains their unsaved annotations.
    if (annotationWriteFailedRef.current !== null) {
      let unresolvedErr: Error | null = annotationWriteFailedRef.current;
      const latestAnnotationContent = latestAnnotationContentRef.current;
      if (documentPath && latestAnnotationContent !== null && debouncedWritePromiseRef.current === null) {
        const latestAnnotationHash = await sha256HexUtf8(latestAnnotationContent);
        if (latestAnnotationHash !== lastSyncedBufferHashRef.current) {
          debouncedWriteRef.current?.cancel();
          const generation = docGenerationRef.current;
          const writePath = documentPath;
          pendingAnnotationWriteRef.current = true;
          try {
            const response = await writeFileOrFail(buildWriteFilePayload(writePath, latestAnnotationContent));
            if (response.result === 'conflict') {
              throw new Error(WRITE_CONFLICT_MESSAGE);
            }
            if (docGenerationRef.current === generation && currentDocPathRef.current === writePath) {
              if (response.currentHash) {
                lastSyncedBufferHashRef.current = response.currentHash;
                lastObservedDiskHashRef.current = response.currentHash;
              } else {
                lastSyncedBufferHashRef.current = latestAnnotationHash;
                lastObservedDiskHashRef.current = latestAnnotationHash;
              }
              onAnnotationWriteCommittedRef.current?.(latestAnnotationContent);
              setLoadState(prev => ({ ...prev, content: latestAnnotationContent }));
              annotationWriteFailedRef.current = null;
              autoSaveActionableFailureRef.current = null;
              unresolvedErr = null;
              drainMissedLibraryChange();
            }
          } catch (err) {
            unresolvedErr = err instanceof Error ? err : new Error(String(err));
            annotationWriteFailedRef.current = unresolvedErr;
          } finally {
            pendingAnnotationWriteRef.current = false;
          }
        }
      }

      // Surface telemetry + toast for this resurrected failure (the
      // original toast may have been dismissed by the user). Reuse
      // shouldSurfaceFailure for stale-doc/unmount gating.
      if (unresolvedErr !== null) {
        if (documentPath && shouldSurfaceFailure(documentPath)) {
          emitDocumentIOTelemetry({
            level: 'error',
            message: 'Flush rejected on prior unresolved annotation write failure',
            event: 'document_editor.write_failed',
            operation: 'flush',
            errorClassifier: classifySafeError(unresolvedErr),
          });
          showToast?.({
            ...writeErrorToUserMessage(unresolvedErr),
            variant: 'error',
          });
        }
        throw unresolvedErr;
      }
    }

    // Flush unsaved edit content — write regardless of isSaving to prevent
    // data loss when auto-save is in-flight with older content.
    if (isEditing && documentPath) {
      let contentToWrite = editContent;
      if (captureIntoContentRef.current) {
        contentToWrite = captureIntoContentRef.current(contentToWrite);
      }
      if (contentToWrite === loadState.content) return;

      const generation = docGenerationRef.current;
      const writePath = documentPath;

      try {
        const response = await writeFileOrFail(buildWriteFilePayload(writePath, contentToWrite));
        if (response.result === 'conflict') {
          throw new Error(WRITE_CONFLICT_MESSAGE);
        }
        if (docGenerationRef.current !== generation) return;
        if (currentDocPathRef.current !== writePath) return;

        if (response?.currentHash) {
          lastSyncedBufferHashRef.current = response.currentHash;
          lastObservedDiskHashRef.current = response.currentHash;
        }
        autoSaveActionableFailureRef.current = null;
        onAnnotationWriteCommittedRef.current?.(contentToWrite);
        setLoadState(prev => ({ ...prev, content: contentToWrite }));
        setLastSavedAt(response?.updatedAt ?? Date.now());
      } catch (err) {
        if (shouldSurfaceFailure(writePath)) {
          emitDocumentIOTelemetry({
            level: 'error',
            message: 'Flush write failed before destructive navigation',
            event: 'document_editor.write_failed',
            operation: 'flush',
            errorClassifier: classifySafeError(err),
          });
          showToast?.({
            ...writeErrorToUserMessage(err),
            variant: 'error',
          });
        }
        throw err;
      }
    }
  }, [isEditing, documentPath, editContent, loadState.content, needsSharedSkillSaveConfirmation, isConflictBlocking, shouldSurfaceFailure, emitDocumentIOTelemetry, showToast]);

  const resolveConflict = useCallback(async (resolution: 'keep-editor' | 'keep-disk') => {
    const conflict = conflictStateRef.current;
    if (!conflict || !documentPath) return;

    // Bump epoch first so any in-flight async conflict callbacks are invalidated.
    conflictEpochRef.current += 1;

    const conflictAgeMs = Date.now() - conflict.detectedAt;

    if (resolution === 'keep-disk') {
      editContentRef.current = conflict.diskContent;
      setEditContent(conflict.diskContent);
      setLoadState(prev => ({ ...prev, content: conflict.diskContent }));
      lastSyncedBufferHashRef.current = conflict.diskHash;
      lastObservedDiskHashRef.current = conflict.diskHash;
    } else {
      // Capture latest TipTap annotation state before writing.
      if (captureIntoContentRef.current) {
        editContentRef.current = captureIntoContentRef.current(editContentRef.current);
      }
      const currentContent = editContentRef.current;
      try {
        const result = await writeFileOrFail({
          path: documentPath,
          content: currentContent,
          baseContentHash: conflict.diskHash,
        });
        if (result.result === 'conflict') {
          // Third-writer race: the disk shifted again after the user chose
          // keep-editor and before main-process committed. Re-materialize
          // the conflict so the user can decide against the freshest disk.
          const newContent = await window.libraryApi.readFile(documentPath);
          const h = await sha256HexUtf8(newContent.content);
          const updatedConflict: DocumentWriteConflict = {
            diskContent: newContent.content,
            diskHash: h,
            detectedAt: Date.now(),
            writerKind: conflict.writerKind,
          };
          conflictStateRef.current = updatedConflict;
          setConflictState(updatedConflict);
          emitConflictTelemetry({
            level: 'warn',
            message: 'Document conflict resolution rejected by main process — disk shifted again',
            event: 'document_editor.conflict.write_rejected',
            trigger: 'resolve-keep-editor',
            writerKind: conflict.writerKind,
            conflictAgeMs,
            hasCasBaseline: true,
          });
          return;
        }
        if (result.currentHash) {
          lastSyncedBufferHashRef.current = result.currentHash;
          lastObservedDiskHashRef.current = result.currentHash;
        }
        autoSaveActionableFailureRef.current = null;
        // Sync React state so auto-save doesn't re-write stale editContent.
        editContentRef.current = currentContent;
        setEditContent(currentContent);
        setLoadState(prev => ({ ...prev, content: currentContent }));
      } catch (err) {
        emitConflictTelemetry({
          level: 'error',
          message: 'Failed to write editor content during conflict resolution',
          event: 'document_editor.conflict.resolve_write_failed',
          writerKind: conflict.writerKind,
          conflictAgeMs,
        });
        // Conflict banner stays visible; surface the failure so the user
        // doesn't think clicking "Keep my edits" did nothing. Single-click
        // action — not deduped.
        if (shouldSurfaceFailure(documentPath)) {
          showToast?.({
            ...writeErrorToUserMessage(err),
            variant: 'error',
          });
        }
        return;
      }
    }

    conflictStateRef.current = null;
    setConflictState(null);
    emitConflictTelemetry({
      level: 'info',
      message: 'Document write conflict resolved',
      event: 'document_editor.conflict.resolved',
      writerKind: conflict.writerKind,
      resolution,
      conflictAgeMs,
    });
  }, [documentPath, emitConflictTelemetry, showToast, shouldSurfaceFailure]);

  // -------------------------------------------------------------------------
  // cancelLoad — abort in-flight file read
  // -------------------------------------------------------------------------
  const cancelLoad = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  // -------------------------------------------------------------------------
  // Pending approval actions
  // -------------------------------------------------------------------------
  const approvePending = useCallback(async (): Promise<boolean> => {
    if (!pendingApproval) return false;
    // Capture current path BEFORE the await so post-IPC failures from a
    // doc that was switched away mid-flight don't toast in the new doc.
    const pathAtCallTime = currentDocPathRef.current;
    try {
      const result = await window.api.publishStagedFile(pendingApproval.id);
      if (result.status === 'success' || result.status === 'already-resolved') {
        setPendingApproval(null);
        setLoadTrigger(prev => prev + 1);
        return true;
      }
      if (result.status === 'conflict') {
        showToast?.({ title: 'Conflict detected — review this file in Approvals' });
      } else if (result.status === 'not-found') {
        setPendingApproval(null);
        showToast?.({ title: 'This approval was already resolved' });
      } else if (result.status === 'error') {
        // Main-side returned a non-throwing failure — same user-facing
        // experience as the catch branch below: log + toast so the click
        // does not silently no-op.
        if (shouldSurfaceFailure(pathAtCallTime)) {
          emitDocumentIOTelemetry({
            level: 'error',
            message: 'Approve action returned status: error from main process',
            event: 'document_editor.approval_action_failed',
            action: 'approve',
          });
          showToast?.({
            title: "Couldn't approve. Try again.",
            variant: 'error',
          });
        }
      }
      return false;
    } catch (err) {
      if (shouldSurfaceFailure(pathAtCallTime)) {
        emitDocumentIOTelemetry({
          level: 'error',
          message: 'Approve action threw before main-side response',
          event: 'document_editor.approval_action_failed',
          action: 'approve',
          errorClassifier: classifySafeError(err),
        });
        showToast?.({
          title: "Couldn't approve. Try again.",
          variant: 'error',
        });
      }
      return false;
    }
  }, [pendingApproval, showToast, emitDocumentIOTelemetry, shouldSurfaceFailure]);

  const denyPending = useCallback(async (): Promise<boolean> => {
    if (!pendingApproval) return false;
    const pathAtCallTime = currentDocPathRef.current;
    try {
      const result = await window.api.keepStagedFilePrivate(pendingApproval.id);
      if (result.status === 'success' || result.status === 'already-resolved') {
        setPendingApproval(null);
        setLoadState({ loading: false, error: null, content: null });
        showToast?.({ title: 'File saved to private memory' });
        return true;
      }
      if (result.status === 'not-found') {
        setPendingApproval(null);
        showToast?.({ title: 'This approval was already resolved' });
      } else if (result.status === 'error') {
        if (shouldSurfaceFailure(pathAtCallTime)) {
          emitDocumentIOTelemetry({
            level: 'error',
            message: 'Deny action returned status: error from main process',
            event: 'document_editor.approval_action_failed',
            action: 'deny',
          });
          showToast?.({
            title: "Couldn't keep this private. Try again.",
            variant: 'error',
          });
        }
      }
      return false;
    } catch (err) {
      if (shouldSurfaceFailure(pathAtCallTime)) {
        emitDocumentIOTelemetry({
          level: 'error',
          message: 'Deny action threw before main-side response',
          event: 'document_editor.approval_action_failed',
          action: 'deny',
          errorClassifier: classifySafeError(err),
        });
        showToast?.({
          title: "Couldn't keep this private. Try again.",
          variant: 'error',
        });
      }
      return false;
    }
  }, [pendingApproval, showToast, emitDocumentIOTelemetry, shouldSurfaceFailure]);

  // -------------------------------------------------------------------------
  // Return
  // -------------------------------------------------------------------------
  return {
    content: loadState.content,
    loading: loadState.loading,
    error: loadState.error,
    fileCategory,
    isMarkdownFile,
    fileName,

    imageState,
    mediaState,
    setMediaState,

    isEditing,
    editContent,
    isDirty,
    isSaving,
    justSaved,
    statusText,
    setEditContent,
    setIsEditing,
    conflictState,

    save,
    flush,
    persistCurrentContentNow,
    resolveConflict,
    cancelLoad,
    prepareForExternalCommit,
    cancelExternalCommit,

    absolutePath,
    relativePath,

    handleAnnotationContentChange,
    handleEditorBodyChange,
    applyExternalCommittedContent,
    persistAnnotationsNow,
    flushAnnotationWriteNow,
    sharedSkillSaveProtection: sharedSkillSaveProtection ?? null,
    needsSharedSkillSaveConfirmation,
    confirmSharedSkillDirectSave,

    pendingApproval,
    approvePending,
    denyPending,

    captureIntoContentRef,
  };
}
