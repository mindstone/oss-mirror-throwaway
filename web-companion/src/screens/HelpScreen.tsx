// web-companion/src/screens/HelpScreen.tsx

import { useState, useCallback, useEffect } from 'react';
import { useAuthStore, checkHealth, submitFeedback } from '@rebel/cloud-client';
import type { FeedbackRequest } from '@rebel/cloud-client';
import { fireAndForget } from '../utils/fireAndForget';
import styles from './HelpScreen.module.css';

type FeedbackType = FeedbackRequest['feedbackType'];
type Urgency = FeedbackRequest['urgency'];

const FEEDBACK_TYPES: { value: FeedbackType; label: string }[] = [
  { value: 'bug', label: 'Bug' },
  { value: 'improvement', label: 'Improvement' },
  { value: 'other', label: 'Something else' },
];

const URGENCY_OPTIONS: { value: Urgency; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

const REBEL_PRODUCT_URL = 'https://www.mindstone.com/rebel';

export function HelpScreen() {
  const { cloudUrl, unpair } = useAuthStore();

  // Disconnect state
  const [isUnpairing, setIsUnpairing] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // Connection info
  const [serverVersion, setServerVersion] = useState<string | null>(null);

  // Feedback form state
  const [feedbackType, setFeedbackType] = useState<FeedbackType>('bug');
  const [urgency, setUrgency] = useState<Urgency>('medium');
  const [message, setMessage] = useState('');
  const [stepsToReproduce, setStepsToReproduce] = useState('');
  const [expectedBehavior, setExpectedBehavior] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    // Best-effort — if the health check fails, leave version unknown (degraded
    // user-visible state: version row hidden). fireAndForget preserves the
    // best-effort semantics while surfacing the cause in DevTools.
    fireAndForget(
      checkHealth().then((health) => {
        if (health.version) setServerVersion(health.version);
      }),
      'HelpScreen:mount:checkHealth',
    );
  }, []);

  const handleDisconnect = useCallback(async () => {
    setIsUnpairing(true);
    try {
      await unpair();
      // unpair() clears auth state, which triggers App.tsx to show AuthScreen.
      // If this resolves the component will unmount before the finally runs.
    } catch (err) {
      // If unpair rejects we'd otherwise leave isUnpairing stuck true (button
      // reads "Disconnecting…" forever) and the error would vanish into the
      // browser's unhandled-rejection warning. Surface it and clear state so
      // the user can retry.
      console.error('[web-companion:HelpScreen:handleDisconnect]', err);
    } finally {
      setIsUnpairing(false);
    }
  }, [unpair]);

  const handleSubmitFeedback = useCallback(async () => {
    if (!message.trim()) return;

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const payload: FeedbackRequest = {
        feedbackType,
        urgency,
        message: message.trim(),
        platform: 'web',
        ...(feedbackType === 'bug' && stepsToReproduce.trim()
          ? { stepsToReproduce: stepsToReproduce.trim() }
          : {}),
        ...(feedbackType === 'bug' && expectedBehavior.trim()
          ? { expectedBehavior: expectedBehavior.trim() }
          : {}),
      };

      await submitFeedback(payload);
      setSubmitSuccess(true);
      // Reset form
      setMessage('');
      setStepsToReproduce('');
      setExpectedBehavior('');
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : 'Failed to send feedback. Please try again.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [feedbackType, urgency, message, stepsToReproduce, expectedBehavior]);

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Help & Support</h1>

      {/* Feedback form card */}
      <div className={styles.card}>
        <span className={styles.cardLabel}>Send Feedback</span>

        {submitSuccess ? (
          <p className={styles.successMessage}>
            Feedback sent. We&apos;ll take it from here.
          </p>
        ) : (
          <>
            {/* Type picker */}
            <div className={styles.pickerRow}>
              {FEEDBACK_TYPES.map(({ value, label }) => (
                <button
                  key={value}
                  className={`${styles.pickerButton} ${feedbackType === value ? styles.pickerButtonActive : ''}`}
                  onClick={() => setFeedbackType(value)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Urgency picker */}
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>Urgency</label>
              <div className={styles.pickerRow}>
                {URGENCY_OPTIONS.map(({ value, label }) => (
                  <button
                    key={value}
                    className={`${styles.pickerButton} ${urgency === value ? styles.pickerButtonActive : ''}`}
                    onClick={() => setUrgency(value)}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Description */}
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel} htmlFor="feedback-message">
                Description
              </label>
              <textarea
                id="feedback-message"
                className={styles.textarea}
                placeholder="What happened?"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                maxLength={5000}
              />
            </div>

            {/* Bug-only fields */}
            {feedbackType === 'bug' && (
              <>
                <div className={styles.fieldGroup}>
                  <label className={styles.fieldLabel} htmlFor="feedback-steps">
                    Steps to reproduce
                  </label>
                  <textarea
                    id="feedback-steps"
                    className={styles.textarea}
                    placeholder="1. Go to… 2. Click on…"
                    value={stepsToReproduce}
                    onChange={(e) => setStepsToReproduce(e.target.value)}
                    rows={3}
                    maxLength={5000}
                  />
                </div>
                <div className={styles.fieldGroup}>
                  <label className={styles.fieldLabel} htmlFor="feedback-expected">
                    Expected behavior
                  </label>
                  <textarea
                    id="feedback-expected"
                    className={styles.textarea}
                    placeholder="What should have happened?"
                    value={expectedBehavior}
                    onChange={(e) => setExpectedBehavior(e.target.value)}
                    rows={3}
                    maxLength={5000}
                  />
                </div>
              </>
            )}

            {/* Error display */}
            {submitError && (
              <p className={styles.errorMessage}>{submitError}</p>
            )}

            {/* Submit button */}
            <button
              className={styles.submitButton}
              onClick={handleSubmitFeedback}
              disabled={isSubmitting || !message.trim()}
              type="button"
            >
              {isSubmitting ? 'Sending…' : 'Send Feedback'}
            </button>
          </>
        )}
      </div>

      {/* Community card */}
      <div className={styles.card}>
        <span className={styles.cardLabel}>Community</span>
        <a
          href="https://rebels.mindstone.com"
          target="_blank"
          rel="noopener noreferrer"
          className={styles.communityLink}
        >
          Ask the Community
          <span className={styles.externalArrow}>↗</span>
        </a>
      </div>

      {/* About Rebel card */}
      <div className={styles.card}>
        <span className={styles.cardLabel}>About Rebel</span>
        <a
          href={REBEL_PRODUCT_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.communityLink}
        >
          Learn more at mindstone.com/rebel
          <span className={styles.externalArrow}>↗</span>
        </a>
      </div>

      {/* Connection info card */}
      <div className={styles.card}>
        <span className={styles.cardLabel}>Connection</span>
        <div className={styles.connectionRow}>
          <span className={styles.connectedDot} />
          <span className={styles.connectionText}>
            Connected to{' '}
            <strong>{cloudUrl?.replace(/^https?:\/\//, '') || 'unknown'}</strong>
          </span>
        </div>
        <div className={styles.infoRow}>
          <span className={styles.infoLabel}>Platform</span>
          <span className={styles.infoValue}>Web</span>
        </div>
        {serverVersion && (
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Server version</span>
            <span className={styles.infoValue}>{serverVersion}</span>
          </div>
        )}
      </div>

      {/* Disconnect */}
      {!showConfirm ? (
        <button
          className={styles.disconnectButton}
          data-testid="help-disconnect"
          onClick={() => setShowConfirm(true)}
          disabled={isUnpairing}
        >
          Disconnect from cloud
        </button>
      ) : (
        <div className={styles.confirmCard}>
          <p className={styles.confirmText}>
            Are you sure? You&apos;ll need to re-pair.
          </p>
          <div className={styles.confirmActions}>
            <button
              className={styles.cancelButton}
              onClick={() => setShowConfirm(false)}
              disabled={isUnpairing}
            >
              Cancel
            </button>
            <button
              className={styles.confirmDisconnect}
              data-testid="help-disconnect-confirm"
              onClick={handleDisconnect}
              disabled={isUnpairing}
            >
              {isUnpairing ? 'Disconnecting…' : 'Yes, disconnect'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
