import { useCallback, useEffect, useRef } from 'react';

const resolveFocusTarget = (element: Element): HTMLElement => {
  const host = element as HTMLElement;
  const explicitFocusSectionId = host.getAttribute('data-focus-target-section');
  if (explicitFocusSectionId) {
    const escaped = CSS.escape(explicitFocusSectionId);
    const explicitTarget = document.querySelector(
      `[data-section="${escaped}"] [data-section-focus-target]`
    ) as HTMLElement | null;
    if (explicitTarget) {
      return explicitTarget;
    }
  }

  const nestedTarget = host.querySelector('[data-section-focus-target]') as HTMLElement | null;
  return nestedTarget ?? host;
};

const focusSectionTarget = (element: Element) => {
  const target = resolveFocusTarget(element);
  const hadTabIndex = target.hasAttribute('tabindex');
  if (!hadTabIndex) {
    target.setAttribute('tabindex', '-1');
  }
  target.focus({ preventScroll: true });
  const cleanup = () => {
    if (!hadTabIndex) {
      target.removeAttribute('tabindex');
    }
    target.removeEventListener('blur', cleanup);
  };
  target.addEventListener('blur', cleanup);
};

/**
 * Hook to scroll to a specific section within the Settings panel.
 * Part of the Unified Navigation System (Stage 5).
 *
 * @param sectionId - The section ID to scroll to (matches `data-section` attribute)
 * @param deps - Additional dependencies that trigger scroll attempt (e.g., activeTab changes)
 *
 * The hook will:
 * 1. Query for `[data-section="${sectionId}"]`
 * 2. Retry up to 10 times with 100ms intervals (for elements not yet rendered)
 * 3. Check if section is within a collapsed Advanced panel and expand it
 * 4. Smooth scroll to the element
 * 5. Apply a brief highlight animation
 * 6. Clear the section after scrolling (via onScrollComplete callback)
 */
export const useScrollToSection = (
  sectionId: string | undefined,
  onScrollComplete?: () => void,
  deps: unknown[] = []
) => {
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasScrolledRef = useRef(false);

  const performScroll = useCallback((element: Element) => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Mark as scrolled to prevent duplicate scrolls
    hasScrolledRef.current = true;

    // Scroll with enough offset for the app chrome plus breathing room
    // so section headings do not land clipped at the top edge.
    const explicitScrollMarginTop = Number.parseFloat(
      window.getComputedStyle(element as HTMLElement).scrollMarginTop || '0'
    );
    const headerOffset = explicitScrollMarginTop > 0 ? explicitScrollMarginTop : 120;
    const elementRect = element.getBoundingClientRect();
    const scrollContainer = document.querySelector('[data-settings-scroll-root]') as HTMLElement | null;
    
    if (scrollContainer) {
      const containerRect = scrollContainer.getBoundingClientRect();
      const targetScrollTop = scrollContainer.scrollTop + elementRect.top - containerRect.top - headerOffset;
      
      scrollContainer.scrollTo({
        top: targetScrollTop,
        behavior: reducedMotion ? 'auto' : 'smooth'
      });
    } else {
      // Fallback to element.scrollIntoView
      element.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    }

    // Apply highlight animation
    if (!reducedMotion) {
      element.classList.add('section-highlight');
      setTimeout(() => {
        element.classList.remove('section-highlight');
      }, 2000);
    }

    // Move focus so keyboard and screen-reader users land on the resolved section.
    focusSectionTarget(element);

    // Notify parent that scroll is complete
    onScrollComplete?.();
  }, [onScrollComplete]);

  const scrollToSection = useCallback(() => {
    if (!sectionId || hasScrolledRef.current) return;

    // Escape sectionId to prevent querySelector injection from malformed URL fragments
    const escapedId = CSS.escape(sectionId);
    const selector = `[data-section="${escapedId}"]`;
    const element = document.querySelector(selector);

    if (!element) {
      // Element not found - retry up to 10 times
      retryCountRef.current += 1;
      if (retryCountRef.current < 10) {
        retryTimerRef.current = setTimeout(scrollToSection, 100);
      }
      return;
    }

    // Expand the advanced panel that owns this element (scoped to nearest [data-advanced-section])
    const advancedSection = element.closest('[data-advanced-section]');
    const advancedContent = advancedSection?.querySelector('[data-advanced-content]');
    const isCollapsedAdvancedSection =
      !!advancedSection && !!advancedContent && !advancedContent.hasAttribute('data-expanded');
    if (isCollapsedAdvancedSection) {
      const toggle = advancedSection.querySelector(':scope > button[data-advanced-toggle]') as HTMLButtonElement | null;
      if (toggle) {
        toggle.click();
        setTimeout(() => performScroll(element), 200);
        return;
      }
    }

    performScroll(element);
  }, [sectionId, performScroll]);

  // Reset and trigger scroll when sectionId or deps change
  useEffect(() => {
    // Clear previous timer
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    retryCountRef.current = 0;
    hasScrolledRef.current = false;

    if (sectionId) {
      // Small delay to allow tab content to render
      const timer = setTimeout(scrollToSection, 50);
      return () => clearTimeout(timer);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- spread of caller-provided deps is intentional; statically unverifiable by design
  }, [sectionId, scrollToSection, ...deps]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
      }
    };
  }, []);
};
