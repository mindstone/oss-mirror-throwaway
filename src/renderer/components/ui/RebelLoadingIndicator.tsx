import { useEffect, useState } from 'react';
import { cn } from '@renderer/lib/utils';
import styles from './RebelLoadingIndicator.module.css';
import loadingGif from '@renderer/assets/animations/loading.gif';

const REBEL_LOADING_FALLBACK_URL = 'https://storage.googleapis.com/mindstone-public-assets/rebel/rebel4.png';

export type RebelLoadingIndicatorSize = 'sm' | 'md' | 'lg';
export type RebelLoadingIndicatorLayout = 'inline' | 'stacked';
export type RebelLoadingIndicatorMotion = 'auto' | 'animated' | 'static';

export interface RebelLoadingIndicatorProps {
  size?: RebelLoadingIndicatorSize;
  layout?: RebelLoadingIndicatorLayout;
  motion?: RebelLoadingIndicatorMotion;
  label?: string;
  description?: string;
  className?: string;
}

export function RebelLoadingIndicator({
  size = 'md',
  layout = 'inline',
  motion = 'auto',
  label = 'Rebel is thinking',
  description,
  className,
}: RebelLoadingIndicatorProps) {
  const [useFallback, setUseFallback] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() =>
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  const imageSizeClass = {
    sm: styles.imageSm,
    md: styles.imageMd,
    lg: styles.imageLg,
  }[size];
  const shouldUseStaticImage = useFallback || motion === 'static' || (motion === 'auto' && prefersReducedMotion);

  useEffect(() => {
    if (motion !== 'auto' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = () => setPrefersReducedMotion(mediaQuery.matches);

    handleChange();
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [motion]);

  return (
    <div
      className={cn(styles.root, layout === 'stacked' && styles.stacked, className)}
      role="status"
      aria-live="polite"
      aria-label={description ? `${label}. ${description}` : label}
    >
      <img
        src={shouldUseStaticImage ? REBEL_LOADING_FALLBACK_URL : loadingGif}
        alt=""
        aria-hidden="true"
        className={cn(styles.image, imageSizeClass)}
        onError={() => setUseFallback(true)}
      />
      {(label || description) && (
        <div className={styles.copy}>
          {label && <p className={styles.label}>{label}</p>}
          {description && <p className={styles.description}>{description}</p>}
        </div>
      )}
    </div>
  );
}
