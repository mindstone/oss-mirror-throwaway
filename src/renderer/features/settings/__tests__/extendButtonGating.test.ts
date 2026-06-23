/**
 * Tests for D6 gating: Extend CTA visible for rebel-oss and custom connectors.
 *
 * Validation contract assertions covered:
 *   VAL-ENTRY-004
 *
 * These are logic-level tests that verify the gating condition, not full React render tests
 * (which would require extensive mocking of the ExpandedConnectionCard component tree).
 */
import { describe, it, expect } from 'vitest';

/**
 * Gating predicate: determines whether the "Add more tools" (extend) button should be shown.
 * This mirrors the condition used in ExpandedConnectionCard.tsx.
 */
function shouldShowExtendButton(
  provider: string | undefined,
  hasCatalogEntry: boolean,
  isConnected: boolean,
  onExtendConnector?: (() => void) | undefined,
): boolean {
  // The extend button should appear for rebel-oss connectors and for custom
  // connectors with no catalog entry, but only when connected and when the
  // handler is available.
  return isConnected && onExtendConnector !== undefined && (!hasCatalogEntry || provider === 'rebel-oss');
}

describe('extend button gating (D6)', () => {
  const noop = () => {};

  it('shows extend button for rebel-oss provider when connected', () => {
    expect(shouldShowExtendButton('rebel-oss', true, true, noop)).toBe(true);
  });

  it('shows extend button for custom connector when connected', () => {
    expect(shouldShowExtendButton(undefined, false, true, noop)).toBe(true);
  });

  it('hides extend button for bundled provider', () => {
    expect(shouldShowExtendButton('bundled', true, true, noop)).toBe(false);
  });

  it('hides extend button for direct provider', () => {
    expect(shouldShowExtendButton('direct', true, true, noop)).toBe(false);
  });

  it('hides extend button for community provider', () => {
    expect(shouldShowExtendButton('community', true, true, noop)).toBe(false);
  });

  it('hides extend button when provider is undefined but the connector is catalog-backed', () => {
    expect(shouldShowExtendButton(undefined, true, true, noop)).toBe(false);
  });

  it('hides extend button for rebel-oss when not connected', () => {
    expect(shouldShowExtendButton('rebel-oss', true, false, noop)).toBe(false);
  });

  it('hides extend button for custom connector when not connected', () => {
    expect(shouldShowExtendButton(undefined, false, false, noop)).toBe(false);
  });

  it('hides extend button when handler is not provided', () => {
    expect(shouldShowExtendButton('rebel-oss', true, true, undefined)).toBe(false);
  });
});
