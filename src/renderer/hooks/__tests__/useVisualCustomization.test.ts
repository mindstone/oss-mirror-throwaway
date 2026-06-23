import { describe, expect, it, vi } from 'vitest';

import type { AppSettings } from '@shared/types/settings';

import { ACCENT_PALETTE } from '../../utils/accentPalette';
import { applyVisualCustomizationOverrides } from '../useVisualCustomization';

class MockStyle {
  private readonly values = new Map<string, string>();

  readonly setProperty = vi.fn((property: string, value: string) => {
    this.values.set(property, value);
  });

  readonly removeProperty = vi.fn((property: string) => {
    this.values.delete(property);
  });

  getPropertyValue(property: string): string {
    return this.values.get(property) ?? '';
  }
}

function createMockDocument(): {
  mockDocument: Document;
  bodyStyle: MockStyle;
  rootStyle: MockStyle;
  rootAttributes: Map<string, string>;
} {
  const bodyStyle = new MockStyle();
  const rootStyle = new MockStyle();
  const rootAttributes = new Map<string, string>();

  const mockDocument = {
    body: { style: bodyStyle as unknown as CSSStyleDeclaration },
    documentElement: {
      style: rootStyle as unknown as CSSStyleDeclaration,
      setAttribute: (name: string, value: string) => { rootAttributes.set(name, value); },
      removeAttribute: (name: string) => { rootAttributes.delete(name); },
      getAttribute: (name: string) => rootAttributes.get(name) ?? null,
    },
  } as unknown as Document;

  return { mockDocument, bodyStyle, rootStyle, rootAttributes };
}

const createSettings = (overrides: Partial<AppSettings>): AppSettings => overrides as AppSettings;

describe('useVisualCustomization', () => {
  it('does not set any properties when settings are null', () => {
    const { mockDocument, bodyStyle, rootStyle } = createMockDocument();

    applyVisualCustomizationOverrides(null, 'light', mockDocument);

    expect(bodyStyle.setProperty).not.toHaveBeenCalled();
    expect(rootStyle.setProperty).not.toHaveBeenCalled();
  });

  it('applies accent overrides on document.body for blue in light mode', () => {
    const { mockDocument, bodyStyle, rootStyle } = createMockDocument();

    applyVisualCustomizationOverrides(createSettings({ accentColor: 'blue' }), 'light', mockDocument);

    for (const [key, value] of Object.entries(ACCENT_PALETTE.blue.light)) {
      expect(bodyStyle.getPropertyValue(key)).toBe(value);
      expect(rootStyle.getPropertyValue(key)).toBe('');
    }
  });

  it('applies font scale large on document.documentElement', () => {
    const { mockDocument, rootStyle } = createMockDocument();

    applyVisualCustomizationOverrides(createSettings({ fontScale: 'large' }), 'light', mockDocument);

    expect(rootStyle.getPropertyValue('--font-size-base')).toBe('18.4px');
  });

  it('applies compact density spacing overrides on document.documentElement', () => {
    const { mockDocument, rootStyle } = createMockDocument();

    applyVisualCustomizationOverrides(createSettings({ uiDensity: 'compact' }), 'light', mockDocument);

    expect(rootStyle.getPropertyValue('--space-2')).toBe('6px');
    expect(rootStyle.getPropertyValue('--space-3')).toBe('9px');
    expect(rootStyle.getPropertyValue('--space-4')).toBe('12px');
    expect(rootStyle.getPropertyValue('--space-5')).toBe('15px');
    expect(rootStyle.getPropertyValue('--space-6')).toBe('18px');
  });

  it('applies wide conversation width override', () => {
    const { mockDocument, rootStyle } = createMockDocument();

    applyVisualCustomizationOverrides(createSettings({ conversationWidth: 'wide' }), 'light', mockDocument);

    expect(rootStyle.getPropertyValue('--conversation-content-max-width')).toBe('1400px');
  });

  it('removes overrides when settings revert to defaults', () => {
    const { mockDocument, bodyStyle, rootStyle } = createMockDocument();

    applyVisualCustomizationOverrides(
      createSettings({
        accentColor: 'blue',
        fontScale: 'large',
        uiDensity: 'compact',
        conversationWidth: 'wide',
      }),
      'light',
      mockDocument,
    );

    applyVisualCustomizationOverrides(
      createSettings({
        accentColor: 'purple',
        fontScale: 'default',
        uiDensity: 'comfortable',
        conversationWidth: 'medium',
      }),
      'light',
      mockDocument,
    );

    for (const key of Object.keys(ACCENT_PALETTE.blue.light)) {
      expect(bodyStyle.getPropertyValue(key)).toBe('');
    }
    expect(rootStyle.getPropertyValue('--font-size-base')).toBe('');
    expect(rootStyle.getPropertyValue('--space-2')).toBe('');
    expect(rootStyle.getPropertyValue('--space-3')).toBe('');
    expect(rootStyle.getPropertyValue('--space-4')).toBe('');
    expect(rootStyle.getPropertyValue('--space-5')).toBe('');
    expect(rootStyle.getPropertyValue('--space-6')).toBe('');
    expect(rootStyle.getPropertyValue('--conversation-content-max-width')).toBe('');
  });

  // Efficiency Mode reduce-motion (260524_performance_mode):
  // toggling efficiencyMode flips the data-reduce-motion attribute on
  // <html> so the foundations CSS rule activates.
  it('sets data-reduce-motion="true" on documentElement when efficiencyMode is on', () => {
    const { mockDocument, rootAttributes } = createMockDocument();

    applyVisualCustomizationOverrides(createSettings({ efficiencyMode: 'on' }), 'light', mockDocument);

    expect(rootAttributes.get('data-reduce-motion')).toBe('true');
  });

  it('removes data-reduce-motion when efficiencyMode is off or undefined', () => {
    const { mockDocument, rootAttributes } = createMockDocument();

    applyVisualCustomizationOverrides(createSettings({ efficiencyMode: 'on' }), 'light', mockDocument);
    expect(rootAttributes.get('data-reduce-motion')).toBe('true');

    applyVisualCustomizationOverrides(createSettings({ efficiencyMode: 'off' }), 'light', mockDocument);
    expect(rootAttributes.has('data-reduce-motion')).toBe(false);

    applyVisualCustomizationOverrides(createSettings({}), 'light', mockDocument);
    expect(rootAttributes.has('data-reduce-motion')).toBe(false);
  });

  it('cleanup removes the data-reduce-motion attribute', () => {
    const { mockDocument, rootAttributes } = createMockDocument();

    const cleanup = applyVisualCustomizationOverrides(
      createSettings({ efficiencyMode: 'on' }),
      'light',
      mockDocument,
    );
    expect(rootAttributes.get('data-reduce-motion')).toBe('true');

    cleanup();

    expect(rootAttributes.has('data-reduce-motion')).toBe(false);
  });

  it('cleans up all overrides on unmount cleanup', () => {
    const { mockDocument, bodyStyle, rootStyle } = createMockDocument();

    const cleanup = applyVisualCustomizationOverrides(
      createSettings({
        accentColor: 'blue',
        fontScale: 'small',
        uiDensity: 'spacious',
        conversationWidth: 'narrow',
      }),
      'dark',
      mockDocument,
    );

    cleanup();

    for (const key of Object.keys(ACCENT_PALETTE.blue.dark)) {
      expect(bodyStyle.getPropertyValue(key)).toBe('');
    }
    expect(rootStyle.getPropertyValue('--font-size-base')).toBe('');
    expect(rootStyle.getPropertyValue('--space-2')).toBe('');
    expect(rootStyle.getPropertyValue('--space-3')).toBe('');
    expect(rootStyle.getPropertyValue('--space-4')).toBe('');
    expect(rootStyle.getPropertyValue('--space-5')).toBe('');
    expect(rootStyle.getPropertyValue('--space-6')).toBe('');
    expect(rootStyle.getPropertyValue('--conversation-content-max-width')).toBe('');
  });
});
