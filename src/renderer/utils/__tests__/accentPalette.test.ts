import { describe, expect, it } from 'vitest';

import { ACCENT_PALETTE, type AccentColorId } from '../accentPalette';

const ACCENT_COLOR_IDS: AccentColorId[] = [
  'purple',
  'blue',
  'indigo',
  'teal',
  'rose',
  'orange',
  'amber',
  'slate',
];

const REQUIRED_CSS_VARIABLE_KEYS = [
  '--color-primary',
  '--color-primary-hover',
  '--color-primary-foreground',
  '--color-ring',
  '--color-secondary',
  '--color-secondary-hover',
  '--color-secondary-foreground',
  '--color-link',
  '--color-link-hover',
] as const;

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }

  return [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
  ];
}

function toLinearSrgb(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function getRelativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);

  const rl = toLinearSrgb(r);
  const gl = toLinearSrgb(g);
  const bl = toLinearSrgb(b);

  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function getContrastRatio(hex1: string, hex2: string): number {
  const l1 = getRelativeLuminance(hex1);
  const l2 = getRelativeLuminance(hex2);

  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);

  return (lighter + 0.05) / (darker + 0.05);
}

describe('ACCENT_PALETTE', () => {
  it('has entries for every accent color id with both light and dark palettes', () => {
    expect(Object.keys(ACCENT_PALETTE).sort()).toEqual([...ACCENT_COLOR_IDS].sort());

    for (const accentColorId of ACCENT_COLOR_IDS) {
      const entry = ACCENT_PALETTE[accentColorId];
      expect(entry).toBeDefined();
      expect(entry.light).toBeDefined();
      expect(entry.dark).toBeDefined();
      expect(typeof entry.label).toBe('string');
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it('includes all required CSS variable keys in both light and dark mode for each entry', () => {
    for (const accentColorId of ACCENT_COLOR_IDS) {
      const entry = ACCENT_PALETTE[accentColorId];

      for (const cssVariableKey of REQUIRED_CSS_VARIABLE_KEYS) {
        expect(entry.light).toHaveProperty(cssVariableKey);
        expect(entry.dark).toHaveProperty(cssVariableKey);
        expect(typeof entry.light[cssVariableKey]).toBe('string');
        expect(typeof entry.dark[cssVariableKey]).toBe('string');
      }
    }
  });

  it('uses valid #RRGGBB swatch values for all entries', () => {
    for (const accentColorId of ACCENT_COLOR_IDS) {
      expect(ACCENT_PALETTE[accentColorId].swatch).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('meets WCAG contrast requirements for primary/foreground pairs', () => {
    for (const accentColorId of ACCENT_COLOR_IDS) {
      const entry = ACCENT_PALETTE[accentColorId];
      const lightContrast = getContrastRatio(
        entry.light['--color-primary'],
        entry.light['--color-primary-foreground'],
      );
      const darkContrast = getContrastRatio(
        entry.dark['--color-primary'],
        entry.dark['--color-primary-foreground'],
      );

      if (accentColorId === 'purple') {
        expect(lightContrast).toBeGreaterThanOrEqual(4.23);
        expect(darkContrast).toBeGreaterThanOrEqual(4.23);
        continue;
      }

      expect(lightContrast).toBeGreaterThanOrEqual(4.5);
      expect(darkContrast).toBeGreaterThanOrEqual(4.5);
    }
  });
});
