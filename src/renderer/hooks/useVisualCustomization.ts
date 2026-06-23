import { useEffect } from 'react';

import type { AppSettings } from '@shared/types/settings';

import { ACCENT_PALETTE } from '../utils/accentPalette';

const ACCENT_CSS_VARIABLE_KEYS = Object.keys(ACCENT_PALETTE.purple.light);
const SPACING_CSS_VARIABLE_KEYS = ['--space-2', '--space-3', '--space-4', '--space-5', '--space-6'] as const;

const removeAccentOverrides = (bodyStyle: CSSStyleDeclaration): void => {
  for (const key of ACCENT_CSS_VARIABLE_KEYS) {
    bodyStyle.removeProperty(key);
  }
};

const removeSpacingOverrides = (rootStyle: CSSStyleDeclaration): void => {
  for (const key of SPACING_CSS_VARIABLE_KEYS) {
    rootStyle.removeProperty(key);
  }
};

const removeAllOverrides = (
  bodyStyle: CSSStyleDeclaration,
  rootStyle: CSSStyleDeclaration,
): void => {
  removeAccentOverrides(bodyStyle);
  rootStyle.removeProperty('--font-size-base');
  removeSpacingOverrides(rootStyle);
  rootStyle.removeProperty('--conversation-content-max-width');
};

export function applyVisualCustomizationOverrides(
  settings: AppSettings | null,
  resolvedTheme: 'light' | 'dark',
  targetDocument?: Document,
): () => void {
  const currentDocument = targetDocument ?? (typeof document !== 'undefined' ? document : null);

  if (!currentDocument?.body?.style || !currentDocument.documentElement?.style) {
    return () => {};
  }

  const bodyStyle = currentDocument.body.style;
  const rootStyle = currentDocument.documentElement.style;

  if (settings?.accentColor && settings.accentColor !== 'purple') {
    const accentOverrides = ACCENT_PALETTE[settings.accentColor][resolvedTheme];
    for (const [key, value] of Object.entries(accentOverrides)) {
      bodyStyle.setProperty(key, value);
    }
  } else {
    removeAccentOverrides(bodyStyle);
  }

  if (settings?.fontScale === 'small') {
    rootStyle.setProperty('--font-size-base', '13.6px');
  } else if (settings?.fontScale === 'large') {
    rootStyle.setProperty('--font-size-base', '18.4px');
  } else {
    rootStyle.removeProperty('--font-size-base');
  }

  if (settings?.uiDensity === 'compact') {
    rootStyle.setProperty('--space-2', '6px');
    rootStyle.setProperty('--space-3', '9px');
    rootStyle.setProperty('--space-4', '12px');
    rootStyle.setProperty('--space-5', '15px');
    rootStyle.setProperty('--space-6', '18px');
  } else if (settings?.uiDensity === 'spacious') {
    rootStyle.setProperty('--space-2', '10px');
    rootStyle.setProperty('--space-3', '15px');
    rootStyle.setProperty('--space-4', '20px');
    rootStyle.setProperty('--space-5', '25px');
    rootStyle.setProperty('--space-6', '30px');
  } else {
    removeSpacingOverrides(rootStyle);
  }

  if (settings?.conversationWidth === 'narrow') {
    rootStyle.setProperty('--conversation-content-max-width', '720px');
  } else if (settings?.conversationWidth === 'wide') {
    rootStyle.setProperty('--conversation-content-max-width', '1400px');
  } else {
    rootStyle.removeProperty('--conversation-content-max-width');
  }

  // Efficiency Mode reduce-motion (260524_performance_mode):
  // toggle a root attribute that the foundations CSS layer uses to suppress
  // decorative animations/transitions globally. Mirrors the OS-level
  // `prefers-reduced-motion: reduce` rule already covered by many components.
  const rootElement = currentDocument.documentElement;
  if (settings?.efficiencyMode === 'on') {
    rootElement.setAttribute('data-reduce-motion', 'true');
  } else {
    rootElement.removeAttribute('data-reduce-motion');
  }

  return () => {
    removeAllOverrides(bodyStyle, rootStyle);
    rootElement.removeAttribute('data-reduce-motion');
  };
}

export function useVisualCustomization(
  settings: AppSettings | null,
  resolvedTheme: 'light' | 'dark',
): void {
  useEffect(
    () => applyVisualCustomizationOverrides(settings, resolvedTheme),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps intentionally narrowed to specific visual properties to avoid re-applying overrides on unrelated settings changes
    [
      settings?.accentColor,
      settings?.fontScale,
      settings?.uiDensity,
      settings?.conversationWidth,
      settings?.efficiencyMode,
      resolvedTheme,
    ],
  );
}
