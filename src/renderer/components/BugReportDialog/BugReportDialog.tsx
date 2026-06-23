import { useState, useCallback, useEffect, useRef } from 'react';
import { Bug, AlertTriangle, X, ImageIcon, Upload, Lightbulb, ExternalLink, Users, Copy } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  Button,
  Textarea,
  Label,
  Select,
  Input,
  Toggle,
} from '@renderer/components/ui';
import {
  DEFAULT_DIAGNOSTIC_SECTIONS,
  DIAGNOSTIC_SECTION_DESCRIPTORS,
  type DiagnosticSections,
  type SectionId,
} from '@shared/diagnostics/diagnosticBundleSections';
import { DiagnosticEventRow } from '@renderer/features/settings/components/diagnostics/DiagnosticEventRow';
import { useRecentDiagnosticContext } from '@renderer/features/settings/hooks/useRecentDiagnosticContext';
import type { RecentDiagnosticContextStatus } from '@renderer/features/settings/hooks/useRecentDiagnosticContext';
import styles from './BugReportDialog.module.css';

export type FeedbackType = 'bug' | 'improvement';
export type UrgencyLevel = 'low' | 'medium' | 'high' | 'critical';

export interface FeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (eventId: string) => void;
  onError?: (error: Error) => void;
  conversationId?: string;
  defaultFeedbackType?: FeedbackType;
  prefill?: { description?: string; stepsToReproduce?: string; expectedBehavior?: string; attachContinuityDiagnostics?: boolean };
}

/** @deprecated Use FeedbackDialogProps instead */
export type BugReportDialogProps = FeedbackDialogProps;

export interface ScreenshotData {
  base64Data: string;
  width: number;
  height: number;
  sizeBytes: number;
  mimeType: string;
}

const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_SCREENSHOT_SIZE_MB = 5;
const REBELS_COMMUNITY_URL = 'https://rebels.mindstone.com/c/feature-requests/7';
const createDefaultDiagnosticSections = (): DiagnosticSections => ({ ...DEFAULT_DIAGNOSTIC_SECTIONS });

const getSystemInfo = () => ({
  appVersion: window.electronEnv?.appVersion ?? 'unknown',
  platform: window.electronEnv?.platform ?? 'unknown',
  arch: window.electronEnv?.arch ?? 'unknown',
});

const RECENT_ACTIVITY_EMPTY_COPY = 'All quiet. Nothing notable in the last 24 hours.';
const RECENT_ACTIVITY_ERROR_COPY =
  "Couldn't load recent activity. Rebel can keep working, but this view is unavailable right now.";
const RECENT_ACTIVITY_READER_UNAVAILABLE_COPY =
  "Recent activity isn't available on this surface. Rebel can keep working — this view just isn't supported here.";
const RECENT_ACTIVITY_LOADING_COPY = 'Checking recent activity...';

function BugReportRecentActivityPreview() {
  const {
    status,
    events,
    lastFetchedAt,
    copyForSupport,
  } = useRecentDiagnosticContext();

  const handleCopyForSupport = useCallback(() => {
    void copyForSupport();
  }, [copyForSupport]);

  const previewEvents = events.slice(0, 3);
  const statusCopy = getRecentActivityStatusCopy(status);

  return (
    <div className={styles.optionsSection} data-testid="bug-report-recent-activity">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <strong style={{ fontSize: '0.875rem' }}>Recent activity</strong>
          <span className={styles.optionalLabel}>
            {lastFetchedAt ? `Last refreshed ${formatRelativeTime(lastFetchedAt)}` : 'Last refreshed —'}
          </span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleCopyForSupport}
        >
          <Copy size={14} />
          Copy for support
        </Button>
      </div>

      {statusCopy ? (
        <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
          {statusCopy}
        </p>
      ) : null}

      {status === 'populated' && previewEvents.length > 0 ? (
        <div role="list" aria-label="Recent diagnostic activity preview" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {previewEvents.map((event) => (
            <DiagnosticEventRow
              key={`${event.kind}-${event.ts}-${event.tid ?? ''}-${event.sid ?? ''}`}
              event={event}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function getRecentActivityStatusCopy(status: RecentDiagnosticContextStatus): string | null {
  switch (status) {
    case 'loading':
      return RECENT_ACTIVITY_LOADING_COPY;
    case 'error':
      return RECENT_ACTIVITY_ERROR_COPY;
    case 'empty':
      return RECENT_ACTIVITY_EMPTY_COPY;
    case 'readerUnavailable':
      return RECENT_ACTIVITY_READER_UNAVAILABLE_COPY;
    case 'populated':
      return null;
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function countIncludedSections(sections: DiagnosticSections): number {
  return DIAGNOSTIC_SECTION_DESCRIPTORS.filter((section) => sections[section.id] !== false).length;
}

/**
 * Feedback dialog for bug reports (→ Sentry + auto-Linear) and
 * feedback/ideas (→ Discourse community or fallback link).
 */
export function BugReportDialog({
  open,
  onOpenChange,
  onSuccess,
  onError,
  conversationId,
  defaultFeedbackType,
  prefill,
}: FeedbackDialogProps) {
  const [feedbackType, setFeedbackType] = useState<FeedbackType>('bug');
  const [urgency, setUrgency] = useState<UrgencyLevel>('medium');
  const [description, setDescription] = useState('');
  const [feedbackTitle, setFeedbackTitle] = useState('');
  const [stepsToReproduce, setStepsToReproduce] = useState('');
  const [expectedBehavior, setExpectedBehavior] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [attachContinuityDiagnostics, setAttachContinuityDiagnostics] = useState(false);
  const [diagnosticSections, setDiagnosticSections] = useState<DiagnosticSections>(() => createDefaultDiagnosticSections());

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [screenshot, setScreenshot] = useState<ScreenshotData | null>(null);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeReaderRef = useRef<FileReader | null>(null);

  const [discourseWriteConnected, setDiscourseWriteConnected] = useState(false);

  // Check Discourse MCP connection on dialog open (non-blocking).
  // skipMetadata: true avoids a slow router metadata fetch; server presence
  // in the config is sufficient — the submit handler re-validates before calling MCP.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const api = window.settingsApi;
    if (!api) return;
    api.mcpSummary({ skipMetadata: true }).then((summary) => {
      if (cancelled) return;
      const connected = summary.servers?.some(
        (s: { name?: string; disabled?: boolean }) =>
          s.name === 'RebelsCommunityWrite' && !s.disabled
      ) ?? false;
      setDiscourseWriteConnected(connected);
    }).catch(() => {
      if (!cancelled) setDiscourseWriteConnected(false);
    });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    return () => {
      if (activeReaderRef.current) {
        activeReaderRef.current.abort();
        activeReaderRef.current = null;
      }
    };
  }, []);

  const prevOpenRef = useRef(open);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      if (defaultFeedbackType) {
        setFeedbackType(defaultFeedbackType);
      }
      if (prefill?.description) {
        setDescription(prefill.description);
      }
      if (prefill?.stepsToReproduce) {
        setStepsToReproduce(prefill.stepsToReproduce);
      }
      if (prefill?.expectedBehavior) {
        setExpectedBehavior(prefill.expectedBehavior);
      }
      if (prefill?.attachContinuityDiagnostics) {
        setAttachContinuityDiagnostics(true);
      }
    }
    prevOpenRef.current = open;
  }, [open, defaultFeedbackType, prefill]);

  useEffect(() => {
    if (!includeDiagnostics && attachContinuityDiagnostics) {
      setAttachContinuityDiagnostics(false);
    }
  }, [includeDiagnostics, attachContinuityDiagnostics]);

  const handleFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const allowedTypes = ['image/png', 'image/jpeg', 'image/gif'];
    if (!allowedTypes.includes(file.type)) {
      setScreenshotError('Please upload a PNG, JPG, or GIF image');
      return;
    }

    if (file.size > MAX_SCREENSHOT_SIZE_MB * 1024 * 1024) {
      setScreenshotError(`Image must be smaller than ${MAX_SCREENSHOT_SIZE_MB}MB`);
      return;
    }

    if (activeReaderRef.current) {
      activeReaderRef.current.abort();
    }

    const reader = new FileReader();
    activeReaderRef.current = reader;
    const mimeType = file.type;

    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      const base64Data = dataUrl.split(',')[1];

      const img = new Image();
      img.onload = () => {
        setScreenshot({ base64Data, width: img.width, height: img.height, sizeBytes: file.size, mimeType });
        setScreenshotError(null);
        activeReaderRef.current = null;
      };
      img.onerror = () => {
        setScreenshotError('Failed to process image - file may be corrupted');
        activeReaderRef.current = null;
      };
      img.src = dataUrl;
    };
    reader.onerror = () => {
      setScreenshotError('Failed to read image file');
      activeReaderRef.current = null;
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  }, []);

  const removeScreenshot = useCallback(() => {
    setScreenshot(null);
    setScreenshotError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const triggerFileUpload = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const resetForm = useCallback(() => {
    setFeedbackType('bug');
    setUrgency('medium');
    setDescription('');
    setFeedbackTitle('');
    setStepsToReproduce('');
    setExpectedBehavior('');
    setIncludeDiagnostics(true);
    setAttachContinuityDiagnostics(false);
    setDiagnosticSections(createDefaultDiagnosticSections());
    setError(null);
    setScreenshot(null);
    setScreenshotError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!newOpen) resetForm();
      onOpenChange(newOpen);
    },
    [onOpenChange, resetForm]
  );

  const handleOpenCommunity = useCallback(() => {
    window.appApi?.openUrl(REBELS_COMMUNITY_URL);
  }, []);

  const setDiagnosticSection = useCallback((sectionId: SectionId, enabled: boolean) => {
    setDiagnosticSections((current) => ({
      ...current,
      [sectionId]: enabled,
    }));
  }, []);

  const handleSubmitBug = useCallback(async () => {
    if (!description.trim()) {
      setError("Add a few words about what happened — even one sentence helps.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await window.bugReportApi.submitBug({
        description: description.trim(),
        stepsToReproduce: stepsToReproduce.trim() || undefined,
        expectedBehavior: expectedBehavior.trim() || undefined,
        urgency,
        screenshotBase64: screenshot?.base64Data,
        screenshotMimeType: screenshot?.mimeType,
        includeEnrichedDiagnostics: includeDiagnostics,
        ...(attachContinuityDiagnostics ? { attachContinuityDiagnostics: true } : {}),
        ...(includeDiagnostics ? { diagnosticSections } : {}),
        conversationId,
      });

      if (response.outcome === 'accepted' || response.outcome === 'submitted') {
        // 'accepted': new async flow — dialog closes, background task will broadcast completion
        // 'submitted': legacy synchronous flow (shouldn't happen with new code)
        onSuccess?.('pending');
        handleOpenChange(false);
      } else {
        setError(response.error);
        onError?.(new Error(response.error));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'An unexpected error occurred';
      setError(msg);
      onError?.(err instanceof Error ? err : new Error(msg));
    } finally {
      setIsSubmitting(false);
    }
  }, [description, stepsToReproduce, expectedBehavior, urgency, includeDiagnostics, attachContinuityDiagnostics, diagnosticSections, screenshot, conversationId, onSuccess, onError, handleOpenChange]);

  const handleSubmitFeedback = useCallback(async () => {
    if (!description.trim()) {
      setError("Add a few words — even one sentence helps.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const title = feedbackTitle.trim() || 'Improvement idea';
      const response = await window.bugReportApi.submitFeedback({
        title,
        description: description.trim(),
        feedbackType: feedbackType as 'improvement',
      });

      if (response.outcome === 'submitted') {
        window.appApi?.openUrl(response.discourseTopicUrl);
        onSuccess?.(response.discourseTopicUrl);
        handleOpenChange(false);
      } else if (response.outcome === 'fallback') {
        window.appApi?.openUrl(response.fallbackUrl);
        handleOpenChange(false);
      } else {
        setError(response.error);
        onError?.(new Error(response.error));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'An unexpected error occurred';
      setError(msg);
      onError?.(err instanceof Error ? err : new Error(msg));
    } finally {
      setIsSubmitting(false);
    }
  }, [description, feedbackTitle, feedbackType, onSuccess, onError, handleOpenChange]);

  const handleSubmit = useCallback(async () => {
    if (feedbackType === 'bug') {
      await handleSubmitBug();
    } else if (discourseWriteConnected) {
      await handleSubmitFeedback();
    } else {
      handleOpenCommunity();
      handleOpenChange(false);
    }
  }, [feedbackType, discourseWriteConnected, handleSubmitBug, handleSubmitFeedback, handleOpenCommunity, handleOpenChange]);

  const isBugMode = feedbackType === 'bug';
  const isFeedbackMode = !isBugMode;
  const showFeedbackForm = isFeedbackMode && discourseWriteConnected;
  const showFeedbackLink = isFeedbackMode && !discourseWriteConnected;
  const isDescriptionValid = description.trim().length > 0;
  const remainingChars = MAX_DESCRIPTION_LENGTH - description.length;
  const systemInfo = getSystemInfo();

  const canSubmit = isBugMode
    ? isDescriptionValid
    : showFeedbackForm
      ? isDescriptionValid
      : true; // link mode always enabled

  const getHeaderIcon = () => {
    switch (feedbackType) {
      case 'improvement': return <Lightbulb size={24} className={styles.headerIcon} />;
      default: return <Bug size={24} className={styles.headerIcon} />;
    }
  };

  const getSubmitLabel = () => {
    if (isSubmitting) return 'Sending...';
    if (isBugMode) return 'Report Bug';
    if (showFeedbackLink) return 'Open Community';
    return 'Post Feedback';
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="md" className={styles.dialogContent}>
        <DialogHeader icon={getHeaderIcon()} onClose={() => handleOpenChange(false)}>
          <DialogTitle>Feedback & Bugs</DialogTitle>
          <DialogDescription>
            {isBugMode
              ? "Tell us what went wrong and we'll get it to the team. We read every report, though we can't always reply."
              : <>Share your ideas with the{' '}
                  <a
                    href="https://rebels.mindstone.com/c/feature-requests/7"
                    onClick={(e) => { e.preventDefault(); window.appApi?.openUrl('https://rebels.mindstone.com/c/feature-requests/7'); }}
                    style={{ textDecoration: 'underline', color: 'inherit' }}
                  >Rebels community</a>.
                </>}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className={styles.dialogBody}>
          {/* Feedback Type & Urgency (urgency only for bugs) */}
          <div className={styles.formRow}>
            <div className={styles.formGroup}>
              <Label htmlFor="feedback-type">What type of feedback?</Label>
              <Select
                id="feedback-type"
                value={feedbackType}
                onChange={(e) => setFeedbackType(e.target.value as FeedbackType)}
                disabled={isSubmitting}
              >
                <option value="bug">Bug report</option>
                <option value="improvement">Improvement idea</option>

              </Select>
            </div>

            {isBugMode && (
              <div className={styles.formGroup}>
                <Label htmlFor="urgency">How urgent?</Label>
                <Select
                  id="urgency"
                  value={urgency}
                  onChange={(e) => setUrgency(e.target.value as UrgencyLevel)}
                  disabled={isSubmitting}
                >
                  <option value="low">Not urgent</option>
                  <option value="medium">Somewhat urgent</option>
                  <option value="high">Very urgent</option>
                  <option value="critical">Blocking my work</option>
                </Select>
              </div>
            )}
          </div>

          {/* Feedback link state: no form, just a CTA */}
          {showFeedbackLink && (
            <div className={styles.optionsSection}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: '0.875rem' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Users size={16} />
                  <strong>Share on the Rebels community</strong>
                </span>
                <span style={{ opacity: 0.7 }}>
                  Post your feedback on our community forum where other users and the team can discuss it.
                </span>
              </div>
            </div>
          )}

          {/* Title field (feedback with Discourse only) */}
          {showFeedbackForm && (
            <div className={styles.formGroup}>
              <Label htmlFor="feedback-title">Title</Label>
              <Input
                id="feedback-title"
                placeholder="Give your feedback a short title..."
                value={feedbackTitle}
                onChange={(e) => setFeedbackTitle(e.target.value)}
                disabled={isSubmitting}
              />
            </div>
          )}

          {/* Description (bugs always, feedback only when Discourse connected) */}
          {(isBugMode || showFeedbackForm) && (
            <div className={styles.formGroup}>
              <Label htmlFor="feedback-description">
                {isBugMode ? 'What happened?' : 'What would you like to see?'}
              </Label>
              <Textarea
                id="feedback-description"
                placeholder={isBugMode
                  ? "Describe what went wrong..."
                  : "Describe the improvement you'd like..."}
                value={description}
                onChange={(e) => {
                  if (e.target.value.length <= MAX_DESCRIPTION_LENGTH) setDescription(e.target.value);
                }}
                rows={3}
                error={!!error && !isDescriptionValid}
                disabled={isSubmitting}
                className={styles.textarea}
              />
              <div className={styles.charCount}>
                {remainingChars < 500 && (
                  <span className={remainingChars < 100 ? styles.charCountWarning : ''}>
                    {remainingChars} characters remaining
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Steps to Reproduce (bugs only) */}
          {isBugMode && (
            <div className={styles.formGroup}>
              <Label htmlFor="steps-to-reproduce">
                Steps to reproduce <span className={styles.optionalLabel}>(optional)</span>
              </Label>
              <Textarea
                id="steps-to-reproduce"
                placeholder={"1. Go to...\n2. Click on...\n3. See error..."}
                value={stepsToReproduce}
                onChange={(e) => setStepsToReproduce(e.target.value)}
                rows={2}
                disabled={isSubmitting}
                className={styles.textarea}
              />
            </div>
          )}

          {/* Expected Behavior (bugs only) */}
          {isBugMode && (
            <div className={styles.formGroup}>
              <Label htmlFor="expected-behavior">
                What did you expect? <span className={styles.optionalLabel}>(optional)</span>
              </Label>
              <Textarea
                id="expected-behavior"
                placeholder="I expected..."
                value={expectedBehavior}
                onChange={(e) => setExpectedBehavior(e.target.value)}
                rows={2}
                disabled={isSubmitting}
                className={styles.textarea}
              />
            </div>
          )}

          {/* Screenshot (bugs only) */}
          {isBugMode && (
            <div className={styles.attachmentSection}>
              <Label>Screenshot <span className={styles.optionalLabel}>(optional)</span></Label>

              {screenshot ? (
                <div className={styles.screenshotPreview}>
                  <div className={styles.screenshotContainer}>
                    <img
                      src={`data:${screenshot.mimeType};base64,${screenshot.base64Data}`}
                      alt="Screenshot preview"
                      className={styles.screenshotImage}
                    />
                    <button
                      type="button"
                      onClick={removeScreenshot}
                      className={styles.removeScreenshotButton}
                      aria-label="Remove screenshot"
                      disabled={isSubmitting}
                    >
                      <X size={14} />
                    </button>
                  </div>
                  <span className={styles.screenshotInfo}>
                    {screenshot.width}x{screenshot.height} &bull; {Math.round(screenshot.sizeBytes / 1024)}KB
                  </span>
                </div>
              ) : (
                <div className={styles.uploadArea}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif"
                    onChange={handleFileUpload}
                    className={styles.hiddenInput}
                    disabled={isSubmitting}
                  />
                  <button
                    type="button"
                    onClick={triggerFileUpload}
                    className={styles.uploadButton}
                    disabled={isSubmitting}
                  >
                    <Upload size={16} />
                    <span>Upload screenshot</span>
                  </button>
                  <span className={styles.uploadHint}>PNG, JPG, or GIF up to {MAX_SCREENSHOT_SIZE_MB}MB</span>
                </div>
              )}

              {screenshotError && (
                <div className={styles.screenshotError}>
                  <ImageIcon size={14} className={styles.screenshotErrorIcon} />
                  <span>{screenshotError}</span>
                </div>
              )}
            </div>
          )}

          {isBugMode && <BugReportRecentActivityPreview />}

          {/* Diagnostics Toggle (bugs only) */}
          {isBugMode && (
            <div className={styles.optionsSection}>
              <label className={styles.checkboxLabel} title="Includes app health, error patterns, and timing data. Never includes your conversations, files, or personal data.">
                <input
                  type="checkbox"
                  checked={includeDiagnostics}
                  onChange={(e) => setIncludeDiagnostics(e.target.checked)}
                  disabled={isSubmitting}
                  className={styles.checkbox}
                />
                <span>Send extra diagnostic info to Mindstone</span>
                <span className={styles.optionalLabel}>(helps us investigate)</span>
              </label>

              {includeDiagnostics && (
                <label
                  className={styles.checkboxSubLabel}
                  title="Includes continuity snapshots (outbox, workspace sync state, and continuity metadata) in diagnostics."
                >
                  <input
                    type="checkbox"
                    checked={attachContinuityDiagnostics}
                    onChange={(e) => setAttachContinuityDiagnostics(e.target.checked)}
                    disabled={isSubmitting}
                    className={styles.checkbox}
                  />
                  <span>Attach continuity diagnostics</span>
                  <span className={styles.optionalLabel}>(for sync/outbox issues)</span>
                </label>
              )}

              {includeDiagnostics && (
                <div className={styles.sectionToggleList} data-testid="bug-report-section-toggles">
                  <div className={styles.sectionToggleHeader}>
                    <strong>Diagnostic sections</strong>
                    <span className={styles.optionalLabel}>
                      {countIncludedSections(diagnosticSections)} of {DIAGNOSTIC_SECTION_DESCRIPTORS.length} included
                    </span>
                  </div>
                  {DIAGNOSTIC_SECTION_DESCRIPTORS.map((section) => (
                    <label
                      key={section.id}
                      className={styles.sectionToggleRow}
                      data-testid={`bug-report-section-${section.id}`}
                    >
                      <span className={styles.sectionToggleCopy}>
                        <span className={styles.sectionToggleTitle}>{section.label}</span>
                        <span className={styles.sectionToggleDescription}>
                          {section.description} {section.privacyHint}
                        </span>
                      </span>
                      <Toggle
                        checked={diagnosticSections[section.id] !== false}
                        onCheckedChange={(checked) => setDiagnosticSection(section.id, checked)}
                        disabled={isSubmitting}
                        aria-label={`Include ${section.label}`}
                      />
                    </label>
                  ))}
                </div>
              )}

              {screenshot && (
                <div className={styles.privacyWarning}>
                  <AlertTriangle size={14} className={styles.warningIcon} />
                  <span>Screenshots may contain visible sensitive information</span>
                </div>
              )}
            </div>
          )}

          {/* System Info Display */}
          <div className={styles.systemInfo}>
            <span>Version {systemInfo.appVersion}</span>
            <span className={styles.separator}>&bull;</span>
            <span>{systemInfo.platform}</span>
          </div>

          {error && (
            <div className={styles.errorMessage} role="alert" aria-live="polite">
              {error}
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || !canSubmit}
          >
            {showFeedbackLink && <ExternalLink size={14} />}
            {getSubmitLabel()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
