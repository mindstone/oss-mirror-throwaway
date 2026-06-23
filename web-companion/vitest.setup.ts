/**
 * Vitest global setup for web-companion.
 *
 * Only active in tests that opt into the jsdom environment via
 * `// @vitest-environment jsdom` at the top of the test file. The root
 * `vitest.config.ts` keeps `environment: 'node'` as the default so existing
 * pure-TS suites (bundle-size smoke, e2e.integration, conversationRouteSync)
 * continue to run without DOM overhead.
 */
import '@testing-library/jest-dom/vitest';

// jsdom does not implement layout APIs the app uses at render time.
// Stub them so components that call them (e.g. ConversationScreen's
// scrollToBottom effect) don't explode under test.
if (typeof globalThis !== 'undefined' && typeof globalThis.Element !== 'undefined') {
  if (!globalThis.Element.prototype.scrollIntoView) {
    globalThis.Element.prototype.scrollIntoView = function scrollIntoViewStub(): void {};
  }
}

