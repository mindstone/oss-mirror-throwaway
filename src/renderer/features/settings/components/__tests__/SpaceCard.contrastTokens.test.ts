/**
 * Stage 8 (260619_cloud-symlink-indexing) — contrast-token REGRESSION GUARD for the
 * SpaceCard cloud sync-status badge + banner.
 *
 * Why a static source-assertion (not a screenshot): the bug it prevents is invisible
 * in the default (dark) test environment and only manifests in light mode, so a
 * jsdom render can't catch it. The original defect bound the TEXT color to the
 * on-SOLID `*-foreground` tokens (= `#ffffff` in BOTH themes) on a card-colored
 * surface (`*-surface` ≈ `--color-card`, which is `#ffffff` in light mode) ⇒
 * white-on-white / WCAG fail. The canonical `Notice` component proves the correct
 * pairing: TEXT uses `--color-text-*` (on-surface), the accent stays on the icon
 * (`--color-*-icon`). This test fails if a future edit reintroduces an on-solid
 * `*-foreground` token as the TEXT color on these surfaces.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.resolve(here, '../SpaceCard.module.css');
const css = readFileSync(cssPath, 'utf8');

/** A parsed flat CSS rule: its comma-split selectors + the declaration body. */
type Rule = { selectors: string[]; body: string };

/**
 * Parse all top-level `selector(s) { body }` rules. These module rules are flat
 * (no nesting), so a simple brace scan is exact. Comments are stripped first so a
 * `{`/`}` inside a comment can't desync the scan.
 */
function parseRules(source: string): Rule[] {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const selectors = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    rules.push({ selectors, body: m[2] });
  }
  return rules;
}

const RULES = parseRules(css);

/** The `color:` declaration value in a rule body (or null if none). */
function colorOf(body: string): string | null {
  const m = body.match(/(?:^|[;{\s])color\s*:\s*([^;]+);/);
  return m ? m[1].trim() : null;
}

/**
 * The TEXT color a given single selector resolves to: the LAST rule (CSS cascade)
 * whose selector list includes `selector` AND declares a `color`. Returns null if no
 * matching rule declares one.
 */
function textColorFor(selector: string): string | null {
  let value: string | null = null;
  for (const rule of RULES) {
    if (rule.selectors.includes(selector)) {
      const c = colorOf(rule.body);
      if (c !== null) value = c;
    }
  }
  return value;
}

describe('SpaceCard sync-status — contrast token regression guard', () => {
  // The text-bearing rules: badge + the two banner tones. (The badge :hover and the
  // `svg` accent rules are checked separately below.)
  it.each([
    '.badgeInfo',
    '.syncBannerInfo',
    '.syncBannerWarning',
  ])('%s TEXT color uses an on-surface --color-text-* token (not *-foreground)', (selector) => {
    const value = textColorFor(selector);
    expect(value, `${selector} must declare a text color`).not.toBeNull();
    // Must be an on-SURFACE text token…
    expect(value).toMatch(/var\(--color-text-(primary|secondary)\)/);
    // …and must NOT be an on-SOLID *-foreground token (the invisible-in-light bug).
    expect(value).not.toMatch(/--color-(info|warning|success|destructive)-foreground/);
  });

  it('.badgeInfo:hover TEXT color also stays on an on-surface text token', () => {
    const value = textColorFor('.badgeInfo:hover');
    expect(value).toMatch(/var\(--color-text-(primary|secondary)\)/);
    expect(value).not.toMatch(/-foreground/);
  });

  it('keeps the accent on the ICON (not the text) — mirrors the canonical Notice', () => {
    // The SVG accent rules carry the tone color (--color-*-icon), not the text.
    expect(textColorFor('.syncBannerInfo svg')).toBe('var(--color-info-icon)');
    expect(textColorFor('.syncBannerWarning svg')).toBe('var(--color-warning-icon)');
    expect(textColorFor('.badgeInfo svg')).toBe('var(--color-info-icon)');
  });

  it('no sync-status text rule paints a raw white/#fff (would be invisible in light mode)', () => {
    for (const selector of ['.badgeInfo', '.badgeInfo:hover', '.syncBannerInfo', '.syncBannerWarning']) {
      const value = (textColorFor(selector) ?? '').toLowerCase();
      expect(value).not.toMatch(/#fff(?:fff)?\b|\bwhite\b/);
    }
  });
});
