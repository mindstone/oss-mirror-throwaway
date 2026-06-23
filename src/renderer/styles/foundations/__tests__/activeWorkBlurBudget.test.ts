/**
 * @vitest-environment happy-dom
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const TOKENS_CSS = fs.readFileSync(
  path.resolve(__dirname, '..', 'tokens.css'),
  'utf8',
);

const DIALOG_MODULE_CSS = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '..', 'components', 'ui', 'Dialog.module.css'),
  'utf8',
);

const CARD_MODULE_CSS = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '..', 'components', 'ui', 'Card.module.css'),
  'utf8',
);

const PANEL_BLUR_PROBE_RULES = `
.panel-blur-probe {
  backdrop-filter: blur(var(--glass-panel-blur));
}
`;

let styleEl: HTMLStyleElement | null = null;

function makePortalChild(className: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  document.body.appendChild(node);
  return node;
}

function loadStyles(extra = ''): void {
  styleEl = document.createElement('style');
  styleEl.textContent = `${TOKENS_CSS}\n${extra}\n${PANEL_BLUR_PROBE_RULES}`;
  document.head.appendChild(styleEl);
}

beforeEach(() => {
  document.body.removeAttribute('data-active-work');
  document.body.classList.remove('light', 'dark');
});

afterEach(() => {
  styleEl?.remove();
  styleEl = null;
  document.body.removeAttribute('data-active-work');
  document.body.classList.remove('light', 'dark');
  for (const child of Array.from(document.body.children)) {
    child.remove();
  }
});

describe('Stage 3 — active-work blur budget (real .module.css cascade, F7)', () => {
  it('idle: a portal-mounted node carrying the real Dialog.module.css `.overlay` class resolves --glass-overlay-blur to its default token', () => {
    loadStyles(DIALOG_MODULE_CSS);
    const overlay = makePortalChild('overlay');
    const computed = window.getComputedStyle(overlay).getPropertyValue('backdrop-filter');
    expect(computed).toBe('blur(12px)');
  });

  it('busy: setting body[data-active-work=true] collapses the real Dialog.module.css backdrop-filter cascade for a portal descendant to 0px', () => {
    loadStyles(DIALOG_MODULE_CSS);
    const overlay = makePortalChild('overlay');
    document.body.setAttribute('data-active-work', 'true');
    const computed = window.getComputedStyle(overlay).getPropertyValue('backdrop-filter');
    expect(computed).toBe('blur(0px)');
  });

  it('round-trip via real Dialog.module.css: active → idle restores the idle blur radius for portal descendants', () => {
    loadStyles(DIALOG_MODULE_CSS);
    const overlay = makePortalChild('overlay');
    document.body.setAttribute('data-active-work', 'true');
    expect(window.getComputedStyle(overlay).getPropertyValue('backdrop-filter')).toBe('blur(0px)');

    document.body.removeAttribute('data-active-work');
    expect(window.getComputedStyle(overlay).getPropertyValue('backdrop-filter')).toBe('blur(12px)');
  });

  it('mid-stream Dialog mount: a portal child attached AFTER the busy attribute is already set inherits the 0px budget on first paint', () => {
    loadStyles(DIALOG_MODULE_CSS);
    document.body.setAttribute('data-active-work', 'true');
    const overlay = makePortalChild('overlay');
    const computed = window.getComputedStyle(overlay).getPropertyValue('backdrop-filter');
    expect(computed).toBe('blur(0px)');
  });

  it('NoSurface portal mount via real Card.module.css cascade: data-active-work cascades through FloatingPortal-style document.body mounting (panel-blur)', () => {
    loadStyles(CARD_MODULE_CSS);
    const card = makePortalChild('card--glass');

    const idle = window.getComputedStyle(card).getPropertyValue('backdrop-filter');
    expect(idle).toBe('blur(24px)');

    document.body.setAttribute('data-active-work', 'true');
    const busy = window.getComputedStyle(card).getPropertyValue('backdrop-filter');
    expect(busy).toBe('blur(0px)');
  });
});

describe('Stage 3 — active-work blur budget (light/dark theme coverage)', () => {
  it('light idle: --glass-panel-blur resolves to 24px, --glass-overlay-blur resolves to 12px', () => {
    loadStyles(DIALOG_MODULE_CSS);
    document.body.classList.add('light');
    const dialogOverlay = makePortalChild('overlay');
    const panelProbe = makePortalChild('panel-blur-probe');
    expect(window.getComputedStyle(dialogOverlay).getPropertyValue('backdrop-filter')).toBe('blur(12px)');
    expect(window.getComputedStyle(panelProbe).getPropertyValue('backdrop-filter')).toBe('blur(24px)');
  });

  it('light busy: body.light[data-active-work=true] collapses BOTH --glass-panel-blur AND --glass-overlay-blur to 0px', () => {
    loadStyles(DIALOG_MODULE_CSS);
    document.body.classList.add('light');
    document.body.setAttribute('data-active-work', 'true');
    const dialogOverlay = makePortalChild('overlay');
    const panelProbe = makePortalChild('panel-blur-probe');
    expect(window.getComputedStyle(dialogOverlay).getPropertyValue('backdrop-filter')).toBe('blur(0px)');
    expect(window.getComputedStyle(panelProbe).getPropertyValue('backdrop-filter')).toBe('blur(0px)');
  });

  it('dark idle: --glass-panel-blur resolves to 14px, --glass-overlay-blur resolves to 12px', () => {
    loadStyles(DIALOG_MODULE_CSS);
    document.body.classList.add('dark');
    const dialogOverlay = makePortalChild('overlay');
    const panelProbe = makePortalChild('panel-blur-probe');
    expect(window.getComputedStyle(dialogOverlay).getPropertyValue('backdrop-filter')).toBe('blur(12px)');
    expect(window.getComputedStyle(panelProbe).getPropertyValue('backdrop-filter')).toBe('blur(14px)');
  });

  it('dark busy: body.dark[data-active-work=true] collapses BOTH --glass-panel-blur AND --glass-overlay-blur to 0px', () => {
    loadStyles(DIALOG_MODULE_CSS);
    document.body.classList.add('dark');
    document.body.setAttribute('data-active-work', 'true');
    const dialogOverlay = makePortalChild('overlay');
    const panelProbe = makePortalChild('panel-blur-probe');
    expect(window.getComputedStyle(dialogOverlay).getPropertyValue('backdrop-filter')).toBe('blur(0px)');
    expect(window.getComputedStyle(panelProbe).getPropertyValue('backdrop-filter')).toBe('blur(0px)');
  });

  it('light round-trip: active → idle restores the LIGHT idle values (24px panel, 12px overlay)', () => {
    loadStyles(DIALOG_MODULE_CSS);
    document.body.classList.add('light');
    document.body.setAttribute('data-active-work', 'true');
    const dialogOverlay = makePortalChild('overlay');
    const panelProbe = makePortalChild('panel-blur-probe');
    expect(window.getComputedStyle(dialogOverlay).getPropertyValue('backdrop-filter')).toBe('blur(0px)');
    expect(window.getComputedStyle(panelProbe).getPropertyValue('backdrop-filter')).toBe('blur(0px)');

    document.body.removeAttribute('data-active-work');
    expect(window.getComputedStyle(dialogOverlay).getPropertyValue('backdrop-filter')).toBe('blur(12px)');
    expect(window.getComputedStyle(panelProbe).getPropertyValue('backdrop-filter')).toBe('blur(24px)');
  });

  it('dark round-trip: active → idle restores the DARK idle values (14px panel, 12px overlay)', () => {
    loadStyles(DIALOG_MODULE_CSS);
    document.body.classList.add('dark');
    document.body.setAttribute('data-active-work', 'true');
    const dialogOverlay = makePortalChild('overlay');
    const panelProbe = makePortalChild('panel-blur-probe');
    expect(window.getComputedStyle(dialogOverlay).getPropertyValue('backdrop-filter')).toBe('blur(0px)');
    expect(window.getComputedStyle(panelProbe).getPropertyValue('backdrop-filter')).toBe('blur(0px)');

    document.body.removeAttribute('data-active-work');
    expect(window.getComputedStyle(dialogOverlay).getPropertyValue('backdrop-filter')).toBe('blur(12px)');
    expect(window.getComputedStyle(panelProbe).getPropertyValue('backdrop-filter')).toBe('blur(14px)');
  });
});
