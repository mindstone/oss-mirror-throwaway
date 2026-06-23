import { type PropsWithChildren, useCallback, useLayoutEffect, useRef, useState } from 'react';

type TruncatedTextWithTooltipProps = PropsWithChildren<{
  text: string;
  className?: string;
}>;

const hasOverflow = (element: HTMLElement) => {
  const tolerance = 1;
  return element.scrollWidth - tolerance > element.clientWidth;
};

export const TruncatedTextWithTooltip = ({ text, className, children }: TruncatedTextWithTooltipProps) => {
  const elementRef = useRef<HTMLSpanElement>(null);
  const [showTooltip, setShowTooltip] = useState(false);

  const updateOverflowState = useCallback(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }
    const next = hasOverflow(element);
    setShowTooltip((prev) => (prev === next ? prev : next));
  }, []);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) {
      return undefined;
    }

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => updateOverflowState());
      observer.observe(element);
      return () => observer.disconnect();
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', updateOverflowState);
      return () => window.removeEventListener('resize', updateOverflowState);
    }

    return undefined;
  }, [updateOverflowState]);

  useLayoutEffect(() => {
    updateOverflowState();
  });

  return (
    <span
      ref={elementRef}
      className={className}
      title={showTooltip ? text : undefined}
      aria-label={showTooltip ? text : undefined}
    >
      {children}
      {text}
    </span>
  );
};
