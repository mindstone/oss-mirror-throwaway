/// <reference types="@welldone-software/why-did-you-render" />
/* eslint-disable no-console -- why-did-you-render: development-only profiling tool */

// React 19 dev mode passes component props through performance.measure() detail,
// which uses structured clone. Non-serializable props (functions, stores, circular
// refs) or very large objects cause DataCloneError. Harmless to suppress — this
// only affects DevTools Performance timeline annotations.
if (import.meta.env.DEV && typeof performance !== 'undefined' && performance.measure) {
  const originalMeasure = performance.measure.bind(performance);
  performance.measure = function (...args: Parameters<Performance['measure']>) {
    try {
      return originalMeasure(...args);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'DataCloneError') {
        return undefined as unknown as PerformanceMeasure;
      }
      throw e;
    }
  };
}

// why-did-you-render: React re-render debugging tool
// Only loads when VITE_PERFORMANCE=true (opt-in to avoid dev mode overhead)
// Usage: npm run dev:perf
if (import.meta.env.DEV && import.meta.env.VITE_PERFORMANCE === 'true') {
  console.debug('[wdyr] Loading why-did-you-render...');

  const React = await import('react');
  const { default: whyDidYouRender } = await import('@welldone-software/why-did-you-render');

  whyDidYouRender(React.default ?? React, {
    trackAllPureComponents: true,
    // Custom notifier to prevent DevTools from retaining large React state objects.
    // The default notifier passes full component props/state to console.log, which
    // causes massive memory leaks (50MB/min) during periodic IDLE re-renders.
    notifier: (updateInfo: unknown) => {
      const info = updateInfo as {
        Component: { displayName?: string; name?: string };
        reason: {
          propsDifferences?: Record<string, unknown>;
          stateDifferences?: Record<string, unknown>;
          hookDifferences?: unknown[];
        };
      };
      const name = info.Component.displayName || info.Component.name || 'Component';
      
      // Extract keys of what changed to avoid object retention
      const changes: string[] = [];
      if (info.reason.propsDifferences) {
        changes.push(`Props: ${Object.keys(info.reason.propsDifferences).join(', ')}`);
      }
      if (info.reason.stateDifferences) {
        changes.push(`State: ${Object.keys(info.reason.stateDifferences).join(', ')}`);
      }
      if (info.reason.hookDifferences) {
        changes.push(`Hooks: ${info.reason.hookDifferences.length} changed`);
      }
      
      const reasonText = changes.length > 0 ? changes.join(' | ') : 'Unknown/Force Render';
      console.debug(`[wdyr] ${name} re-rendered. Reason: ${reasonText}`);
    },
  });

  console.debug('[wdyr] Initialized - tracking re-renders');
}
