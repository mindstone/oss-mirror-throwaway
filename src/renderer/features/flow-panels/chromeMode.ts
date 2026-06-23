/**
 * Reduced Chrome Mode
 *
 * Generic abstraction for dimming and disabling shell chrome (sidebar, nav tabs,
 * header controls, session toolbar) to create a focused experience.
 *
 * Designed for reuse by: presentation mode, deep focus mode, etc.
 *
 * The mode is expressed as a data attribute on the app-shell root element:
 *   data-chrome-mode="reduced"  →  shell chrome dimmed + inert
 *   (no attribute)              →  normal chrome
 *
 * CSS rules in app-shell.css and AgentSessionPane.module.css target this attribute.
 * Components apply `inert` via the helper below to block keyboard/click/assistive tech.
 *
 * Feature-specific visuals (e.g., onboarding frosted glass, conversation veil) stay
 * on feature-specific attributes — this module only owns the chrome dimming/disabling.
 */

export type ChromeMode = 'normal' | 'reduced';
export type ChromeModeOwner = 'library' | 'kiosk' | string;

export function resolveChromeMode(owners: ReadonlySet<ChromeModeOwner>): ChromeMode {
  return owners.size > 0 ? 'reduced' : 'normal';
}

export function acquireChromeModeOwner(
  owners: ReadonlySet<ChromeModeOwner>,
  owner: ChromeModeOwner,
  mode: ChromeMode = 'reduced',
): ReadonlySet<ChromeModeOwner> {
  if (mode !== 'reduced' || owners.has(owner)) {
    return owners;
  }
  const next = new Set(owners);
  next.add(owner);
  return next;
}

export function releaseChromeModeOwner(
  owners: ReadonlySet<ChromeModeOwner>,
  owner: ChromeModeOwner,
): ReadonlySet<ChromeModeOwner> {
  if (!owners.has(owner)) {
    return owners;
  }
  const next = new Set(owners);
  next.delete(owner);
  return next;
}

export function toggleChromeModeOwner(
  owners: ReadonlySet<ChromeModeOwner>,
  owner: ChromeModeOwner,
): ReadonlySet<ChromeModeOwner> {
  if (owners.has(owner)) {
    return releaseChromeModeOwner(owners, owner);
  }
  return acquireChromeModeOwner(owners, owner, 'reduced');
}

export function hasChromeModeOwner(
  owners: ReadonlySet<ChromeModeOwner>,
  owner: ChromeModeOwner,
): boolean {
  return owners.has(owner);
}

export function chromeInert(mode: ChromeMode): true | undefined {
  return mode === 'reduced' ? true : undefined;
}
