import { memo } from 'react';
import { Sun, Moon } from 'lucide-react';
import type { ThemePreference } from '@shared/types';
import { Tooltip } from './Tooltip';
import styles from './ThemeToggle.module.css';

export interface ThemeToggleProps {
  theme: ThemePreference;
  onToggle: () => void;
  className?: string;
}

/**
 * A theme toggle button with animated sun/moon icons.
 * Shows sun icon when in dark mode (to switch to light).
 * Shows moon icon when in light mode (to switch to dark).
 */
const ThemeToggleComponent = ({ theme, onToggle, className }: ThemeToggleProps) => {
  const isDark = theme === 'dark';
  
  return (
    <Tooltip content={isDark ? 'Switch to light mode' : 'Switch to dark mode'}>
      <button
        type="button"
        className={`${styles.toggle} ${className ?? ''}`}
        onClick={onToggle}
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        <span className={`${styles.iconWrapper} ${isDark ? styles.showSun : styles.showMoon}`}>
          <Sun className={`${styles.icon} ${styles.sunIcon}`} size={18} strokeWidth={2} />
          <Moon className={`${styles.icon} ${styles.moonIcon}`} size={18} strokeWidth={2} />
        </span>
      </button>
    </Tooltip>
  );
};

export const ThemeToggle = memo(ThemeToggleComponent);
ThemeToggle.displayName = 'ThemeToggle';

