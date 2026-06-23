import { useState, useCallback } from 'react';
import styles from './SideAnnotation.module.css';

const DISMISSED_TIPS_KEY = 'onboarding-dismissed-tips';

function getDismissedTips(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_TIPS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

type SideAnnotationProps = {
  id: string;
  children: React.ReactNode;
  top?: number;
  bottom?: number;
  onDismiss?: () => void;
};

export const SideAnnotation = ({ id, children, top, bottom, onDismiss }: SideAnnotationProps) => {
  const [dismissed, setDismissed] = useState(() => getDismissedTips().has(id));

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    const tips = getDismissedTips();
    tips.add(id);
    localStorage.setItem(DISMISSED_TIPS_KEY, JSON.stringify([...tips]));
    onDismiss?.();
  }, [id, onDismiss]);

  if (dismissed) return null;

  const positionStyle: React.CSSProperties | undefined =
    bottom != null ? { top: 'auto', bottom } : top != null ? { top } : undefined;

  return (
    <div className={styles.sideAnnotation} role="note" style={positionStyle}>
      <div className={styles.arrow} />
      <p className={styles.text}>{children}</p>
      <button
        type="button"
        className={styles.dismissLink}
        onClick={handleDismiss}
        aria-label="Dismiss tip"
      >
        Dismiss
      </button>
    </div>
  );
};
