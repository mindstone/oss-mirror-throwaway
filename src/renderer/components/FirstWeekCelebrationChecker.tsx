import { useEffect, useRef } from 'react';

type FirstWeekCelebrationCheckerProps = {
  onTrigger: () => void;
};

export const FirstWeekCelebrationChecker = ({ onTrigger }: FirstWeekCelebrationCheckerProps) => {
  const checkedRef = useRef(false);

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;

    const check = async () => {
      try {
        const shouldShow = await window.api.shouldShowFirstWeek();
        if (shouldShow) {
          await window.api.markFirstWeekShown();
          onTrigger();
        }
      } catch (error) {
        console.error('Failed to check first week celebration:', error);
      }
    };

    // Small delay to ensure app is settled
    const timer = setTimeout(check, 1000);
    return () => clearTimeout(timer);
  }, [onTrigger]);

  return null;
};
