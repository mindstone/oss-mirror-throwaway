/**
 * OnboardingCoachIntro
 * 
 * A welcoming intro card shown at the start of the onboarding coach conversation.
 * Explains why Rebel is asking questions and what makes this different from typical AI tools.
 * 
 * Design:
 * - Appears inline with the chat interface (not a modal or overlay)
 * - Uses the default Rebel avatar with a subtle animation
 * - Includes a dismiss button for users who want to skip
 * - Stays visible alongside Rebel's first question
 */

import { memo, useState, useRef, useEffect } from 'react';
import { X, ShieldCheck, Database, Clock } from 'lucide-react';
import styles from './OnboardingCoachIntro.module.css';

const REBEL_MASCOT_ANIMATED_URL = 'https://storage.googleapis.com/mindstone-public-assets/rebel/intro-welcome.gif';
const REBEL_MASCOT_STATIC_URL = 'https://storage.googleapis.com/mindstone-public-assets/rebel/rebel4.png';

interface OnboardingCoachIntroProps {
  /** Called when user dismisses the intro */
  onDismiss?: () => void;
  /** Whether to show the dismiss button */
  showDismiss?: boolean;
}

export const OnboardingCoachIntro = memo(({ 
  onDismiss,
  showDismiss = true,
}: OnboardingCoachIntroProps) => {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const dismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timeout on unmount to prevent calling onDismiss after unmount
  useEffect(() => {
    return () => {
      if (dismissTimeoutRef.current) {
        clearTimeout(dismissTimeoutRef.current);
      }
    };
  }, []);

  const handleDismiss = () => {
    setIsDismissed(true);
    // Wait for animation to complete before calling onDismiss
    dismissTimeoutRef.current = setTimeout(() => {
      onDismiss?.();
    }, 300);
  };

  const avatarSrc = avatarFailed ? REBEL_MASCOT_STATIC_URL : REBEL_MASCOT_ANIMATED_URL;

  if (isDismissed) {
    return null;
  }

  return (
    <div className={styles.introContainer} role="banner" aria-label="Welcome to Rebel">
      <div className={styles.introCard}>
        {/* Avatar - centered at top */}
        <div className={styles.avatarContainer} aria-hidden="true">
          <img
            src={avatarSrc}
            alt=""
            className={styles.avatarMascot}
            onError={() => setAvatarFailed(true)}
          />
        </div>

        {/* Content - below avatar */}
        <p className={styles.greeting}>Nice to meet you, I'm Rebel</p>
        <p className={styles.explanation}>
          I'd like to learn about your goals and how you work. This helps me 
          figure out which tasks are worth your time, what to remember, and 
          how to actually be useful to you. I only need to ask once.
        </p>
        {/* Trust signals - privacy and cost transparency */}
        <div className={styles.trustSection}>
          <div className={styles.trustItem}>
            <ShieldCheck size={16} className={styles.trustIcon} aria-hidden />
            <div>
              <p className={styles.trustLabel}>Stored on your device, not the cloud</p>
              <p className={styles.trustDescription}>
                Your conversations and files stay on your computer. AI providers process requests but don't retain them.
              </p>
            </div>
          </div>
          <div className={styles.trustItem}>
            <Database size={16} className={styles.trustIcon} aria-hidden />
            <div>
              <p className={styles.trustLabel}>Your credits, your control</p>
              <p className={styles.trustDescription}>
                I use your AI credits (API key) to work. Setup uses more as I go through your calendar, inbox, and apps. After that, daily use is much lighter.
              </p>
            </div>
          </div>
          <div className={styles.trustItem}>
            <Clock size={16} className={styles.trustIcon} aria-hidden />
            <div>
              <p className={styles.trustLabel}>It will take approximately five minutes</p>
            </div>
          </div>
        </div>

        {/* Dismiss button */}
        {showDismiss && (
          <button
            type="button"
            className={styles.dismissButton}
            onClick={handleDismiss}
            aria-label="Dismiss intro"
          >
            <X size={16} />
          </button>
        )}
      </div>

      <div className={styles.workspacePrep}>
        <span className={styles.workspacePrepDot} aria-hidden />
        <span>Preparing your workspace</span>
      </div>
    </div>
  );
});

OnboardingCoachIntro.displayName = 'OnboardingCoachIntro';
